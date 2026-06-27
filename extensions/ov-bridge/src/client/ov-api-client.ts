import {
  parseCreateTaskResponse,
  parseContractError,
  type CreateTaskRequest,
} from "@ouomoxo/ov-agent-contracts";
import { safeErrorMessage } from "../security/redaction.js";
import type { OvBridgeConfig, OvBridgeErrorCode } from "../types.js";
import { mapErrorResponse } from "./http-errors.js";
import { isRetryableHttpStatus, isRetryableNetworkKind, nextBackoffMs } from "./retry-policy.js";

export interface OvApiClientDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  rng?: () => number;
}

export interface CreateTaskCallContext {
  correlationId: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}

export type CreateTaskClientResult =
  | {
      ok: true;
      taskId: string;
      status: "RECEIVED";
      deduplicated: boolean;
      correlationId: string;
      httpStatus: number;
    }
  | {
      ok: false;
      code: OvBridgeErrorCode;
      retryable: boolean;
      correlationId?: string;
      message: string;
    };

export interface OvApiClient {
  createTask(
    request: CreateTaskRequest,
    ctx: CreateTaskCallContext,
  ): Promise<CreateTaskClientResult>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function fail(
  code: OvBridgeErrorCode,
  retryable: boolean,
  message: string,
  correlationId?: string,
): CreateTaskClientResult {
  return correlationId
    ? { ok: false, code, retryable, correlationId, message }
    : { ok: false, code, retryable, message };
}

export function createOvApiClient(config: OvBridgeConfig, deps: OvApiClientDeps = {}): OvApiClient {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const rng = deps.rng ?? Math.random;
  const endpoint = joinUrl(config.apiBaseUrl, "tasks");
  const totalAttempts = 1 + config.maxRetries;

  async function attemptOnce(
    request: CreateTaskRequest,
    ctx: CreateTaskCallContext,
  ): Promise<{ outcome: CreateTaskClientResult; retry: boolean }> {
    const controller = new AbortController();
    const externalAbort = () => controller.abort(new DOMException("Cancelled", "AbortError"));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Timeout", "TimeoutError"));
    }, config.requestTimeoutMs);
    if (ctx.signal) {
      if (ctx.signal.aborted) {
        clearTimeout(timer);
        return {
          outcome: fail("TIMEOUT", false, "Request cancelled before send.", ctx.correlationId),
          retry: false,
        };
      }
      ctx.signal.addEventListener("abort", externalAbort, { once: true });
    }

    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.serviceToken}`,
          "Content-Type": "application/json",
          "X-Contract-Version": config.contractVersion,
          "X-Correlation-ID": ctx.correlationId,
          "Idempotency-Key": ctx.idempotencyKey,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      const status = response.status;
      const bodyText = await response.text().catch(() => "");

      if (status === 200 || status === 201) {
        return { outcome: handleSuccess(status, bodyText, ctx), retry: false };
      }

      const contractError = parseBody(bodyText, (data) => {
        const parsed = parseContractError(data);
        return parsed.success ? parsed.data : undefined;
      });
      const mapped = mapErrorResponse(status, contractError);
      const canRetry = isRetryableHttpStatus(status);
      return {
        outcome: fail(mapped.code, mapped.retryable, mapped.message, ctx.correlationId),
        retry: canRetry,
      };
    } catch (error) {
      if (ctx.signal?.aborted && !timedOut) {
        return {
          outcome: fail("TIMEOUT", false, "Request cancelled.", ctx.correlationId),
          retry: false,
        };
      }
      if (timedOut) {
        return {
          outcome: fail("TIMEOUT", true, "OV request timed out.", ctx.correlationId),
          retry: true,
        };
      }
      return {
        outcome: fail("OV_UNAVAILABLE", true, safeErrorMessage(error), ctx.correlationId),
        retry: isRetryableNetworkKind("network"),
      };
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", externalAbort);
    }
  }

  function handleSuccess(
    status: number,
    bodyText: string,
    ctx: CreateTaskCallContext,
  ): CreateTaskClientResult {
    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch {
      return fail(
        "INVALID_RESPONSE",
        false,
        "OV returned a non-JSON success body.",
        ctx.correlationId,
      );
    }
    const parsed = parseCreateTaskResponse(json);
    if (!parsed.success) {
      return fail(
        "INVALID_RESPONSE",
        false,
        "OV success response failed contract validation.",
        ctx.correlationId,
      );
    }
    const body = parsed.data;
    if (body.correlationId !== ctx.correlationId) {
      return fail(
        "INVALID_RESPONSE",
        false,
        "OV response correlationId did not match the request.",
        ctx.correlationId,
      );
    }
    // Strict: 201 => freshly created (deduplicated false); 200 => idempotent duplicate (deduplicated true).
    const expectedDedup = status === 200;
    if (body.deduplicated !== expectedDedup) {
      return fail(
        "INVALID_RESPONSE",
        false,
        `OV HTTP ${status} disagreed with deduplicated=${body.deduplicated}.`,
        ctx.correlationId,
      );
    }
    return {
      ok: true,
      taskId: body.taskId,
      status: "RECEIVED",
      deduplicated: body.deduplicated,
      correlationId: body.correlationId,
      httpStatus: status,
    };
  }

  return {
    async createTask(request, ctx) {
      let last: CreateTaskClientResult = fail(
        "INTERNAL_ERROR",
        false,
        "No attempt was made.",
        ctx.correlationId,
      );
      for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
        if (ctx.signal?.aborted) {
          return fail("TIMEOUT", false, "Request cancelled.", ctx.correlationId);
        }
        const { outcome, retry } = await attemptOnce(request, ctx);
        if (outcome.ok) {
          return outcome;
        }
        last = outcome;
        const hasMore = attempt < totalAttempts;
        if (!retry || !hasMore) {
          return outcome;
        }
        try {
          await sleep(nextBackoffMs(attempt + 1, rng), ctx.signal);
        } catch {
          return fail("TIMEOUT", false, "Request cancelled during backoff.", ctx.correlationId);
        }
      }
      return last;
    },
  };
}

function parseBody<T>(text: string, fn: (data: unknown) => T | undefined): T | undefined {
  if (!text) {
    return undefined;
  }
  try {
    return fn(JSON.parse(text));
  } catch {
    return undefined;
  }
}
