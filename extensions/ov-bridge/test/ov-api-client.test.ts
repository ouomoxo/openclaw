import type { CreateTaskRequest } from "@ouomoxo/ov-agent-contracts";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createOvApiClient, type OvApiClient } from "../src/client/ov-api-client.js";
import type { OvBridgeConfig } from "../src/types.js";
import { startMockOvServer, type MockOvServerHandle } from "../test-support/mock-ov-server.js";

let mock: MockOvServerHandle;

beforeAll(async () => {
  mock = await startMockOvServer({ expectedToken: "test-token" });
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.reset();
});

function makeConfig(overrides: Partial<OvBridgeConfig> = {}): OvBridgeConfig {
  return {
    apiBaseUrl: mock.url,
    serviceToken: "test-token",
    contractVersion: "1.0",
    requestTimeoutMs: 1_000,
    maxRetries: 2,
    ...overrides,
  };
}

function makeClient(overrides: Partial<OvBridgeConfig> = {}): OvApiClient {
  // Instant backoff + deterministic jitter for fast retry tests.
  return createOvApiClient(makeConfig(overrides), { sleep: async () => {}, rng: () => 0 });
}

function makeReq(p: {
  correlationId: string;
  idempotencyKey: string;
  objective?: string;
  projectKey?: string;
}): CreateTaskRequest {
  return {
    contractVersion: "1.0",
    metadata: {
      correlationId: p.correlationId,
      idempotencyKey: p.idempotencyKey,
      sentAt: "2026-06-27T12:00:00Z",
    },
    source: { channel: "telegram", userId: "u1" },
    project: { projectKey: p.projectKey ?? "ov" },
    task: { title: "t", objective: p.objective ?? "o", rawInstruction: "r" },
  };
}

describe("OV API client — success", () => {
  it("creates a task (201, deduplicated false)", async () => {
    const r = await makeClient().createTask(
      makeReq({ correlationId: "c1", idempotencyKey: "k1" }),
      {
        correlationId: "c1",
        idempotencyKey: "k1",
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.taskId).toMatch(/^task_mock_/);
    expect(r.deduplicated).toBe(false);
    expect(r.httpStatus).toBe(201);
    expect(r.correlationId).toBe("c1");
  });

  it("returns the same taskId for a repeated idempotency key (200, deduplicated true)", async () => {
    const client = makeClient();
    const first = await client.createTask(makeReq({ correlationId: "c1", idempotencyKey: "k1" }), {
      correlationId: "c1",
      idempotencyKey: "k1",
    });
    const second = await client.createTask(makeReq({ correlationId: "c2", idempotencyKey: "k1" }), {
      correlationId: "c2",
      idempotencyKey: "k1",
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(second.deduplicated).toBe(true);
    expect(second.httpStatus).toBe(200);
    expect(second.taskId).toBe(first.taskId);
  });

  it("returns 409 IDEMPOTENCY_CONFLICT for same key + different payload", async () => {
    const client = makeClient();
    await client.createTask(
      makeReq({ correlationId: "c1", idempotencyKey: "k1", objective: "first" }),
      { correlationId: "c1", idempotencyKey: "k1" },
    );
    const conflict = await client.createTask(
      makeReq({ correlationId: "c2", idempotencyKey: "k1", objective: "second-different" }),
      { correlationId: "c2", idempotencyKey: "k1" },
    );
    expect(conflict.ok).toBe(false);
    if (conflict.ok) {
      return;
    }
    expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(conflict.retryable).toBe(false);
  });
});

describe("OV API client — error mapping", () => {
  const cases: Array<[Parameters<MockOvServerHandle["setScenario"]>[0], string]> = [
    ["unauthorized", "AUTHENTICATION_ERROR"],
    ["forbidden", "AUTHORIZATION_ERROR"],
    ["project-not-found", "PROJECT_NOT_FOUND"],
    ["version-unsupported", "CONTRACT_VERSION_ERROR"],
  ];
  for (const [scenario, code] of cases) {
    it(`${scenario} -> ${code}`, async () => {
      mock.setScenario(scenario);
      const r = await makeClient({ maxRetries: 0 }).createTask(
        makeReq({ correlationId: "c1", idempotencyKey: "k1" }),
        { correlationId: "c1", idempotencyKey: "k1" },
      );
      expect(r.ok).toBe(false);
      if (r.ok) {
        return;
      }
      expect(r.code).toBe(code);
      expect(r.retryable).toBe(false);
    });
  }

  it("malformed JSON success body -> INVALID_RESPONSE", async () => {
    mock.setScenario("malformed-json");
    const r = await makeClient({ maxRetries: 0 }).createTask(
      makeReq({ correlationId: "c1", idempotencyKey: "k1" }),
      { correlationId: "c1", idempotencyKey: "k1" },
    );
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.code).toBe("INVALID_RESPONSE");
  });

  it("schema-invalid success body -> INVALID_RESPONSE", async () => {
    mock.setScenario("invalid-contract-response");
    const r = await makeClient({ maxRetries: 0 }).createTask(
      makeReq({ correlationId: "c1", idempotencyKey: "k1" }),
      { correlationId: "c1", idempotencyKey: "k1" },
    );
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.code).toBe("INVALID_RESPONSE");
  });

  it("correlation mismatch -> INVALID_RESPONSE", async () => {
    mock.setScenario("correlation-mismatch");
    const r = await makeClient({ maxRetries: 0 }).createTask(
      makeReq({ correlationId: "c1", idempotencyKey: "k1" }),
      { correlationId: "c1", idempotencyKey: "k1" },
    );
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.code).toBe("INVALID_RESPONSE");
  });

  it("times out -> TIMEOUT", async () => {
    mock.setScenario("delay");
    const client = createOvApiClient(makeConfig({ requestTimeoutMs: 40, maxRetries: 0 }), {
      sleep: async () => {},
      rng: () => 0,
    });
    const r = await client.createTask(makeReq({ correlationId: "c1", idempotencyKey: "k1" }), {
      correlationId: "c1",
      idempotencyKey: "k1",
    });
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.code).toBe("TIMEOUT");
  });

  it("never leaks the service token in a failure result", async () => {
    mock.setScenario("forbidden");
    const r = await makeClient({ maxRetries: 0 }).createTask(
      makeReq({ correlationId: "c1", idempotencyKey: "k1" }),
      { correlationId: "c1", idempotencyKey: "k1" },
    );
    expect(JSON.stringify(r)).not.toContain("test-token");
  });
});

