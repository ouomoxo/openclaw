/**
 * Contract-compliant Mock OV server for tests. NOT a production artifact — only imported by tests.
 * Validates auth, headers, header/body consistency, and the CreateTask contract; implements
 * idempotency via the canonical request fingerprint; emits structured ContractErrors.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildContractError,
  fingerprintCreateTaskRequest,
  parseCreateTaskRequest,
  type ContractErrorCode,
} from "@ouomoxo/ov-agent-contracts";

export type MockScenario =
  | "ok"
  | "unauthorized"
  | "forbidden"
  | "project-not-found"
  | "rate-limited"
  | "internal-error"
  | "unavailable"
  | "version-unsupported"
  | "delay"
  | "malformed-json"
  | "invalid-contract-response"
  | "correlation-mismatch"
  | "connection-close";

export interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  authPresent: boolean;
  contractVersionHeader: string | undefined;
  correlationHeader: string | undefined;
  idempotencyHeader: string | undefined;
  bodyValid: boolean;
}

export interface MockOvServerOptions {
  expectedToken?: string;
  contractVersion?: string;
  scenario?: MockScenario;
  delayMs?: number;
  now?: () => Date;
}

export interface MockOvServerHandle {
  url: string;
  port: number;
  requests: RecordedRequest[];
  taskIds: string[];
  /** Set the default scenario applied when the queue is empty. */
  setScenario(scenario: MockScenario): void;
  /** Queue one-shot scenarios consumed per request (then falls back to the default). */
  queueScenarios(...scenarios: MockScenario[]): void;
  reset(): void;
  close(): Promise<void>;
}

const ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  forbidden: 403,
  "project-not-found": 404,
  "rate-limited": 429,
  "internal-error": 500,
  unavailable: 503,
  "version-unsupported": 422,
};

