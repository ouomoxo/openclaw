/** Worker run state machine (R7). Single transition policy, terminal states are final. */
export type WorkerRunStatus =
  | "received"
  | "preparing"
  | "running"
  | "verifying"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";

const TRANSITIONS: Record<WorkerRunStatus, readonly WorkerRunStatus[]> = {
  received: ["preparing", "blocked", "failed", "cancelled"],
  preparing: ["running", "blocked", "failed", "cancelled"],
  running: ["verifying", "blocked", "failed", "cancelled"],
  verifying: ["completed", "blocked", "failed", "cancelled"],
  completed: [],
  blocked: [],
  failed: [],
  cancelled: [],
};

export const TERMINAL_STATUSES: ReadonlySet<WorkerRunStatus> = new Set([
  "completed",
  "blocked",
  "failed",
  "cancelled",
]);

export function isTerminal(status: WorkerRunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function canTransition(from: WorkerRunStatus, to: WorkerRunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
