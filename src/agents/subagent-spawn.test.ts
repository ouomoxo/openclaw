import os from "node:os";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  expectPersistedRuntimeModel,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";
import { installAcceptedSubagentGatewayMock } from "./test-helpers/subagent-gateway.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  pruneLegacyStoreKeysMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  armSubagentRunTimeoutMock: vi.fn(),
  releaseSubagentRunMock: vi.fn(),
  discardFailedSubagentSpawnRunMock: vi.fn(),
  listSubagentRunsForRequesterMock: vi.fn(),
  emitSessionLifecycleEventMock: vi.fn(),
  resolveAgentConfigMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
}));

let resetSubagentRegistryForTests: typeof import("./subagent-registry.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

function createConfigOverride(overrides?: Record<string, unknown>) {
  return createSubagentSpawnTestConfig(os.tmpdir(), {
    agents: {
      defaults: {
        workspace: os.tmpdir(),
      },
      list: [
        {
          id: "main",
          workspace: "/tmp/workspace-main",
        },
      ],
    },
    ...overrides,
  });
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
  return value as Record<string, unknown>;
}

function gatewayRequestRecords(): Record<string, unknown>[] {
  return hoisted.callGatewayMock.mock.calls.map((call) => requireRecord(call[0]));
}

function gatewayRequest(method: string): Record<string, unknown> {
  const request = gatewayRequestRecords().find((entry) => entry.method === method);
  return requireRecord(request);
}

function firstRegisteredSubagentRun(): Record<string, unknown> {
  return requireRecord(hoisted.registerSubagentRunMock.mock.calls[0]?.[0]);
}

describe("spawnSubagentDirect seam flow", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      getRuntimeConfig: () => hoisted.configOverride,
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      pruneLegacyStoreKeysMock: hoisted.pruneLegacyStoreKeysMock,
      registerSubagentRunMock: hoisted.registerSubagentRunMock,
      armSubagentRunTimeoutMock: hoisted.armSubagentRunTimeoutMock,
      releaseSubagentRunMock: hoisted.releaseSubagentRunMock,
      discardFailedSubagentSpawnRunMock: hoisted.discardFailedSubagentSpawnRunMock,
      listSubagentRunsForRequesterMock: hoisted.listSubagentRunsForRequesterMock,
      emitSessionLifecycleEventMock: hoisted.emitSessionLifecycleEventMock,
      resolveAgentConfig: hoisted.resolveAgentConfigMock,
      resolveSubagentSpawnModelSelection: () => "openai-codex/gpt-5.4",
      resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
      sessionStorePath: "/tmp/subagent-spawn-session-store.json",
      resetModules: false,
    }));
  });

  beforeEach(() => {
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockReset();
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.pruneLegacyStoreKeysMock.mockReset();
    hoisted.registerSubagentRunMock.mockReset();
    hoisted.armSubagentRunTimeoutMock.mockReset();
    hoisted.releaseSubagentRunMock.mockReset();
    hoisted.discardFailedSubagentSpawnRunMock.mockReset();
    hoisted.listSubagentRunsForRequesterMock.mockReset().mockReturnValue([]);
    hoisted.emitSessionLifecycleEventMock.mockReset();
    hoisted.resolveAgentConfigMock.mockReset();
    hoisted.resolveAgentConfigMock.mockImplementation(
      (cfg: { agents?: { list?: Array<{ id?: string }> } }, agentId: string) =>
        cfg.agents?.list?.find((agent) => agent.id === agentId),
    );
    hoisted.configOverride = createConfigOverride();
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);

    hoisted.updateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        const store: Record<string, Record<string, unknown>> = {};
        await mutator(store);
        return store;
      },
    );
  });

  it("rejects explicit same-agent targets when allowAgents excludes the requester", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
        },
        list: [
          {
            id: "task-manager",
            workspace: "/tmp/workspace-task-manager",
            subagents: {
              allowAgents: ["planner"],
            },
          },
          {
            id: "planner",
            workspace: "/tmp/workspace-planner",
          },
        ],
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "spawn myself explicitly",
        agentId: "task-manager",
      },
      {
        agentSessionKey: "agent:task-manager:main",
      },
    );

    expect(result.status).toBe("forbidden");
    expect(result.error).toBe("agentId is not allowed for sessions_spawn (allowed: planner)");
    expect(gatewayRequestRecords().some((request) => request.method === "agent")).toBe(false);
  });

  it("allows omitted agentId to default to requester even when allowAgents excludes requester", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
        },
        list: [
          {
            id: "task-manager",
            workspace: "/tmp/workspace-task-manager",
            subagents: {
              allowAgents: ["planner"],
            },
          },
          {
            id: "planner",
            workspace: "/tmp/workspace-planner",
          },
        ],
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "spawn default target",
      },
      {
        agentSessionKey: "agent:task-manager:main",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.childSessionKey).toMatch(/^agent:task-manager:subagent:/);
  });

  it("accepts a spawned run across session patching, runtime-model persistence, registry registration, and lifecycle emission", async () => {
    const operations: string[] = [];
    let persistedStore: Record<string, Record<string, unknown>> | undefined;

    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: { idempotencyKey?: string } }) => {
        operations.push(`gateway:${request.method ?? "unknown"}`);
        if (request.method === "agent") {
          return { runId: request.params?.idempotencyKey ?? "run-1" };
        }
        if (request.method?.startsWith("sessions.")) {
          return { ok: true };
        }
        return {};
      },
    );
    hoisted.registerSubagentRunMock.mockImplementation((record: unknown) => {
      operations.push("register");
      return record;
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      operations,
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inspect the spawn seam",
        model: "openai-codex/gpt-5.4",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
        agentThreadId: 42,
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.runId).toEqual(expect.any(String));
    expect(result.mode).toBe("run");
    expect(result.modelApplied).toBe(true);
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:/);

    const childSessionKey = result.childSessionKey as string;
    expect(hoisted.pruneLegacyStoreKeysMock).toHaveBeenCalledTimes(3);
    expect(hoisted.updateSessionStoreMock).toHaveBeenCalledTimes(3);
    const registerInput = firstRegisteredSubagentRun();
    const requesterOrigin = requireRecord(registerInput.requesterOrigin);
    expect(registerInput.runId).toBe(result.runId);
    expect(registerInput.childSessionKey).toBe(childSessionKey);
    expect(registerInput.requesterSessionKey).toBe("agent:main:main");
    expect(registerInput.requesterDisplayKey).toBe("agent:main:main");
    expect(requesterOrigin.channel).toBe("discord");
    expect(requesterOrigin.accountId).toBe("acct-1");
    expect(requesterOrigin.to).toBe("user-1");
    expect(requesterOrigin.threadId).toBe(42);
    expect(registerInput.task).toBe("inspect the spawn seam");
    expect(registerInput.cleanup).toBe("keep");
    expect(registerInput.model).toBe("openai-codex/gpt-5.4");
    expect(registerInput.workspaceDir).toBe("/tmp/requester-workspace");
    expect(operations.indexOf("register")).toBeLessThan(operations.indexOf("gateway:agent"));
    expect(registerInput.expectsCompletionMessage).toBe(true);
    expect(registerInput.spawnMode).toBe("run");
    expect(hoisted.emitSessionLifecycleEventMock).toHaveBeenCalledWith({
      sessionKey: childSessionKey,
      reason: "create",
      parentSessionKey: "agent:main:main",
      label: undefined,
    });

    expectPersistedRuntimeModel({
      persistedStore,
      sessionKey: childSessionKey,
      provider: "openai-codex",
      model: "gpt-5.4",
      overrideSource: "user",
    });
    expect(operations.indexOf("store:update")).toBeGreaterThan(-1);
    expect(operations.indexOf("gateway:agent")).toBeGreaterThan(
      operations.lastIndexOf("store:update"),
    );
    const agentRequest = gatewayRequest("agent");
    const agentParams = requireRecord(agentRequest.params);
    expect(agentParams.sessionKey).toBe(childSessionKey);
    expect(agentParams.cleanupBundleMcpOnRunEnd).toBe(true);
  });

  it("preserves a terminal pre-registered run when the child agent RPC fails late", async () => {
    let registeredRunId: string | undefined;
    hoisted.registerSubagentRunMock.mockImplementation((record: unknown) => {
      const run = requireRecord(record);
      registeredRunId = typeof run.runId === "string" ? run.runId : undefined;
      hoisted.listSubagentRunsForRequesterMock.mockReturnValue([
        {
          ...run,
          endedAt: Date.parse("2026-03-24T12:00:08Z"),
          outcome: { status: "timeout" },
        },
      ]);
      return record;
    });
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        throw new Error("late child rpc failure");
      }
      if (request.method?.startsWith("sessions.")) {
        return { ok: true };
      }
      return {};
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "preserve terminal timeout",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.runId).toBe(registeredRunId);
    expect(hoisted.releaseSubagentRunMock).not.toHaveBeenCalled();
    expect(gatewayRequestRecords().some((request) => request.method === "sessions.delete")).toBe(
      false,
    );
  });

  it("discards a pre-registered run without release semantics when the child agent RPC fails before acceptance", async () => {
    let registeredRunId: string | undefined;
    hoisted.registerSubagentRunMock.mockImplementation((record: unknown) => {
      const run = requireRecord(record);
      registeredRunId = typeof run.runId === "string" ? run.runId : undefined;
      hoisted.listSubagentRunsForRequesterMock.mockReturnValue([run]);
      return record;
    });
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        throw new Error("child rpc rejected before acceptance");
      }
      if (request.method?.startsWith("sessions.")) {
        return { ok: true };
      }
      return {};
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "fail before acceptance",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("error");
    expect(result.runId).toBe(registeredRunId);
    expect(hoisted.discardFailedSubagentSpawnRunMock).toHaveBeenCalledWith(registeredRunId);
    expect(hoisted.releaseSubagentRunMock).not.toHaveBeenCalled();
    expect(gatewayRequestRecords().some((request) => request.method === "sessions.delete")).toBe(
      true,
    );
  });

  it("registers explicit run timeout before the child agent RPC returns", async () => {
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "arm timeout after accepted",
        runTimeoutSeconds: 8,
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    const registerInput = firstRegisteredSubagentRun();
    expect(registerInput.runTimeoutSeconds).toBe(8);
    expect(hoisted.armSubagentRunTimeoutMock).toHaveBeenCalledWith({
      runId: result.runId,
      runTimeoutSeconds: 8,
      startedAt: undefined,
    });
  });

  it("keeps the child agent RPC alive through explicit timeout reconciliation", async () => {
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "long timeout fallback ordering",
        runTimeoutSeconds: 120,
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    const agentRequest = gatewayRequest("agent");
    expect(agentRequest.timeoutMs).toBe(140_000);
  });

  it("keeps controller ownership separate from completion ownership", async () => {
    await spawnSubagentDirect(
      {
        task: "background work",
      },
      {
        agentSessionKey: "agent:main:telegram:default:direct:456",
        completionOwnerKey: "agent:main:main",
        agentChannel: "telegram",
        agentAccountId: "default",
        agentTo: "telegram:direct:456",
      },
    );

    const registerInput = firstRegisteredSubagentRun();
    expect(registerInput.controllerSessionKey).toBe("agent:main:telegram:default:direct:456");
    expect(registerInput.requesterSessionKey).toBe("agent:main:main");
    expect(registerInput.requesterDisplayKey).toBe("agent:main:main");
  });

  it("keeps spawn cwd separate from inherited agent workspace", async () => {
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "work in the requested repo",
        cwd: "/tmp/task-repo",
      },
      {
        agentSessionKey: "agent:main:main",
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result.status).toBe("accepted");
    const childSessionKey = result.childSessionKey as string;
    const childEntry = persistedStore?.[childSessionKey];
    expect(childEntry?.spawnedWorkspaceDir).toBe("/tmp/requester-workspace");
    expect(childEntry?.spawnedCwd).toBe("/tmp/task-repo");

    const agentRequest = gatewayRequest("agent");
    const agentParams = requireRecord(agentRequest.params);
    expect(agentParams).not.toHaveProperty("cwd");
    expect(agentParams).not.toHaveProperty("workspaceDir");
  });

  it("omits requesterOrigin threadId when no requester thread is provided", async () => {
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        return { runId: "run-1" };
      }
      if (request.method?.startsWith("sessions.")) {
        return { ok: true };
      }
      return {};
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "inspect unthreaded spawn",
        model: "openai-codex/gpt-5.4",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
      },
    );

    expect(result.status).toBe("accepted");
    const registerInput = firstRegisteredSubagentRun();
    const requesterOrigin = requireRecord(registerInput.requesterOrigin);
    expect(requesterOrigin.channel).toBe("discord");
    expect(requesterOrigin.accountId).toBe("acct-1");
    expect(requesterOrigin.to).toBe("user-1");
    expect(requesterOrigin).not.toHaveProperty("threadId");
  });

  it("pins admin-only methods to operator.admin and preserves least-privilege for others (#59428)", async () => {
    const capturedCalls: Array<{ method?: string; scopes?: string[] }> = [];

    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; scopes?: string[] }) => {
        capturedCalls.push({ method: request.method, scopes: request.scopes });
        if (request.method === "agent") {
          return { runId: "run-1" };
        }
        if (request.method?.startsWith("sessions.")) {
          return { ok: true };
        }
        return {};
      },
    );
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "verify per-method scope routing",
        model: "openai-codex/gpt-5.4",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result.status).toBe("accepted");
    expect(capturedCalls.length).toBeGreaterThan(0);

    for (const call of capturedCalls) {
      if (call.method === "sessions.patch" || call.method === "sessions.delete") {
        // Admin-only methods must be pinned to operator.admin.
        expect(call.scopes).toEqual(["operator.admin"]);
      } else {
        // Non-admin methods (e.g. "agent") must NOT be forced to admin scope.
        expect(call.scopes).toBeUndefined();
      }
    }
  });

  it("forwards normalized thinking to the agent run", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        calls.push(request);
        if (request.method === "agent") {
          return { runId: "run-thinking", status: "accepted", acceptedAt: 1000 };
        }
        if (request.method?.startsWith("sessions.")) {
          return { ok: true };
        }
        return {};
      },
    );
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "verify thinking forwarding",
        thinking: "high",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result.status).toBe("accepted");
    const agentCall = calls.find((call) => call.method === "agent");
    const params = requireRecord(agentCall?.params);
    expect(params.thinking).toBe("high");
  });

  it("does not duplicate long subagent task text in the initial user message (#72019)", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        calls.push(request);
        if (request.method === "agent") {
          return { runId: "run-no-dup", status: "accepted", acceptedAt: 1000 };
        }
        if (request.method?.startsWith("sessions.")) {
          return { ok: true };
        }
        return {};
      },
    );
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const task = "UNIQUE_LONG_SUBAGENT_TASK_TOKEN\n  keep indentation";
    const result = await spawnSubagentDirect(
      {
        task,
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result.status).toBe("accepted");
    const agentCall = calls.find((call) => call.method === "agent");
    const params = agentCall?.params as { message?: string; extraSystemPrompt?: string };
    expect(params.message).toContain("[Subagent Task]");
    expect(params.message).toContain("UNIQUE_LONG_SUBAGENT_TASK_TOKEN");
    expect(params.message).toContain("  keep indentation");
    expect(params.message).not.toContain("**Your Role**");
    expect(params.extraSystemPrompt).toBe("system-prompt");
  });

  it("returns an error when the initial child session patch is rejected", async () => {
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        if (request.method === "agent") {
          return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
        }
        if (request.method === "sessions.delete") {
          return { ok: true };
        }
        return {};
      },
    );
    hoisted.updateSessionStoreMock.mockRejectedValueOnce(new Error("invalid model: bad-model"));

    const result = await spawnSubagentDirect(
      {
        task: "verify patch rejection",
        model: "bad-model",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result.status).toBe("error");
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:/);
    expect(result.error ?? "").toContain("invalid model");
    expect(
      hoisted.callGatewayMock.mock.calls.some(
        (call) => (call[0] as { method?: string }).method === "agent",
      ),
    ).toBe(false);
  });
});
