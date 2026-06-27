import type { CreateTaskRequest } from "@ouomoxo/ov-agent-contracts";
import type { OvCreateTaskToolInput } from "./types.js";

/** Opaque correlation id generated per logical request by the bridge. */
export function makeCorrelationId(uuid: () => string): string {
  return `corr_${uuid()}`;
}

/**
 * Derive a stable idempotency key from channel message identity so a duplicate delivery of the
 * same message dedupes, while different messages/commands from the same user never collide.
 * Falls back to an explicit invocation id when message identity is absent (api/internal calls).
 */
export function deriveIdempotencyKey(
  source: OvCreateTaskToolInput["source"],
  fallbackInvocationId: string,
): string {
  const { channel, channelId, threadId, messageId } = source;
  if (channel === "telegram" && channelId && messageId) {
    return `telegram:${channelId}:${messageId}:create-task`;
  }
  if (channel === "slack" && channelId && messageId) {
    return `slack:${channelId}:${threadId ?? messageId}:${messageId}:create-task`;
  }
  return `${channel}:${fallbackInvocationId}:create-task`;
}

export interface RequestMeta {
  correlationId: string;
  idempotencyKey: string;
  sentAt: string;
}

/** Assemble the wire CreateTaskRequest, omitting absent optional fields (exactOptionalPropertyTypes-safe). */
export function buildCreateTaskRequest(
  input: OvCreateTaskToolInput,
  meta: RequestMeta,
): CreateTaskRequest {
  const source: CreateTaskRequest["source"] = {
    channel: input.source.channel,
    userId: input.source.userId,
    ...(input.source.channelId !== undefined ? { channelId: input.source.channelId } : {}),
    ...(input.source.threadId !== undefined ? { threadId: input.source.threadId } : {}),
    ...(input.source.messageId !== undefined ? { messageId: input.source.messageId } : {}),
  };
  const project: CreateTaskRequest["project"] = {
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.projectKey !== undefined ? { projectKey: input.projectKey } : {}),
  };
  const task: CreateTaskRequest["task"] = {
    title: input.title,
    objective: input.objective,
    rawInstruction: input.rawInstruction,
    ...(input.requestedType !== undefined ? { requestedType: input.requestedType } : {}),
  };
  return {
    contractVersion: "1.0",
    metadata: {
      correlationId: meta.correlationId,
      idempotencyKey: meta.idempotencyKey,
      sentAt: meta.sentAt,
    },
    source,
    project,
    task,
  };
}
