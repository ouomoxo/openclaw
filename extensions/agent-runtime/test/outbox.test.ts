import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { RuntimeEventFactory, type RuntimeEvent } from "../src/events.js";
import { createInMemoryOutboxStore, createSqliteOutboxStore, flushOutbox } from "../src/outbox.js";
import { createMockReceiver } from "../src/receiver.js";

function makeEvents(count: number): RuntimeEvent[] {
  let n = 0;
  const f = new RuntimeEventFactory({
    taskId: "t",
    runId: "r",
    correlationId: "c",
    uuid: () => `u${++n}`,
    now: () => new Date("2026-06-28T00:00:00Z"),
  });
  return Array.from({ length: count }, (_v, i) => f.next("COMMAND_COMPLETED", "info", { i }));
}

describe("OutboxStore (in-memory)", () => {
  it("appends durably (before delivery), dedupes, and lists in sequence order", () => {
    const store = createInMemoryOutboxStore();
    const [e1, e2] = makeEvents(2);
    store.append(e2);
    store.append(e1);
    store.append(e1); // dedup
    expect(store.all().length).toBe(2);
    // crash-consistency: appended events are durably pending before any delivery
    expect(store.countPending()).toBe(2);
    const pending = store.listPending(Date.now(), 10);
    expect(pending.map((r) => r.event.sequence)).toEqual([1, 2]);
  });
});

describe("flushOutbox", () => {
  it("delivers all pending events in order", async () => {
    const store = createInMemoryOutboxStore();
    for (const e of makeEvents(3)) {
      store.append(e);
    }
    const receiver = createMockReceiver();
    const summary = await flushOutbox({ store, receiver, maxAttempts: 3, now: () => 0 });
    expect(summary.delivered).toBe(3);
    expect(receiver.received.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(store.countPending()).toBe(0);
  });

  it("retries a transient failure then delivers (same event id preserved)", async () => {
    const store = createInMemoryOutboxStore();
    const [e1] = makeEvents(1);
    store.append(e1);
    const receiver = createMockReceiver({ failTimes: 1, failScenario: "unavailable" });
    let clock = 0;
    const first = await flushOutbox({
      store,
      receiver,
      maxAttempts: 3,
      now: () => clock,
      rng: () => 0,
    });
    expect(first.retried).toBe(1);
    expect(store.countPending()).toBe(1);
    clock = 10_000; // past nextAttemptAt
    const second = await flushOutbox({
      store,
      receiver,
      maxAttempts: 3,
      now: () => clock,
      rng: () => 0,
    });
    expect(second.delivered).toBe(1);
    expect(receiver.received[0].eventId).toBe(e1.eventId);
  });

  it("dead-letters a permanent failure without retrying", async () => {
    const store = createInMemoryOutboxStore();
    store.append(makeEvents(1)[0]);
    const receiver = createMockReceiver({ failTimes: 99, failScenario: "invalid-schema" });
    const summary = await flushOutbox({ store, receiver, maxAttempts: 5, now: () => 0 });
    expect(summary.deadLettered).toBe(1);
    expect(store.all()[0].status).toBe("dead-letter");
  });

  it("dead-letters after exceeding maxAttempts on a retryable failure", async () => {
    const store = createInMemoryOutboxStore();
    store.append(makeEvents(1)[0]);
    const receiver = createMockReceiver({ failTimes: 99, failScenario: "unavailable" });
    let clock = 0;
    for (let i = 0; i < 3; i += 1) {
      await flushOutbox({ store, receiver, maxAttempts: 2, now: () => clock, rng: () => 0 });
      clock += 100_000;
    }
    expect(store.all()[0].status).toBe("dead-letter");
  });

  it("accepts duplicate delivery idempotently at the receiver", async () => {
    const receiver = createMockReceiver();
    const [e1] = makeEvents(1);
    await receiver.send(e1);
    await receiver.send(e1);
    expect(receiver.received.length).toBe(2);
    expect(receiver.uniqueEventIds().length).toBe(1);
  });
});

describe("SQLite outbox (durable, restart-recoverable)", () => {
  it("recovers pending events after a simulated restart", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "ar-outbox-")), "outbox.sqlite");
    const store = createSqliteOutboxStore(dbPath);
    for (const e of makeEvents(2)) {
      store.append(e);
    }
    // delivery fails → events stay pending and durable
    const receiver = createMockReceiver({ failTimes: 99, failScenario: "network" });
    await flushOutbox({ store, receiver, maxAttempts: 5, now: () => 0, rng: () => 0 });
    expect(store.countPending()).toBe(2);

    // simulate restart: new store handle on the same db file
    const recovered = createSqliteOutboxStore(dbPath);
    expect(recovered.countPending()).toBe(2);
    expect(recovered.all().map((r) => r.event.sequence)).toEqual([1, 2]);
  });
});
