/** Shared test harness for the worker runtime (R7/R9). Deterministic FakeExecutor + a fully wired WorkerDeps. */
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactCollector } from "../src/artifact-collector.js";
import { createRuntimeCommandRunner } from "../src/command-runner.js";
import type { Executor, ExecutorHandle, ExecutorInput, ExecutorSnapshot } from "../src/executor.js";
import { createInMemoryOutboxStore } from "../src/outbox.js";
import type { ProcessRunResult } from "../src/process-runner.js";
import { createMockReceiver, type MockReceiver } from "../src/receiver.js";
import { defaultExperimentalPosture } from "../src/security-posture.js";
import type { ExecutorResult, RepositoryExecutionProfile, RuntimeRunInput } from "../src/types.js";
import { createVerificationRunner } from "../src/verification-runner.js";
import type { WorkerDeps } from "../src/worker.js";
import { WorktreeManager } from "../src/worktree.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" } as ExecFileSyncOptions)
    .toString()
    .trim();
}

export interface FakeExecutorOptions {
  status?: ExecutorResult["status"];
  /** Files the agent "writes" into the worktree on start (relative names). */
  writes?: { name: string; content: string }[];
}

export class FakeExecutor implements Executor {
  cancelled = false;
  constructor(private readonly options: FakeExecutorOptions = {}) {}
  async start(input: ExecutorInput): Promise<ExecutorHandle> {
    for (const w of this.options.writes ?? []) {
      writeFileSync(join(input.workingDirectory, w.name), w.content);
    }
    return { runId: input.runId, sessionKey: input.runId };
  }
  async cancel(): Promise<void> {
    this.cancelled = true;
  }
  async inspect(handle: ExecutorHandle): Promise<ExecutorSnapshot> {
    return { runId: handle.runId, state: "idle" };
  }
  async collectResult(): Promise<ExecutorResult> {
    return {
      status: this.options.status ?? "completed",
      summary: "fake",
      changedFiles: [],
      commands: [],
      verifications: [],
      risks: [],
      blockers: [],
      securityPosture: defaultExperimentalPosture(),
    };
  }
}

export const FIXTURE_RUNTIME_PROFILE: RepositoryExecutionProfile = {
  trustLevel: "fixture",
  allowedExecutables: ["node", "git"],
  allowedVerificationCommands: [["node", "--test"]],
  allowDependencyInstall: false,
  networkAllowed: false,
};

export function makeFixtureRepo(): { repoRoot: string; headSha: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), "ar-e2e-repo-"));
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.email", "t@localhost");
  git(repoRoot, "config", "user.name", "T");
  writeFileSync(join(repoRoot, "a.txt"), "one\n");
  git(repoRoot, "add", "a.txt");
  git(repoRoot, "commit", "-m", "init");
  return { repoRoot, headSha: git(repoRoot, "rev-parse", "HEAD") };
}

export function makeRuntimeInput(
  repoRoot: string,
  overrides: Partial<RuntimeRunInput> = {},
): RuntimeRunInput {
  return {
    version: "0.1",
    taskId: "task_1",
    runId: "run_1",
    correlationId: "corr_1",
    role: "worker",
    repository: { path: repoRoot, baseBranch: "main" },
    objective: "Modify a file and pass tests",
    acceptanceCriteria: ["a.txt updated"],
    constraints: [],
    permissions: {
      filesystem: "workspace-write",
      shell: true,
      network: false,
      gitCommit: true,
      gitPush: false,
      deployment: false,
    },
    verificationCommands: ["node --test"],
    limits: { timeoutMs: 30_000, maxOutputBytes: 1_000_000 },
    ...overrides,
  };
}

export interface Harness {
  deps: WorkerDeps;
  outbox: ReturnType<typeof createInMemoryOutboxStore>;
  receiver: MockReceiver;
  executor: FakeExecutor;
  repoRoot: string;
  runtimeRoot: string;
}

export function makeHarness(
  opts: {
    executor?: FakeExecutor;
    receiver?: MockReceiver;
    /** Override the fake process runner result for verification commands. */
    verificationResult?: ProcessRunResult;
    profile?: RepositoryExecutionProfile;
    abortSignal?: AbortSignal;
  } = {},
): Harness {
  const { repoRoot } = makeFixtureRepo();
  const runtimeRoot = mkdtempSync(join(tmpdir(), "ar-e2e-rt-"));
  const outbox = createInMemoryOutboxStore();
  const receiver = opts.receiver ?? createMockReceiver();
  const executor =
    opts.executor ?? new FakeExecutor({ writes: [{ name: "a.txt", content: "one\ntwo\n" }] });

  const processRunner = async (): Promise<ProcessRunResult> =>
    opts.verificationResult ?? {
      code: 0,
      signal: null,
      stdout: "ok",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      termination: "exit",
      durationMs: 1,
    };
  const commandRunner = createRuntimeCommandRunner(processRunner);
  const verificationRunner = createVerificationRunner(commandRunner);

  const deps: WorkerDeps = {
    executor,
    worktree: new WorktreeManager(),
    verificationRunner,
    makeArtifactCollector: (taskId, runId) =>
      new ArtifactCollector({
        storeRoot: runtimeRoot,
        taskId,
        runId,
        now: () => new Date("2026-06-28T00:00:00Z"),
      }),
    outbox,
    receiver,
    profile: opts.profile ?? FIXTURE_RUNTIME_PROFILE,
    buildEnv: () => ({ PATH: "/usr/bin", HOME: join(runtimeRoot, "home") }),
    runtimeRoot,
    projectKey: "proj",
    allowedRepositoryRoots: [repoRoot],
    now: () => new Date("2026-06-28T00:00:00Z"),
    uuid: (() => {
      let n = 0;
      return () => `u${++n}`;
    })(),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
  };
  return { deps, outbox, receiver, executor, repoRoot, runtimeRoot };
}
