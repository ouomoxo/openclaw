/**
 * Runtime command runner (R4): a policy adapter over an injected ProcessRunner. Enforces argv (no shell),
 * cwd-inside-worktree, executable allowlist, and a sanitized env (the provided env is passed verbatim —
 * the runtime never merges host process.env). Preserves exit code vs terminating signal and distinguishes
 * timeout from cancellation.
 */
import { validateCommand } from "./command-policy.js";
import { createSpawnProcessRunner, type ProcessRunner } from "./process-runner.js";
import type { RepositoryExecutionProfile } from "./types.js";

export interface RuntimeCommandInput {
  runId: string;
  cwd: string;
  executable: string;
  args: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  /** Sanitized env (R2). The runner passes this verbatim and never merges process.env. */
  environment: Record<string, string>;
  worktreeRoot: string;
  profile: RepositoryExecutionProfile;
  kind: "verification" | "agent";
  abortSignal?: AbortSignal;
}

export interface RuntimeCommandResult {
  status: "passed" | "failed" | "timed-out" | "cancelled" | "blocked";
  blockedCode?: string;
  blockedReason?: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  highRisk: boolean;
}

export interface RuntimeCommandRunner {
  run(input: RuntimeCommandInput): Promise<RuntimeCommandResult>;
}

export function createRuntimeCommandRunner(
  processRunner: ProcessRunner = createSpawnProcessRunner(),
): RuntimeCommandRunner {
  return {
    async run(input) {
      const policy = validateCommand({
        executable: input.executable,
        args: input.args,
        cwd: input.cwd,
        worktreeRoot: input.worktreeRoot,
        profile: input.profile,
        kind: input.kind,
      });
      if (!policy.ok) {
        return {
          status: "blocked",
          blockedCode: policy.code,
          blockedReason: policy.reason,
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 0,
          highRisk: false,
        };
      }

      if (input.abortSignal?.aborted) {
        return blank("cancelled", policy.highRisk);
      }

      const result = await processRunner({
        argv: [input.executable, ...input.args],
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
        env: input.environment, // verbatim — no process.env merge
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      });

      const status =
        result.termination === "aborted"
          ? "cancelled"
          : result.termination === "timeout"
            ? "timed-out"
            : result.code === 0 && result.termination === "exit"
              ? "passed"
              : "failed";

      return {
        status,
        exitCode: result.code,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
        durationMs: result.durationMs,
        highRisk: policy.highRisk,
      };
    },
  };
}

function blank(status: RuntimeCommandResult["status"], highRisk: boolean): RuntimeCommandResult {
  return {
    status,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 0,
    highRisk,
  };
}
