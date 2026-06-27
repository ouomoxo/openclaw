/** Executor abstraction (§7). A thin adapter over the existing ACP harness — not a new harness. */
import type { ExecutorResult, RuntimePermissions } from "./types.js";

export interface ExecutorInput {
  runId: string;
  /** The isolated run worktree directory (becomes the ACP session cwd). */
  workingDirectory: string;
  objective: string;
  acceptanceCriteria: string[];
  constraints: string[];
  verificationCommands: string[];
  permissions: RuntimePermissions;
  abortSignal?: AbortSignal;
}

export interface ExecutorHandle {
  runId: string;
  sessionKey: string;
}

export interface ExecutorSnapshot {
  runId: string;
  state: "running" | "idle" | "error" | "unknown";
}

export interface Executor {
  start(input: ExecutorInput): Promise<ExecutorHandle>;
  cancel(handle: ExecutorHandle): Promise<void>;
  inspect(handle: ExecutorHandle): Promise<ExecutorSnapshot>;
  collectResult(handle: ExecutorHandle): Promise<ExecutorResult>;
}
