/**
 * Runtime event model (R6). Per-run monotonic `sequence` (never relies on eventId/timestamp ordering).
 * Payloads must be secret-free (the runtime controls what it puts in them).
 */
export type RuntimeEventType =
  | "RUN_RECEIVED"
  | "RUNTIME_SECURITY_POSTURE_RECORDED"
  | "RUN_PREPARING"
  | "WORKTREE_CREATED"
  | "EXECUTOR_STARTED"
  | "EXECUTOR_COMPLETED"
  | "COMMAND_STARTED"
  | "COMMAND_COMPLETED"
  | "COMMAND_FAILED"
  | "VERIFICATION_STARTED"
  | "VERIFICATION_PASSED"
  | "VERIFICATION_FAILED"
  | "ARTIFACT_CREATED"
  | "RUN_BLOCKED"
  | "RUN_COMPLETED"
  | "RUN_FAILED"
  | "RUN_CANCELLED"
  | "CLEANUP_STARTED"
  | "CLEANUP_COMPLETED";

export type RuntimeEventSeverity = "debug" | "info" | "warning" | "error";

export interface RuntimeEvent {
  version: "0.1";
  eventId: string;
  taskId: string;
  runId: string;
  correlationId: string;
  sequence: number;
  type: RuntimeEventType;
  severity: RuntimeEventSeverity;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RuntimeEventFactoryOptions {
  taskId: string;
  runId: string;
  correlationId: string;
  uuid: () => string;
  now: () => Date;
}

/** Produces ordered RuntimeEvents for one run with a monotonic per-run sequence. */
export class RuntimeEventFactory {
  private sequence = 0;
  constructor(private readonly options: RuntimeEventFactoryOptions) {}

  next(
    type: RuntimeEventType,
    severity: RuntimeEventSeverity,
    payload: Record<string, unknown> = {},
  ): RuntimeEvent {
    this.sequence += 1;
    return {
      version: "0.1",
      eventId: `evt_${this.options.runId}_${this.options.uuid()}`,
      taskId: this.options.taskId,
      runId: this.options.runId,
      correlationId: this.options.correlationId,
      sequence: this.sequence,
      type,
      severity,
      payload,
      createdAt: this.options.now().toISOString(),
    };
  }
}