describe("OV API client — retry", () => {
  it("retries a 503 then succeeds (same idempotency key reused)", async () => {
    mock.queueScenarios("unavailable");
    const r = await makeClient({ maxRetries: 2 }).createTask(
      makeReq({ correlationId: "c1", idempotencyKey: "k1" }),
      { correlationId: "c1", idempotencyKey: "k1" },
    );
    expect(r.ok).toBe(true);
    expect(mock.requests.length).toBe(2);
    expect(mock.requests[0]?.idempotencyHeader).toBe(mock.requests[1]?.idempotencyHeader);
    expect(mock.requests[0]?.correlationHeader).toBe(mock.requests[1]?.correlationHeader);
  });

  it("retries a retryable 429 up to maxRetries then fails", async () => {
    mock.setScenario("rate-limited");
    const r = await makeClient({ maxRetries: 2 }).createTask(
      makeReq({ correlationId: "c1", idempotencyKey: "k1" }),
      { correlationId: "c1", idempotencyKey: "k1" },
    );
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.code).toBe("RATE_LIMITED");
    expect(mock.requests.length).toBe(3); // 1 + 2 retries
  });

  it("does not retry a 4xx", async () => {
    mock.setScenario("forbidden");
    await makeClient({ maxRetries: 2 }).createTask(
      makeReq({ correlationId: "c1", idempotencyKey: "k1" }),
      { correlationId: "c1", idempotencyKey: "k1" },
    );
    expect(mock.requests.length).toBe(1);
  });

  it("does not send or retry when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await makeClient({ maxRetries: 2 }).createTask(
      makeReq({ correlationId: "c1", idempotencyKey: "k1" }),
      {
        correlationId: "c1",
        idempotencyKey: "k1",
        signal: controller.signal,
      },
    );
    expect(r.ok).toBe(false);
    expect(mock.requests.length).toBe(0);
  });
});

describe("Mock OV idempotency (contract fingerprint)", () => {
  it("same key + only sentAt/correlationId changed -> same taskId (dedup)", async () => {
    const client = makeClient();
    const a = await client.createTask(makeReq({ correlationId: "cA", idempotencyKey: "k1" }), {
      correlationId: "cA",
      idempotencyKey: "k1",
    });
    // different correlationId + sentAt, same business payload + key
    const reqB = makeReq({ correlationId: "cB", idempotencyKey: "k1" });
    reqB.metadata.sentAt = "2030-01-01T00:00:00Z";
    const b = await client.createTask(reqB, { correlationId: "cB", idempotencyKey: "k1" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) {
      return;
    }
    expect(b.deduplicated).toBe(true);
    expect(b.taskId).toBe(a.taskId);
  });

  it("different key + same payload -> new taskId", async () => {
    const client = makeClient();
    const a = await client.createTask(makeReq({ correlationId: "cA", idempotencyKey: "k1" }), {
      correlationId: "cA",
      idempotencyKey: "k1",
    });
    const b = await client.createTask(makeReq({ correlationId: "cB", idempotencyKey: "k2" }), {
      correlationId: "cB",
      idempotencyKey: "k2",
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) {
      return;
    }
    expect(b.taskId).not.toBe(a.taskId);
    expect(b.deduplicated).toBe(false);
  });
});