const ERROR_CODE: Record<string, ContractErrorCode> = {
  unauthorized: "UNAUTHORIZED",
  forbidden: "FORBIDDEN",
  "project-not-found": "PROJECT_NOT_FOUND",
  "rate-limited": "RATE_LIMITED",
  "internal-error": "INTERNAL_ERROR",
  unavailable: "INTERNAL_ERROR",
  "version-unsupported": "VERSION_UNSUPPORTED",
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startMockOvServer(
  options: MockOvServerOptions = {},
): Promise<MockOvServerHandle> {
  const expectedToken = options.expectedToken ?? "test-token";
  const contractVersion = options.contractVersion ?? "1.0";
  const now = options.now ?? (() => new Date());
  let defaultScenario: MockScenario = options.scenario ?? "ok";
  const scenarioQueue: MockScenario[] = [];

  const requests: RecordedRequest[] = [];
  const taskIds: string[] = [];
  // idempotencyKey -> { fingerprint, taskId }
  const store = new Map<string, { fingerprint: string; taskId: string }>();
  let taskCounter = 0;

  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(text);
  };
  const sendError = (
    res: ServerResponse,
    scenario: keyof typeof ERROR_STATUS,
    correlationId: string,
  ): void => {
    const status = ERROR_STATUS[scenario] ?? 500;
    sendJson(
      res,
      status,
      buildContractError(
        ERROR_CODE[scenario] ?? "INTERNAL_ERROR",
        correlationId,
        `mock: ${scenario}`,
      ),
    );
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const scenario = scenarioQueue.shift() ?? defaultScenario;
    const auth = req.headers["authorization"];
    const versionHeader = header(req, "x-contract-version");
    const correlationHeader = header(req, "x-correlation-id");
    const idempotencyHeader = header(req, "idempotency-key");
    const bodyText = await readBody(req);

    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = undefined;
    }
    const parsed =
      body !== undefined ? parseCreateTaskRequest(body) : { success: false as const, issues: [] };
    const bodyValid = parsed.success;

    requests.push({
      method: req.method,
      url: req.url,
      authPresent: typeof auth === "string" && auth.length > 0,
      contractVersionHeader: versionHeader,
      correlationHeader,
      idempotencyHeader,
      bodyValid,
    });

    const correlationId =
      correlationHeader ?? (parsed.success ? parsed.data.metadata.correlationId : "");

    // Transport-level scenarios.
    if (scenario === "connection-close") {
      req.socket.destroy();
      return;
    }
    if (scenario === "delay") {
      await sleep(options.delayMs ?? 1_000);
      // fall through to normal handling after the delay
    } else if (scenario !== "ok") {
      if (scenario === "malformed-json") {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end("{ this is not valid json ");
        return;
      }
      if (scenario === "invalid-contract-response") {
        sendJson(res, 201, {
          contractVersion: "1.0",
          correlationId,
          taskId: "task_x",
          status: "QUEUED",
          createdAt: now().toISOString(),
          deduplicated: false,
        });
        return;
      }
      if (scenario === "correlation-mismatch") {
        sendJson(res, 201, {
          contractVersion: "1.0",
          correlationId: "corr_mismatch",
          taskId: nextTaskId(),
          status: "RECEIVED",
          createdAt: now().toISOString(),
          deduplicated: false,
        });
        return;
      }
      sendError(res, scenario, correlationId);
      return;
    }

    // Normal (ok) path — full contract enforcement.
    if (auth !== `Bearer ${expectedToken}`) {
      sendError(res, "unauthorized", correlationId);
      return;
    }
    if (versionHeader !== contractVersion) {
      sendJson(
        res,
        422,
        buildContractError(
          "VERSION_UNSUPPORTED",
          correlationId,
          "mock: unsupported X-Contract-Version",
        ),
      );
      return;
    }
    if (!parsed.success) {
      sendJson(
        res,
        400,
        buildContractError("INVALID_REQUEST", correlationId, "mock: invalid CreateTaskRequest"),
      );
      return;
    }
    const request = parsed.data;
    if (correlationHeader !== request.metadata.correlationId) {
      sendJson(
        res,
        400,
        buildContractError(
          "INVALID_REQUEST",
          correlationId,
          "mock: correlation header/body mismatch",
        ),
      );
      return;
    }
    if (idempotencyHeader !== request.metadata.idempotencyKey) {
      sendJson(
        res,
        400,
        buildContractError(
          "INVALID_REQUEST",
          correlationId,
          "mock: idempotency header/body mismatch",
        ),
      );
      return;
    }
    if (versionHeader !== request.contractVersion) {
      sendJson(
        res,
        400,
        buildContractError("INVALID_REQUEST", correlationId, "mock: version header/body mismatch"),
      );
      return;
    }

    const fingerprint = fingerprintCreateTaskRequest(request);
    const existing = store.get(request.metadata.idempotencyKey);
    if (!existing) {
      const taskId = nextTaskId();
      store.set(request.metadata.idempotencyKey, { fingerprint, taskId });
      taskIds.push(taskId);
      sendJson(res, 201, response(taskId, request.metadata.correlationId, false));
      return;
    }
    if (existing.fingerprint === fingerprint) {
      sendJson(res, 200, response(existing.taskId, request.metadata.correlationId, true));
      return;
    }
    sendJson(
      res,
      409,
      buildContractError(
        "IDEMPOTENCY_CONFLICT",
        correlationId,
        "mock: idempotency key reused with a different payload",
      ),
    );
  }

  function response(taskId: string, correlationId: string, deduplicated: boolean) {
    return {
      contractVersion: "1.0" as const,
      correlationId,
      taskId,
      status: "RECEIVED" as const,
      createdAt: now().toISOString(),
      deduplicated,
    };
  }
  function nextTaskId(): string {
    taskCounter += 1;
    return `task_mock_${String(taskCounter).padStart(4, "0")}`;
  }

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/api/agent/v1`,
    port,
    requests,
    taskIds,
    setScenario(scenario) {
      defaultScenario = scenario;
    },
    queueScenarios(...scenarios) {
      scenarioQueue.push(...scenarios);
    },
    reset() {
      requests.length = 0;
      taskIds.length = 0;
      store.clear();
      scenarioQueue.length = 0;
      taskCounter = 0;
      defaultScenario = options.scenario ?? "ok";
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
