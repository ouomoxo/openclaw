import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import {
  AcpExecutorAdapter,
  RuntimeSecurityError,
  type AcpExecutorAdapterConfig,
  type AcpRunner,
  type AcpRunnerStartParams,
} from "../src/acp-executor-adapter.js";
import { DEFAULT_ENV_ALLOWLIST } from "../src/env-allowlist.js";
import type { ExecutorInput } from "../src/executor.js";
import { FIXTURE_PROFILE } from "../src/repository-profile.js";
import type { SecurityPostureEvent } from "../src/security-posture.js";
import type { RepositoryExecutionProfile } from "../src/types.js";

let worktree: string;
let homeRoot: string;

beforeAll(() => {
  worktree = mkdtempSync(join(tmpdir(), "ar-wt-"));
  homeRoot = mkdtempSync(join(tmpdir(), "ar-home-"));
});

const hostEnv: Record<string, string> = {
  PATH: "/usr/bin",
  LANG: "en_US.UTF-8",
  HOME: "/Users/real",
  OV_SERVICE_TOKEN: "leak-ov",
  GITHUB_TOKEN: "leak-gh",
  ANTHROPIC_API_KEY: "leak-anthropic",
  SSH_AUTH_SOCK: "/tmp/ssh.sock",
};

function config(): AcpExecutorAdapterConfig {
  return {
    environmentAllowlist: [...DEFAULT_ENV_ALLOWLIST],
    runtimeHomeRoot: homeRoot,
    maxTurnDurationMs: 60_000,
    maxOutputBytes: 1_000_000,
    allowNetwork: false,
  };
}

function makeRunner() {
  const calls: { start: AcpRunnerStartParams[]; cancel: number } = { start: [], cancel: 0 };
  const runner: AcpRunner = {
    async start(params) {
      calls.start.push(params);
      return { sessionKey: params.sessionKey };
    },
    async cancel() {
      calls.cancel += 1;
    },
    async inspect() {
      return { state: "running" };
    },
    async result() {
      return { status: "completed", summary: "done", exitCode: 0 };
    },
  };
  return { runner, calls };
}

function input(): ExecutorInput {
  return {
    runId: "run_1",
    workingDirectory: worktree,
    objective: "Fix the bug",
    acceptanceCriteria: ["tests pass"],
    constraints: [],
    verificationCommands: ["vitest run"],
    permissions: {
      filesystem: "workspace-write",
      shell: true,
      network: false,
      gitCommit: true,
      gitPush: false,
      deployment: false,
    },
  };
}

function makeAdapter(
  profile: RepositoryExecutionProfile = FIXTURE_PROFILE,
  opts: { allowTrustedLocal?: boolean } = {},
) {
  const { runner, calls } = makeRunner();
  const events: SecurityPostureEvent[] = [];
  const adapter = new AcpExecutorAdapter(
    config(),
    {
      runner,
      hostEnv,
      ensureRuntimeHome: async (root, runId) => join(root, runId),
      recordEvent: (e) => events.push(e),
    },
    profile,
    opts,
  );
  return { adapter, calls, events };
}

describe("AcpExecutorAdapter", () => {
  it("starts a run with a sanitized env (no host secrets) and runtime HOME", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.start(input());
    expect(calls.start.length).toBe(1);
    const env = calls.start[0].env;
    const json = JSON.stringify(env);
    for (const v of ["leak-ov", "leak-gh", "leak-anthropic", "/tmp/ssh.sock"]) {
      expect(json).not.toContain(v);
    }
    expect(env.OV_SERVICE_TOKEN).toBeUndefined();
    expect(env.HOME).toBe(join(homeRoot, "run_1"));
    expect(env.GIT_AUTHOR_EMAIL).toBe("agent-runtime@localhost");
  });

  it("records a not-production-eligible security posture event", async () => {
    const { adapter, events } = makeAdapter();
    await adapter.start(input());
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("RUNTIME_SECURITY_POSTURE_RECORDED");
    expect(events[0].productionEligible).toBe(false);
    expect(events[0].containerIsolationVerified).toBe(false);
  });

  it("rejects untrusted repositories before starting", async () => {
    const untrusted: RepositoryExecutionProfile = { ...FIXTURE_PROFILE, trustLevel: "untrusted" };
    const { adapter, calls } = makeAdapter(untrusted);
    await expect(adapter.start(input())).rejects.toBeInstanceOf(RuntimeSecurityError);
    expect(calls.start.length).toBe(0);
  });

  it("rejects a missing worktree", async () => {
    const { adapter } = makeAdapter();
    const bad = { ...input(), workingDirectory: join(worktree, "does-not-exist") };
    await expect(adapter.start(bad)).rejects.toBeInstanceOf(RuntimeSecurityError);
  });

  it("cancels by aborting the controller and the runner", async () => {
    const { adapter, calls } = makeAdapter();
    const handle = await adapter.start(input());
    await adapter.cancel(handle);
    expect(calls.cancel).toBe(1);
    expect(calls.start[0].abortSignal.aborted).toBe(true);
  });

  it("maps the collected result and stamps a not-production-eligible posture", async () => {
    const { adapter } = makeAdapter();
    const handle = await adapter.start(input());
    const result = await adapter.collectResult(handle);
    expect(result.status).toBe("completed");
    expect(result.securityPosture.productionEligible).toBe(false);
  });
});
