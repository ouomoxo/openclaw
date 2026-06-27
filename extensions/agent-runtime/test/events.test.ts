import { describe, it, expect } from "vitest";
import { RuntimeEventFactory } from "../src/events.js";

function factory() {
  let n = 0;
  return new RuntimeEventFactory({
    taskId: "task_1",
    runId: "run_1",
    correlationId: "corr_1",
    uuid: () => `u${++n}`,
    now: () => new Date("2026-06-28T00:00:00Z"),
  });
}

describe("RuntimeEventFactory", () => {
  it("assigns a monotonic per-run sequence", () => {
    const f = factory();
    const a = f.next("RUN_RECEIVED", "info");
    const b = f.next("RUN_PREPARING", "info");
    const c = f.next("RUN_COMPLETED", "info");
    expect([a.sequence, b.sequence, c.sequence]).toEqual([1, 2, 3]);
  });

  it("produces unique event ids and a stable envelope", () => {
    const f = factory();
    const a = f.next("RUN_RECEIVED", "info", { foo: 1 });
    const b = f.next("RUN_PREPARING", "info");
    expect(a.eventId).not.toBe(b.eventId);
    expect(a.version).toBe("0.1");
    expect(a.taskId).toBe("task_1");
    expect(a.runId).toBe("run_1");
    expect(a.correlationId).toBe("corr_1");
    expect(a.payload).toEqual({ foo: 1 });
    expect(a.createdAt).toBe("2026-06-28T00:00:00.000Z");
  });
});
