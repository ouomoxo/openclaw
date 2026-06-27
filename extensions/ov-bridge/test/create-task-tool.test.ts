import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pluginEntry from "../index.js";
import { createOvApiClient } from "../src/client/ov-api-client.js";
import {
  runCreateTask,
  createOvCreateTaskTool,
  type CreateTaskToolDeps,
} from "../src/tools/create-task.js";
import type { OvBridgeConfig, OvCreateTaskToolInput } from "../src/types.js";
import { startMockOvServer, type MockOvServerHandle } from "../test-support/mock-ov-server.js";

let mock: MockOvServerHandle;

beforeAll(async () => {
  mock = await startMockOvServer({ expectedToken: "test-token" });
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => mock.reset());

function config(): OvBridgeConfig {
  return {
    apiBaseUrl: mock.url,
    serviceToken: "test-token",
    contractVersion: "1.0",
    requestTimeoutMs: 1_000,
    maxRetries: 0,
  };
}

function deps(overrides: Partial<CreateTaskToolDeps> = {}): CreateTaskToolDeps {
  let n = 0;
  return {
    resolveConfig: () => ({ ok: true, config: config() }),
    createClient: (cfg) => createOvApiClient(cfg, { sleep: async () => {}, rng: () => 0 }),
    now: () => new Date("2026-06-27T12:00:00.000Z"),
    uuid: () => `u${++n}`,
    ...overrides,
  };
}

function input(overrides: Partial<OvCreateTaskToolInput> = {}): OvCreateTaskToolInput {
  return {
    title: "Fix login session expiry",
    objective: "Reproduce and fix the session expiry bug with a regression test",
    rawInstruction: "OV 로그인 세션 만료 오류 분석하고 고쳐줘",
    projectKey: "ov",
    source: { channel: "telegram", userId: "123", channelId: "555", messageId: "777" },
    ...overrides,
  };
}

describe("runCreateTask", () => {
  it("creates a task and returns the taskId", async () => {
    const out = await runCreateTask(input(), deps());
    expect(out.ok).toBe(true);
    if (!out.ok) {
      return;
    }
    expect(out.taskId).toMatch(/^task_mock_/);
    expect(out.status).toBe("RECEIVED");
    expect(out.deduplicated).toBe(false);
    expect(out.correlationId).toBe("corr_u1");
    expect(out.message).toContain(out.taskId);
  });

  it("derives a stable idempotency key from telegram message identity", async () => {
    await runCreateTask(input(), deps());
    expect(mock.requests[0]?.idempotencyHeader).toBe("telegram:555:777:create-task");
  });

  it("dedupes a repeated message (same channel+message id)", async () => {
    const first = await runCreateTask(input(), deps());
    const second = await runCreateTask(input(), deps());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(second.deduplicated).toBe(true);
    expect(second.taskId).toBe(first.taskId);
  });

  it("returns CONFIGURATION_ERROR when config is missing (no network call)", async () => {
    const out = await runCreateTask(
      input(),
      deps({
        resolveConfig: () => ({ ok: false, code: "CONFIGURATION_ERROR", message: "missing" }),
      }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) {
      return;
    }
    expect(out.code).toBe("CONFIGURATION_ERROR");
    expect(mock.requests.length).toBe(0);
  });

  it("returns REQUEST_VALIDATION_ERROR for missing project (no network call)", async () => {
    const bad = input();
    delete (bad as { projectKey?: string }).projectKey;
    const out = await runCreateTask(bad, deps());
    expect(out.ok).toBe(false);
    if (out.ok) {
      return;
    }
    expect(out.code).toBe("REQUEST_VALIDATION_ERROR");
    expect(mock.requests.length).toBe(0);
  });

  it("never leaks the service token in the tool output", async () => {
    const out = await runCreateTask(input(), deps());
    expect(JSON.stringify(out)).not.toContain("test-token");
  });
});

describe("plugin registration", () => {
  it("registers ov_create_task via the plugin entry", () => {
    let registeredNames: string[] | undefined;
    let toolName: string | undefined;
    let toolDescription: string | undefined;
    const fakeApi = {
      pluginConfig: {},
      registerTool(factory: (ctx: unknown) => unknown[], opts: { names?: string[] }) {
        registeredNames = opts.names;
        const tools = factory(undefined) as Array<{ name: string; description: string }>;
        toolName = tools[0]?.name;
        toolDescription = tools[0]?.description;
      },
    };
    (pluginEntry as { register: (api: unknown) => void }).register(fakeApi);
    expect(registeredNames).toEqual(["ov_create_task"]);
    expect(toolName).toBe("ov_create_task");
    expect(toolDescription).toContain("OV Control Plane");
  });

  it("the built tool has a TypeBox parameters schema", () => {
    const tool = createOvCreateTaskTool(deps());
    expect(tool.name).toBe("ov_create_task");
    expect(typeof tool.parameters).toBe("object");
  });
});
