import { parseCreateTaskRequest } from "@ouomoxo/ov-agent-contracts";
import { Type } from "typebox";
import { jsonResult, type AnyAgentTool } from "../../api.js";
import type { OvApiClient } from "../client/ov-api-client.js";
import type { ConfigResult } from "../config.js";
import {
  buildCreateTaskRequest,
  deriveIdempotencyKey,
  makeCorrelationId,
} from "../request-builder.js";
import type { OvBridgeConfig, OvCreateTaskToolInput, OvCreateTaskToolOutput } from "../types.js";

export interface CreateTaskToolDeps {
  /** Resolve config at call time so a misconfigured plugin returns CONFIGURATION_ERROR, not a crash. */
  resolveConfig: () => ConfigResult;
  /** Build the OV API client for a resolved config (injectable for tests). */
  createClient: (config: OvBridgeConfig) => OvApiClient;
  /** Current time (RFC 3339 sentAt). Injectable for deterministic tests. */
  now?: () => Date;
  /** UUID source for correlation/fallback invocation ids. Injectable for deterministic tests. */
  uuid?: () => string;
}

const SourceSchema = Type.Object(
  {
    channel: Type.String({
      enum: ["telegram", "slack", "openclaw", "api"],
      description: "Origin channel.",
    }),
    userId: Type.String({ description: "Immutable user id on the origin channel." }),
    channelId: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.String()),
    messageId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const ToolInputSchema = Type.Object(
  {
    title: Type.String({ description: "Short outcome-oriented task title." }),
    objective: Type.String({ description: "Result-centric objective (what done looks like)." }),
    rawInstruction: Type.String({ description: "The user's original instruction, verbatim." }),
    requestedType: Type.Optional(Type.String({ description: "Optional task type hint." })),
    projectId: Type.Optional(
      Type.String({ description: "OV project id (or provide projectKey)." }),
    ),
    projectKey: Type.Optional(
      Type.String({ description: "OV project key (or provide projectId)." }),
    ),
    source: SourceSchema,
  },
  { additionalProperties: false },
);

const TOOL_DESCRIPTION =
  "Create a durable development task in the OV Control Plane. " +
  "Use this for actionable development work that must be tracked. " +
  "Do not use it for casual questions, status queries, or conversation.";

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readToolInput(raw: unknown): OvCreateTaskToolInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  const s = (r.source ?? {}) as Record<string, unknown>;
  const channel = str(s.channel);
  return {
    title: str(r.title) ?? "",
    objective: str(r.objective) ?? "",
    rawInstruction: str(r.rawInstruction) ?? "",
    ...(str(r.requestedType) !== undefined ? { requestedType: str(r.requestedType) } : {}),
    ...(str(r.projectId) !== undefined ? { projectId: str(r.projectId) } : {}),
    ...(str(r.projectKey) !== undefined ? { projectKey: str(r.projectKey) } : {}),
    source: {
      channel:
        channel === "telegram" || channel === "slack" || channel === "openclaw" || channel === "api"
          ? channel
          : "api",
      userId: str(s.userId) ?? "",
      ...(str(s.channelId) !== undefined ? { channelId: str(s.channelId) } : {}),
      ...(str(s.threadId) !== undefined ? { threadId: str(s.threadId) } : {}),
      ...(str(s.messageId) !== undefined ? { messageId: str(s.messageId) } : {}),
    },
  } as OvCreateTaskToolInput;
}

/** Pure call logic, exported for unit tests (no agent/tool framework needed). */
export async function runCreateTask(
  raw: unknown,
  deps: CreateTaskToolDeps,
  signal?: AbortSignal,
): Promise<OvCreateTaskToolOutput> {
  const now = deps.now ?? (() => new Date());
  const uuid = deps.uuid ?? (() => globalThis.crypto.randomUUID());

  const cfg = deps.resolveConfig();
  if (!cfg.ok) {
    return { ok: false, code: cfg.code, retryable: false, message: cfg.message };
  }

  const input = readToolInput(raw);
  const correlationId = makeCorrelationId(uuid);
  const idempotencyKey = deriveIdempotencyKey(input.source, uuid());
  const sentAt = now().toISOString();
  const request = buildCreateTaskRequest(input, { correlationId, idempotencyKey, sentAt });

  const parsed = parseCreateTaskRequest(request);
  if (!parsed.success) {
    const first = parsed.issues[0];
    const detail = first ? `${first.path}: ${first.message}` : "invalid request";
    return {
      ok: false,
      code: "REQUEST_VALIDATION_ERROR",
      retryable: false,
      correlationId,
      message: `Invalid task request (${detail}).`,
    };
  }

  const client = deps.createClient(cfg.config);
  const ctxBase = { correlationId, idempotencyKey };
  const result = await client.createTask(parsed.data, signal ? { ...ctxBase, signal } : ctxBase);

  if (result.ok) {
    return {
      ok: true,
      taskId: result.taskId,
      status: "RECEIVED",
      deduplicated: result.deduplicated,
      correlationId: result.correlationId,
      message: `OV Task ${result.taskId} ${result.deduplicated ? "already existed (deduplicated)" : "created"} and received.`,
    };
  }
  return {
    ok: false,
    code: result.code,
    retryable: result.retryable,
    ...(result.correlationId ? { correlationId: result.correlationId } : {}),
    message: result.message,
  };
}

/** Build the ov_create_task agent tool. */
export function createOvCreateTaskTool(deps: CreateTaskToolDeps): AnyAgentTool {
  return {
    name: "ov_create_task",
    label: "OV Create Task",
    description: TOOL_DESCRIPTION,
    parameters: ToolInputSchema,
    execute: async (_toolCallId: string, rawParams: unknown, signal?: AbortSignal) => {
      const output = await runCreateTask(rawParams, deps, signal);
      return jsonResult(output);
    },
  } as AnyAgentTool;
}
