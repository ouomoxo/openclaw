import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";
import {
  clearSessionStoreCacheForTest,
  drainSessionStoreWriterQueuesForTest,
} from "../config/sessions/store.js";
import { captureEnv } from "../test-utils/env.js";
import {
  createSubagentRegistryTestDeps,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";

const hoisted = vi.hoisted(() => ({
  announceSpy: vi.fn(async () => true),
  allowedRunIds: undefined as Set<string> | undefined,
  registryPath: undefined as string | undefined,
}));
const { announceSpy } = hoisted;
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
}));

vi.mock("./subagent-orphan-recovery.js", () => ({
  scheduleOrphanRecovery: vi.fn(),
}));

vi.mock("./subagent-registry.store.js", async () => {
  const actual = await vi.importActual<typeof import("./subagent-registry.store.js")>(
    "./subagent-registry.store.js",
  );
  const fsSync = await import("node:fs");
  const pathSync = await import("node:path");
  const resolvePath = () => hoisted.registryPath ?? actual.resolveSubagentRegistryPath();
  return {
    ...actual,
    resolveSubagentRegistryPath: resolvePath,
    loadSubagentRegistryFromDisk: () => {
      try {
        const parsed = JSON.parse(fsSync.readFileSync(resolvePath(), "utf8")) as {
          runs?: Record<string, import("./subagent-registry.types.js").SubagentRunRecord>;
        };
        return new Map(Object.entries(parsed.runs ?? {}));
      } catch {
        return new Map();
      }
    },
    saveSubagentRegistryToDisk: (
      runs: Map<string, import("./subagent-registry.types.js").SubagentRunRecord>,
    ) => {
      const pathname = resolvePath();
      const persistedRuns = hoisted.allowedRunIds
        ? new Map([...runs].filter(([runId]) => hoisted.allowedRunIds?.has(runId)))
        : runs;
      if (hoisted.allowedRunIds && persistedRuns.size === 0 && runs.size > 0) {
        return;
      }
      fsSync.mkdirSync(pathSync.dirname(pathname), { recursive: true });
      fsSync.writeFileSync(
        pathname,
        `${JSON.stringify({ version: 2, runs: Object.fromEntries(persistedRuns) }, null, 2)}\n`,
        "utf8",
      );
    },
  };
});

let mod: typeof import("./subagent-registry.js");
let callGatewayModule: typeof import("../gateway/call.js");
let agentEventsModule: typeof import("../infra/agent-events.js");

