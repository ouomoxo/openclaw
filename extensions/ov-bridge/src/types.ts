/** Resolved, validated OV bridge configuration. */
export interface OvBridgeConfig {
  apiBaseUrl: string;
  serviceToken: string;
  contractVersion: "1.0";
  requestTimeoutMs: number;
  maxRetries: number;
}

/** Normalized internal error codes surfaced to the agent (never raw OV/HTTP internals). */
export type OvBridgeErrorCode =
  | "CONFIGURATION_ERROR"
  | "REQUEST_VALIDATION_ERROR"
  | "AUTHENTICATION_ERROR"
  | "AUTHORIZATION_ERROR"
  | "PROJECT_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "CONTRACT_VERSION_ERROR"
  | "RATE_LIMITED"
  | "OV_UNAVAILABLE"
  | "TIMEOUT"
  | "INVALID_RESPONSE"
  | "INTERNAL_ERROR";

/** Semantic tool input from the agent. The bridge — not the agent — generates wire metadata. */
export interface OvCreateTaskToolInput {
  projectId?: string;
  projectKey?: string;
  title: string;
  objective: string;
  rawInstruction: string;
  requestedType?: string;
  source: {
    channel: "telegram" | "slack" | "openclaw" | "api";
    userId: string;
    channelId?: string;
    threadId?: string;
    messageId?: string;
  };
}

export interface OvCreateTaskToolResult {
  ok: true;
  taskId: string;
  status: "RECEIVED";
  deduplicated: boolean;
  correlationId: string;
  message: string;
}

export interface OvCreateTaskToolFailure {
  ok: false;
  code: OvBridgeErrorCode;
  retryable: boolean;
  correlationId?: string;
  message: string;
}

export type OvCreateTaskToolOutput = OvCreateTaskToolResult | OvCreateTaskToolFailure;
