/**
 * Process runner (R4). Argv spawn, no shell, with the env REPLACED (never merged with process.env).
 *
 * Why not runPluginCommandWithTimeout: that wrapper calls core runCommandWithTimeout, whose env defaults
 * to `params.baseEnv ?? process.env` (src/process/exec.ts:314) and merges — so it leaks the host env into
 * the child, defeating env minimization. We therefore use a minimal argv spawn that passes ONLY the
 * sanitized env. This enforces the env-isolation invariant the SDK wrapper cannot; it is not a general
 * command-runner reimplementation. Injectable for deterministic tests (FakeProcessRunner).
 */
import { spawn } from "node:child_process";

export interface ProcessRunSpec {
  argv: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Sanitized env — passed verbatim to the child (no process.env merge). */
  env: Record<string, string>;
  abortSignal?: AbortSignal;
}

export interface ProcessRunResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  termination: "exit" | "timeout" | "signal" | "aborted" | "spawn-error";
  durationMs: number;
}

export type ProcessRunner = (spec: ProcessRunSpec) => Promise<ProcessRunResult>;

class Capture {
  private chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;
  constructor(private readonly max: number) {}
  push(buf: Buffer): void {
    if (this.bytes >= this.max) {
      this.truncated = true;
      return;
    }
    const remaining = this.max - this.bytes;
    if (buf.length > remaining) {
      this.chunks.push(buf.subarray(0, remaining));
      this.bytes = this.max;
      this.truncated = true;
    } else {
      this.chunks.push(buf);
      this.bytes += buf.length;
    }
  }
  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/** Default runner: env-replacing argv spawn with timeout (SIGKILL), abort, byte-capped output. */
export function createSpawnProcessRunner(): ProcessRunner {
  return (spec) =>
    new Promise<ProcessRunResult>((resolveResult) => {
      const startedAt = Date.now();
      const finish = (
        partial: Omit<
          ProcessRunResult,
          "stdout" | "stderr" | "stdoutTruncated" | "stderrTruncated" | "durationMs"
        >,
      ) => {
        resolveResult({
          ...partial,
          stdout: out.text(),
          stderr: err.text(),
          stdoutTruncated: out.truncated,
          stderrTruncated: err.truncated,
          durationMs: Date.now() - startedAt,
        });
      };
      const out = new Capture(spec.maxOutputBytes);
      const err = new Capture(spec.maxOutputBytes);

      if (spec.abortSignal?.aborted) {
        finish({ code: null, signal: null, termination: "aborted" });
        return;
      }

      const [command, ...args] = spec.argv;
      if (!command) {
        finish({ code: null, signal: null, termination: "spawn-error" });
        return;
      }

      let child;
      try {
        // env REPLACED — child sees only spec.env, never process.env.
        child = spawn(command, args, { cwd: spec.cwd, env: spec.env });
      } catch {
        finish({ code: null, signal: null, termination: "spawn-error" });
        return;
      }

      let timedOut = false;
      let aborted = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, spec.timeoutMs);
      const onAbort = () => {
        aborted = true;
        child.kill("SIGKILL");
      };
      spec.abortSignal?.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (d: Buffer) => out.push(d));
      child.stderr?.on("data", (d: Buffer) => err.push(d));
      child.on("error", () => {
        clearTimeout(timer);
        spec.abortSignal?.removeEventListener("abort", onAbort);
        finish({ code: null, signal: null, termination: "spawn-error" });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        spec.abortSignal?.removeEventListener("abort", onAbort);
        const termination = aborted ? "aborted" : timedOut ? "timeout" : signal ? "signal" : "exit";
        finish({ code, signal, termination });
      });
    });
}
