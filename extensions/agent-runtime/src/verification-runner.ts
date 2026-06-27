/**
 * Verification runner (R4). Runs the verification commands in input order. A command must be allowed by
 * BOTH the RuntimeRunInput (it is the source list) AND the RepositoryExecutionProfile. skipped is never
 * treated as passed; a disallowed command is a hard reject (not a pass). Actual exit codes win over any
 * model self-report. After cancellation, no further verification runs.
 */
import { matchesAllowedVerification } from "./command-policy.js";
import type { RuntimeCommandRunner } from "./command-runner.js";
import type {
  RepositoryExecutionProfile,
  VerificationEvidence,
  VerificationType,
} from "./types.js";

export interface VerificationRunInput {
  runId: string;
  cwd: string;
  worktreeRoot: string;
  environment: Record<string, string>;
  profile: RepositoryExecutionProfile;
  /** Argv arrays parsed from RuntimeRunInput.verificationCommands (in order). */
  requestedCommands: string[][];
  timeoutMs: number;
  maxOutputBytes: number;
  abortSignal?: AbortSignal;
}

export interface VerificationOutput {
  id: string;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface VerificationReport {
  evidences: VerificationEvidence[];
  outputs: VerificationOutput[];
  rejected: { argv: string[]; code: string; reason: string }[];
  allPassed: boolean;
  cancelled: boolean;
}

export interface VerificationRunner {
  runAll(input: VerificationRunInput): Promise<VerificationReport>;
}

function classify(argv: string[]): VerificationType {
  const [exe = "", a1 = ""] = argv.map((s) => s.toLowerCase());
  if (exe === "tsc" || (exe === "npx" && a1 === "tsc")) {
    return "typecheck";
  }
  if (
    exe.includes("vitest") ||
    exe === "jest" ||
    (exe === "node" && argv.includes("--test")) ||
    a1 === "test"
  ) {
    return "test";
  }
  if (exe.includes("eslint") || exe === "oxlint") {
    return "lint";
  }
  if (a1 === "build") {
    return "build";
  }
  return "custom";
}

export function createVerificationRunner(commandRunner: RuntimeCommandRunner): VerificationRunner {
  return {
    async runAll(input) {
      const evidences: VerificationEvidence[] = [];
      const outputs: VerificationOutput[] = [];
      const rejected: VerificationReport["rejected"] = [];
      let cancelled = false;
      let index = 0;

      for (const argv of input.requestedCommands) {
        // After cancellation, do not run any further verification.
        if (input.abortSignal?.aborted) {
          cancelled = true;
          break;
        }
        const [executable, ...args] = argv;
        if (!executable) {
          continue;
        }

        if (
          !matchesAllowedVerification(executable, args, input.profile.allowedVerificationCommands)
        ) {
          rejected.push({
            argv,
            code: "VERIFICATION_NOT_PERMITTED",
            reason: "command not in repository profile allowlist",
          });
          continue;
        }

        const id = `verif_${input.runId}_${index++}`;
        const result = await commandRunner.run({
          runId: input.runId,
          cwd: input.cwd,
          executable,
          args,
          timeoutMs: input.timeoutMs,
          maxOutputBytes: input.maxOutputBytes,
          environment: input.environment,
          worktreeRoot: input.worktreeRoot,
          profile: input.profile,
          kind: "verification",
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        });

        const status: VerificationEvidence["status"] =
          result.status === "passed"
            ? "passed"
            : result.status === "timed-out"
              ? "timed-out"
              : result.status === "cancelled"
                ? "cancelled"
                : "failed"; // includes "blocked" (defense-in-depth) treated as failed evidence

        evidences.push({
          id,
          type: classify(argv),
          executable,
          args,
          status,
          ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
          ...(result.signal !== null ? { signal: result.signal } : {}),
          durationMs: result.durationMs,
        });
        outputs.push({
          id,
          stdout: result.stdout,
          stderr: result.stderr,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
        });

        if (status === "cancelled") {
          cancelled = true;
          break;
        }
      }

      const allPassed =
        rejected.length === 0 &&
        !cancelled &&
        evidences.length > 0 &&
        evidences.every((e) => e.status === "passed");
      return { evidences, outputs, rejected, allPassed, cancelled };
    },
  };
}
