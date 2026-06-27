/**
 * AcpExecutorAdapter (§7/§10). Thin adapter that runs a coding agent via the ACP harness while enforcing
 * the experimental security pre-flight: repo-trust gate, worktree canonicalization, env minimization,
 * runtime-dedicated HOME, cancellation controller, and a recorded security posture. The actual ACP calls
 * are injected as `AcpRunner` (bound to getAcpSessionManager at wiring; mockable in tests).
 */
import { realpathSync } from "node:fs";
import { buildSanitizedEnv } from "./env-allowlist.js";
import type { Executor, ExecutorHandle, ExecutorInput, ExecutorSnapshot } from "./executor.js";
import { gateRepositoryTrust } from "./repository-profile.js";
import {
  buildSecurityPostureEvent,
  defaultExperimentalPosture,
  type SecurityPostureEvent,
} from "./security-posture.js";
import type { ExecutorResult, RepositoryExecutionProfile } from "./types.js";

export interface AcpExecutorAdapterConfig {
  environmentAllowlist: string[];
  runtimeHomeRoot: string;
  maxTurnDurationMs: number;
  maxOutputBytes: number;
  allowNetwork: false;
}

export interface AcpRunnerStartParams {
  runId: string;
  sessionKey: string;
  cwd: string;
  prompt: string;
  env: Record<string, string>;
  timeoutMs: number;
  abortSignal: AbortSignal;
}

export interface AcpRunnerHandle {
  sessionKey: string;
}

export interface AcpRunnerTurnResult {
  status: "completed" | "blocked" | "failed" | "cancelled";
  summary: string;
  exitCode?: number;
}

/** The live ACP seam, abstracted so the runtime stays gateway-free and testable. */
export interface AcpRunner {
  start(params: AcpRunnerStartParams): Promise<AcpRunnerHandle>;
  cancel(handle: AcpRunnerHandle): Promise<void>;
  inspect(handle: AcpRunnerHandle): Promise<{ state: "running" | "idle" | "error" | "unknown" }>;
  result(handle: AcpRunnerHandle): Promise<AcpRunnerTurnResult>;
}

export interface AcpExecutorAdapterDeps {
  runner: AcpRunner;
  hostEnv: Record<string, string | undefined>;
  /** Provision a dedicated runtime HOME for the run; returns its absolute path. */
  ensureRuntimeHome: (root: string, runId: string) => Promise<string>;
  /** Record runtime events (security posture, etc.). */
  recordEvent: (event: SecurityPostureEvent) => void;
  /** Serialize the brief into the ACP turn prompt (ACP has no structured input fields). */
  buildPrompt?: (input: ExecutorInput) => string;
}

export class RuntimeSecurityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeSecurityError";
  }
}

function defaultBuildPrompt(input: ExecutorInput): string {
  const lines = [
    `# Objective`,
    input.objective,
    ``,
    `# Acceptance criteria`,
    ...input.acceptanceCriteria.map((c) => `- ${c}`),
    ``,
    `# Constraints`,
    ...input.constraints.map((c) => `- ${c}`),
    `- Do not access the network.`,
    `- Only modify files inside the working directory.`,
    ``,
    `# Verification (will be run by the runtime, not by you)`,
    ...input.verificationCommands.map((c) => `- ${c}`),
  ];
  return lines.join("\n");
}

export class AcpExecutorAdapter implements Executor {
  private readonly handles = new Map<
    string,
    { runner: AcpRunnerHandle; controller: AbortController }
  >();

  constructor(
    private readonly config: AcpExecutorAdapterConfig,
    private readonly deps: AcpExecutorAdapterDeps,
    private readonly profile: RepositoryExecutionProfile,
    private readonly options: { allowTrustedLocal?: boolean } = {},
  ) {}

  async start(input: ExecutorInput): Promise<ExecutorHandle> {
    // 1. repository trust gate
    const trust = gateRepositoryTrust(this.profile, this.options);
    if (!trust.ok) {
      throw new RuntimeSecurityError(trust.code, trust.reason);
    }

    // 2. worktree path canonicalization (must exist; resolves symlinks)
    let cwd: string;
    try {
      cwd = realpathSync(input.workingDirectory);
    } catch {
      throw new RuntimeSecurityError("WORKTREE_MISSING", "workingDirectory does not exist");
    }

    // 3. runtime-dedicated HOME
    const runtimeHome = await this.deps.ensureRuntimeHome(this.config.runtimeHomeRoot, input.runId);

    // 4. sanitized env (host env never copied wholesale)
    const env = buildSanitizedEnv(
      {
        allowlist: this.config.environmentAllowlist,
        runtimeHome,
        explicit: {
          // test git identity so commits never use real user credentials
          GIT_AUTHOR_NAME: "Agent Runtime",
          GIT_AUTHOR_EMAIL: "agent-runtime@localhost",
          GIT_COMMITTER_NAME: "Agent Runtime",
          GIT_COMMITTER_EMAIL: "agent-runtime@localhost",
        },
      },
      this.deps.hostEnv,
    );

    // 5. cancellation controller (linked to the caller's abort signal)
    const controller = new AbortController();
    if (input.abortSignal) {
      if (input.abortSignal.aborted) {
        controller.abort();
      } else {
        input.abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }

    // 6. record security posture (productionEligible=false in this phase)
    this.deps.recordEvent(buildSecurityPostureEvent(defaultExperimentalPosture()));

    // 7. start the ACP turn via the injected runner
    const sessionKey = input.runId;
    const prompt = (this.deps.buildPrompt ?? defaultBuildPrompt)(input);
    const runnerHandle = await this.deps.runner.start({
      runId: input.runId,
      sessionKey,
      cwd,
      prompt,
      env,
      timeoutMs: this.config.maxTurnDurationMs,
      abortSignal: controller.signal,
    });
    this.handles.set(input.runId, { runner: runnerHandle, controller });
    return { runId: input.runId, sessionKey };
  }

  async cancel(handle: ExecutorHandle): Promise<void> {
    const entry = this.handles.get(handle.runId);
    if (!entry) {
      return;
    }
    entry.controller.abort();
    await this.deps.runner.cancel(entry.runner);
  }

  async inspect(handle: ExecutorHandle): Promise<ExecutorSnapshot> {
    const entry = this.handles.get(handle.runId);
    if (!entry) {
      return { runId: handle.runId, state: "unknown" };
    }
    const snap = await this.deps.runner.inspect(entry.runner);
    return { runId: handle.runId, state: snap.state };
  }

  async collectResult(handle: ExecutorHandle): Promise<ExecutorResult> {
    const entry = this.handles.get(handle.runId);
    if (!entry) {
      throw new RuntimeSecurityError("UNKNOWN_HANDLE", "no active run for handle");
    }
    const turn = await this.deps.runner.result(entry.runner);
    // changedFiles/commands/verifications are filled by the WorkerRuntime (scans worktree + runs verification).
    return {
      status: turn.status,
      summary: turn.summary,
      changedFiles: [],
      commands: [],
      verifications: [],
      risks: [],
      blockers: [],
      ...(turn.exitCode !== undefined ? { exitCode: turn.exitCode } : {}),
      securityPosture: defaultExperimentalPosture(),
    };
  }
}