describe("subagent registry persistence resume", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempStateDir: string | null = null;

  const writeChildSessionEntry = async (params: {
    sessionKey: string;
    sessionId?: string;
    updatedAt?: number;
    abortedLastRun?: boolean;
  }) => {
    if (!tempStateDir) {
      throw new Error("tempStateDir not initialized");
    }
    return await writeSubagentSessionEntry({
      stateDir: tempStateDir,
      agentId: "main",
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      updatedAt: params.updatedAt,
      abortedLastRun: params.abortedLastRun,
      defaultSessionId: `sess-${Date.now()}`,
    });
  };

  beforeAll(async () => {
    vi.resetModules();
    mod = await import("./subagent-registry.js");
    callGatewayModule = await import("../gateway/call.js");
    agentEventsModule = await import("../infra/agent-events.js");
  });

  beforeEach(async () => {
    announceSpy.mockClear();
    vi.mocked(callGatewayModule.callGateway).mockReset();
    vi.mocked(callGatewayModule.callGateway).mockResolvedValue({
      status: "ok",
      startedAt: 111,
      endedAt: 222,
    });
    mod.testing.setDepsForTest({
      ...createSubagentRegistryTestDeps({
        callGateway: vi.mocked(callGatewayModule.callGateway),
        captureSubagentCompletionReply: vi.fn(async () => undefined),
      }),
    });
    mod.resetSubagentRegistryForTests({ persist: false });
    vi.mocked(agentEventsModule.onAgentEvent).mockReset();
    vi.mocked(agentEventsModule.onAgentEvent).mockReturnValue(() => undefined);
  });

  afterEach(async () => {
    announceSpy.mockClear();
    mod.testing.setDepsForTest();
    mod.resetSubagentRegistryForTests({ persist: false });
    await drainSessionStoreWriterQueuesForTest();
    clearSessionStoreCacheForTest();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = null;
    }
    hoisted.registryPath = undefined;
    hoisted.allowedRunIds = undefined;
    envSnapshot.restore();
  });

  it("persists runs to disk and resumes after restart", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    const registryPath = path.join(tempStateDir, "subagents", "runs.json");
    hoisted.registryPath = registryPath;
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(
      registryPath,
      `${JSON.stringify(
        {
          version: 2,
          runs: {
            "run-1": {
              runId: "run-1",
              childSessionKey: "agent:main:subagent:test",
              requesterSessionKey: "agent:main:main",
              requesterOrigin: { channel: "whatsapp", accountId: "acct-main" },
              requesterDisplayKey: "main",
              task: "do the thing",
              cleanup: "keep",
              createdAt: Date.now(),
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeChildSessionEntry({
      sessionKey: "agent:main:subagent:test",
      sessionId: "sess-test",
    });

    const raw = await fs.readFile(registryPath, "utf8");
    const parsed = JSON.parse(raw) as { runs?: Record<string, unknown> };
    expect(parsed.runs && Object.keys(parsed.runs)).toContain("run-1");
    const run = parsed.runs?.["run-1"] as
      | {
          requesterOrigin?: { channel?: string; accountId?: string };
        }
      | undefined;
    if (run === undefined) {
      throw new Error("expected persisted run");
    }
    expect("requesterAccountId" in run).toBe(false);
    expect("requesterChannel" in run).toBe(false);
    expect(run.requesterOrigin?.channel).toBe("whatsapp");
    expect(run?.requesterOrigin?.accountId).toBe("acct-main");

    mod.initSubagentRegistry();

    await vi.waitFor(() => expect(announceSpy).toHaveBeenCalled(), {
      timeout: 1_000,
      interval: 10,
    });

    const announceCalls = announceSpy.mock.calls as unknown as Array<[unknown]>;
    const announce = (announceCalls.at(-1)?.[0] ?? undefined) as
      | {
          childRunId?: string;
          childSessionKey?: string;
          requesterSessionKey?: string;
          requesterOrigin?: { channel?: string; accountId?: string };
          task?: string;
          cleanup?: string;
          outcome?: { status?: string };
        }
      | undefined;
    expect(announce?.childRunId).toBe("run-1");
    expect(announce?.childSessionKey).toBe("agent:main:subagent:test");
    expect(announce?.requesterSessionKey).toBe("agent:main:main");
    expect(announce?.requesterOrigin?.channel).toBe("whatsapp");
    expect(announce?.requesterOrigin?.accountId).toBe("acct-main");
    expect(announce?.task).toBe("do the thing");
    expect(announce?.cleanup).toBe("keep");
    expect(announce?.outcome?.status).toBe("ok");

    const restored = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(restored?.childSessionKey).toBe("agent:main:subagent:test");
    expect(restored?.requesterOrigin?.channel).toBe("whatsapp");
    expect(restored?.requesterOrigin?.accountId).toBe("acct-main");
  });

  it("honors restored run timeout fallback from the persisted start time", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.parse("2026-03-24T12:00:00Z");
      vi.setSystemTime(new Date("2026-03-24T12:00:30Z"));
      tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
      process.env.OPENCLAW_STATE_DIR = tempStateDir;
      const registryPath = path.join(tempStateDir, "subagents", "runs.json");
      hoisted.registryPath = registryPath;
      await fs.mkdir(path.dirname(registryPath), { recursive: true });
      await fs.writeFile(
        registryPath,
        `${JSON.stringify(
          {
            version: 2,
            runs: {
              "run-restored-timeout": {
                runId: "run-restored-timeout",
                childSessionKey: "agent:main:subagent:timeout",
                requesterSessionKey: "agent:main:main",
                requesterDisplayKey: "main",
                task: "restored timeout task",
                cleanup: "keep",
                createdAt: startedAt,
                startedAt,
                sessionStartedAt: startedAt,
                runTimeoutSeconds: 8,
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeChildSessionEntry({
        sessionKey: "agent:main:subagent:timeout",
        sessionId: "sess-timeout",
        updatedAt: startedAt,
      });
      vi.mocked(callGatewayModule.callGateway).mockResolvedValue({
        status: "pending",
      });

      mod.initSubagentRegistry();
      await vi.advanceTimersByTimeAsync(0);

      await vi.waitFor(() => expect(announceSpy).toHaveBeenCalled(), {
        timeout: 1_000,
        interval: 10,
      });
      const restored = mod.listSubagentRunsForRequester("agent:main:main")[0];
      expect(restored?.endedAt).toBe(startedAt + 8_000);
      expect(restored?.outcome?.status).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps restored run timeout fallback after a yielded wait snapshot", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.parse("2026-03-24T12:00:00Z");
      vi.setSystemTime(new Date(startedAt));
      tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
      process.env.OPENCLAW_STATE_DIR = tempStateDir;
      const registryPath = path.join(tempStateDir, "subagents", "runs.json");
      hoisted.registryPath = registryPath;
      await fs.mkdir(path.dirname(registryPath), { recursive: true });
      await fs.writeFile(
        registryPath,
        `${JSON.stringify(
          {
            version: 2,
            runs: {
              "run-restored-yield-timeout": {
                runId: "run-restored-yield-timeout",
                childSessionKey: "agent:main:subagent:yield-timeout",
                requesterSessionKey: "agent:main:main",
                requesterDisplayKey: "main",
                task: "restored yielded timeout task",
                cleanup: "keep",
                createdAt: startedAt,
                startedAt,
                sessionStartedAt: startedAt,
                runTimeoutSeconds: 8,
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeChildSessionEntry({
        sessionKey: "agent:main:subagent:yield-timeout",
        sessionId: "sess-yield-timeout",
        updatedAt: startedAt,
      });
      vi.mocked(callGatewayModule.callGateway).mockResolvedValue({
        status: "ok",
        startedAt,
        endedAt: startedAt + 1_000,
        stopReason: "end_turn",
        livenessState: "paused",
        yielded: true,
      });

      mod.initSubagentRegistry();
      await vi.waitFor(() => {
        const restored = mod.listSubagentRunsForRequester("agent:main:main")[0];
        expect(restored?.pauseReason).toBe("sessions_yield");
        expect(restored?.outcome).toBeUndefined();
      });

      await vi.advanceTimersByTimeAsync(22_999);
      expect(announceSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(announceSpy).toHaveBeenCalled(), {
        timeout: 1_000,
        interval: 10,
      });
      const restored = mod.listSubagentRunsForRequester("agent:main:main")[0];
      expect(restored?.pauseReason).toBeUndefined();
      expect(restored?.endedAt).toBe(startedAt + 8_000);
      expect(restored?.outcome?.status).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes run timeout fallback for already-yielded restored runs", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.parse("2026-03-24T12:00:00Z");
      vi.setSystemTime(new Date("2026-03-24T12:00:30Z"));
      tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
      process.env.OPENCLAW_STATE_DIR = tempStateDir;
      const registryPath = path.join(tempStateDir, "subagents", "runs.json");
      hoisted.registryPath = registryPath;
      await fs.mkdir(path.dirname(registryPath), { recursive: true });
      await fs.writeFile(
        registryPath,
        `${JSON.stringify(
          {
            version: 2,
            runs: {
              "run-restored-paused-timeout": {
                runId: "run-restored-paused-timeout",
                childSessionKey: "agent:main:subagent:paused-timeout",
                requesterSessionKey: "agent:main:main",
                requesterDisplayKey: "main",
                task: "restored paused timeout task",
                cleanup: "keep",
                createdAt: startedAt,
                startedAt,
                sessionStartedAt: startedAt,
                endedAt: startedAt + 1_000,
                pauseReason: "sessions_yield",
                runTimeoutSeconds: 8,
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeChildSessionEntry({
        sessionKey: "agent:main:subagent:paused-timeout",
        sessionId: "sess-paused-timeout",
        updatedAt: startedAt + 1_000,
      });

      mod.initSubagentRegistry();
      await vi.advanceTimersByTimeAsync(0);

      await vi.waitFor(() => expect(announceSpy).toHaveBeenCalled(), {
        timeout: 1_000,
        interval: 10,
      });
      const restored = mod.listSubagentRunsForRequester("agent:main:main")[0];
      expect(restored?.pauseReason).toBeUndefined();
      expect(restored?.endedAt).toBe(startedAt + 8_000);
      expect(restored?.outcome?.status).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes replacement run timeout fallback from run start instead of session start", async () => {
    vi.useFakeTimers();
    try {
      const sessionStartedAt = Date.parse("2026-03-24T12:00:00Z");
      const runStartedAt = Date.parse("2026-03-24T12:00:25Z");
      vi.setSystemTime(new Date("2026-03-24T12:00:30Z"));
      tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
      process.env.OPENCLAW_STATE_DIR = tempStateDir;
      const registryPath = path.join(tempStateDir, "subagents", "runs.json");
      hoisted.registryPath = registryPath;
      await fs.mkdir(path.dirname(registryPath), { recursive: true });
      await fs.writeFile(
        registryPath,
        `${JSON.stringify(
          {
            version: 2,
            runs: {
              "run-restored-replacement-timeout": {
                runId: "run-restored-replacement-timeout",
                childSessionKey: "agent:main:subagent:timeout",
                requesterSessionKey: "agent:main:main",
                requesterDisplayKey: "main",
                task: "restored replacement timeout task",
                cleanup: "keep",
                createdAt: runStartedAt,
                startedAt: runStartedAt,
                sessionStartedAt,
                accumulatedRuntimeMs: runStartedAt - sessionStartedAt,
                runTimeoutSeconds: 8,
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeChildSessionEntry({
        sessionKey: "agent:main:subagent:timeout",
        sessionId: "sess-timeout",
        updatedAt: runStartedAt,
      });
      vi.mocked(callGatewayModule.callGateway).mockResolvedValue({
        status: "pending",
      });

      mod.initSubagentRegistry();
      await vi.advanceTimersByTimeAsync(17_999);
      expect(announceSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(announceSpy).toHaveBeenCalled(), {
        timeout: 1_000,
        interval: 10,
      });
      const restored = mod.listSubagentRunsForRequester("agent:main:main")[0];
      expect(restored?.endedAt).toBe(runStartedAt + 8_000);
      expect(restored?.outcome?.status).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});
