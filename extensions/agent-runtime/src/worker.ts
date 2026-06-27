/**
 * Single Worker Runtime (R7). Composes the pipeline:
 *   validate → posture → worktree → executor → real git inspect → verification → artifacts → result
 *   → terminal event → outbox flush → cleanup.
 * A run is `completed` ONLY when the executor completed, every required verification passed, artifacts were
 * collected, and no forbidden file changed. A model saying "done" never overrides this. Events are appended
 * to the durable outbox before delivery. Cancellation and recovery never auto-complete a run.
 */
import { existsSync } from "node:fs";
import { ArtifactCollector } from "./artifact-collector.js";
import { RuntimeEventFactory, type RuntimeEvent, type RuntimeEventType } from "./events.js";
import type { Executor } from "./executor.js";
import { validateRuntimeRunInput } from "./input.js";
import { flushOutbox, type OutboxStore } from "./outbox.js";
import type { RuntimeEventReceiver } from "./receiver.js";
import { safeErrorMessage } from "./redaction.js";
import { gateRepositoryTrust } from "./repository-profile.js";
import { buildSecurityPostureEvent, defaultExperimentalPosture } from "./security-posture.js";
import type {
  ChangedFile,
  RepositoryExecutionProfile,
  RuntimeArtifact,
  RuntimeRunInput,
  RuntimeSecurityPosture,
} from "./types.js";
import type { VerificationReport, VerificationRunner } from "./verification-runner.js";
import { isTerminal, type WorkerRunStatus } from "./worker-state.js";

export interface WorkerDeps {
  executor: Executor;
  worktree: {
    prepare: (i: WorktreePrepareArgs) => Promise<WorktreePrepareOut>;
    cleanup: (runId: string) => Promise<void>;
  };
  verificationRunner: VerificationRunner;
  makeArtifactCollector: (taskId: string, runId: string) => ArtifactCollector;
  outbox: OutboxStore;
  receiver: RuntimeEventReceiver;
  profile: RepositoryExecutionProfile;
  buildEnv: (runId: string) => Record<string, string>;
  runtimeRoot: string;
  projectKey: string;
  allowedRepositoryRoots: string[];
  now: () => Date;
  uuid: () => string;
  abortSignal?: AbortSignal;
}

interface WorktreePrepareArgs {
  runId: string;
  taskId: string;
  projectKey: string;
  repositoryPath: string;
  baseBranch: string;
  baseRevision?: string;
  runtimeRoot: string;
  allowedRepositoryRoots: string[];
}
type WorktreePrepareOut =
  | { ok: true; worktree: { worktreeDir: string; branch: string } }
  | { ok: false; code: string; reason: string };

export interface WorkerRunResult {
  runId: string;
  status: WorkerRunStatus;
  changedFiles: ChangedFile[];
  forbiddenChanges: ChangedFile[];
  artifacts: RuntimeArtifact[];
  verification?: VerificationReport;
  securityPosture: RuntimeSecurityPosture;
  events: RuntimeEvent[];
}

export async function runWorker(
  input: RuntimeRunInput,
  deps: WorkerDeps,
): Promise<WorkerRunResult> {
  const events = new RuntimeEventFactory({
    taskId: input.taskId,
    runId: input.runId,
    correlationId: input.correlationId,
    uuid: deps.uuid,
    now: deps.now,
  });
  const appended: RuntimeEvent[] = [];
  const emit = (
    type: RuntimeEventType,
    severity: RuntimeEvent["severity"],
    payload: Record<string, unknown> = {},
  ) => {
    const e = events.next(type, severity, payload);
    deps.outbox.append(e); // durable BEFORE delivery
    appended.push(e);
  };
  const aborted = () => deps.abortSignal?.aborted === true;
  const posture = defaultExperimentalPosture();
  const artifacts: RuntimeArtifact[] = [];
  let changedFiles: ChangedFile[] = [];
  let forbiddenChanges: ChangedFile[] = [];
  const out: { verification?: VerificationReport } = {};

  const finalize = async (status: WorkerRunStatus): Promise<WorkerRunResult> => {
    const terminal: RuntimeEventType =
      status === "completed"
        ? "RUN_COMPLETED"
        : status === "cancelled"
          ? "RUN_CANCELLED"
          : status === "blocked"
            ? "RUN_BLOCKED"
            : "RUN_FAILED";
    emit(terminal, status === "completed" ? "info" : "warning", { status });
    await flushOutbox({
      store: deps.outbox,
      receiver: deps.receiver,
      maxAttempts: 3,
      now: () => deps.now().getTime(),
    });
    emit("CLEANUP_STARTED", "debug");
    await deps.worktree.cleanup(input.runId).catch(() => undefined);
    emit("CLEANUP_COMPLETED", "debug");
    await flushOutbox({
      store: deps.outbox,
      receiver: deps.receiver,
      maxAttempts: 3,
      now: () => deps.now().getTime(),
    });
    return {
      runId: input.runId,
      status,
      changedFiles,
      forbiddenChanges,
      artifacts,
      ...(out.verification ? { verification: out.verification } : {}),
      securityPosture: posture,
      events: appended,
    };
  };

  emit("RUN_RECEIVED", "info");
  emit("RUNTIME_SECURITY_POSTURE_RECORDED", "info", { ...buildSecurityPostureEvent(posture) });

  // 1. input validation
  if (!validateRuntimeRunInput(input).success) {
    return finalize("failed");
  }
  // 2. experimental trust policy
  const trust = gateRepositoryTrust(deps.profile);
  if (!trust.ok) {
    emit("RUN_BLOCKED", "warning", { code: trust.code });
    return finalize("blocked");
  }

  // 3. worktree
  emit("RUN_PREPARING", "info");
  const wt = await deps.worktree.prepare({
    runId: input.runId,
    taskId: input.taskId,
    projectKey: deps.projectKey,
    repositoryPath: input.repository.path,
    baseBranch: input.repository.baseBranch,
    ...(input.repository.baseRevision ? { baseRevision: input.repository.baseRevision } : {}),
    runtimeRoot: deps.runtimeRoot,
    allowedRepositoryRoots: deps.allowedRepositoryRoots,
  });
  if (!wt.ok) {
    emit("RUN_BLOCKED", "warning", { code: wt.code });
    return finalize("blocked");
  }
  emit("WORKTREE_CREATED", "info", { branch: wt.worktree.branch });
  if (aborted()) {
    return finalize("cancelled");
  }

  // 4. executor
  emit("EXECUTOR_STARTED", "info");
  let executorStatus: string;
  try {
    const handle = await deps.executor.start({
      runId: input.runId,
      workingDirectory: wt.worktree.worktreeDir,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
      constraints: input.constraints,
      verificationCommands: input.verificationCommands,
      permissions: input.permissions,
      ...(deps.abortSignal ? { abortSignal: deps.abortSignal } : {}),
    });
    const result = await deps.executor.collectResult(handle);
    executorStatus = result.status;
  } catch (error) {
    emit("EXECUTOR_COMPLETED", "error", { error: safeErrorMessage(error) });
    return finalize("failed");
  }
  emit("EXECUTOR_COMPLETED", "info", { status: executorStatus });
  if (executorStatus === "cancelled" || aborted()) {
    return finalize("cancelled");
  }

  // 5. real git inspect + artifacts
  const collector = deps.makeArtifactCollector(input.taskId, input.runId);
  const gitEv = await collector.collectGitEvidence(wt.worktree.worktreeDir);
  changedFiles = gitEv.changedFiles;
  forbiddenChanges = gitEv.forbiddenChanges;
  for (const a of gitEv.artifacts) {
    artifacts.push(a);
    emit("ARTIFACT_CREATED", "info", { artifactId: a.artifactId, type: a.type });
  }
  if (forbiddenChanges.length > 0) {
    emit("RUN_BLOCKED", "error", { forbiddenChanges: forbiddenChanges.map((c) => c.path) });
    return finalize("blocked");
  }

  // 6. verification
  emit("VERIFICATION_STARTED", "info");
  const requestedCommands = input.verificationCommands.map((c) =>
    c.trim().split(/\s+/).filter(Boolean),
  );
  out.verification = await deps.verificationRunner.runAll({
    runId: input.runId,
    cwd: wt.worktree.worktreeDir,
    worktreeRoot: wt.worktree.worktreeDir,
    environment: deps.buildEnv(input.runId),
    profile: deps.profile,
    requestedCommands,
    timeoutMs: input.limits.timeoutMs,
    maxOutputBytes: input.limits.maxOutputBytes,
    ...(deps.abortSignal ? { abortSignal: deps.abortSignal } : {}),
  });
  for (const ev of out.verification.evidences) {
    emit(
      ev.status === "passed" ? "VERIFICATION_PASSED" : "VERIFICATION_FAILED",
      ev.status === "passed" ? "info" : "warning",
      {
        id: ev.id,
        type: ev.type,
        status: ev.status,
        ...(ev.exitCode !== undefined ? { exitCode: ev.exitCode } : {}),
      },
    );
  }
  for (const vout of out.verification.outputs) {
    artifacts.push(collector.collectText("command-stdout", `${vout.id}-stdout.txt`, vout.stdout));
    artifacts.push(collector.collectText("command-stderr", `${vout.id}-stderr.txt`, vout.stderr));
  }

  // 7. completion judgment (evidence-based; model self-report never overrides)
  if (out.verification.cancelled || aborted()) {
    return finalize("cancelled");
  }
  const completed =
    executorStatus === "completed" && out.verification.allPassed && forbiddenChanges.length === 0;
  return finalize(completed ? "completed" : "failed");
}

// --- Recovery (R7) ---

export interface RecoveredRunState {
  runId: string;
  status: "running" | "orphaned" | "completed" | "unknown";
  worktreeExists: boolean;
  executorAlive: boolean;
  pendingEvents: number;
}

/** Inspect a run after restart. Never auto-completes; unknown is reported as such (callers may treat as blocked). */
export function inspectRecovery(args: {
  runId: string;
  worktreeDir: string;
  outbox: OutboxStore;
  executorState?: "running" | "idle" | "error" | "unknown";
}): RecoveredRunState {
  const worktreeExists = existsSync(args.worktreeDir);
  const executorAlive = args.executorState === "running";
  const pendingEvents = args.outbox.countPending();
  const status: RecoveredRunState["status"] = executorAlive
    ? "running"
    : worktreeExists
      ? "orphaned"
      : "unknown";
  return { runId: args.runId, status, worktreeExists, executorAlive, pendingEvents };
}

export { isTerminal };
