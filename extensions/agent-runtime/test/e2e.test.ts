/** R9 mock orchestration E2E. fixture/temp repositories only; deterministic FakeExecutor; no real provider. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { createSqliteOutboxStore, flushOutbox } from "../src/outbox.js";
import type { ProcessRunSpec } from "../src/process-runner.js";
import { createMockReceiver } from "../src/receiver.js";
import { inspectRecovery, runWorker } from "../src/worker.js";
import { FakeExecutor, makeHarness, makeRuntimeInput } from "./runtime-harness.js";

describe("E2E: successful worker run", () => {
  it("creates a worktree, leaves the main tree untouched, passes tests, emits ordered events, delivers them", async () => {
    const h = makeHarness();
    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: h.repoRoot,
      encoding: "utf8",
    }).trim();
    const result = await runWorker(makeRuntimeInput(h.repoRoot), h.deps);
    expect(result.status).toBe("completed");
    // main working tree untouched
    expect(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: h.repoRoot, encoding: "utf8" }).trim(),
    ).toBe(headBefore);
    expect(
      execFileSync("git", ["status", "--porcelain"], { cwd: h.repoRoot, encoding: "utf8" }).trim(),
    ).toBe("");
    expect(result.artifacts.length).toBeGreaterThan(0);
    expect(h.receiver.received.some((e) => e.type === "RUN_COMPLETED")).toBe(true);
    expect(result.events.map((e) => e.sequence)).toEqual(
      [...result.events.keys()].map((i) => i + 1),
    );
  });
});

describe("E2E: delivery retry + durability", () => {
  it("keeps events durable on transient failure; a later flush delivers them with ids/sequence preserved", async () => {
    const failing = createMockReceiver({ failTimes: 999, failScenario: "unavailable" });
    const h = makeHarness({ receiver: failing });
    await runWorker(makeRuntimeInput(h.repoRoot), h.deps);
    // events were not lost — still pending/durable in the outbox
    expect(h.outbox.countPending()).toBeGreaterThan(0);
    const pendingSeqs = h.outbox
      .all()
      .filter((r) => r.status === "pending")
      .map((r) => r.event.sequence);

    // a later flush with a healthy receiver delivers them, preserving id + sequence
    const healthy = createMockReceiver();
    const clock = Date.parse("2026-06-28T01:00:00Z");
    const summary = await flushOutbox({
      store: h.outbox,
      receiver: healthy,
      maxAttempts: 5,
      now: () => clock,
      rng: () => 0,
    });
    expect(summary.delivered).toBe(pendingSeqs.length);
    expect(h.outbox.countPending()).toBe(0);
    // duplicate delivery tolerated by the idempotent receiver
    await flushOutbox({
      store: h.outbox,
      receiver: healthy,
      maxAttempts: 5,
      now: () => clock,
      rng: () => 0,
    });
  });
});

describe("E2E: restart recovery (sqlite outbox)", () => {
  it("recovers pending events after restart and never auto-completes", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "ar-e2e-db-")), "outbox.sqlite");
    const outbox = createSqliteOutboxStore(dbPath);
    const failing = createMockReceiver({ failTimes: 999, failScenario: "network" });
    const h = makeHarness({ outbox, receiver: failing });
    await runWorker(makeRuntimeInput(h.repoRoot), h.deps);
    expect(outbox.countPending()).toBeGreaterThan(0);

    // simulate restart: a fresh sqlite handle recovers the pending events
    const recovered = createSqliteOutboxStore(dbPath);
    expect(recovered.countPending()).toBe(outbox.countPending());

    // recovery inspection of a removed worktree → orphaned/unknown, never completed
    const wtDir = join(h.runtimeRoot, "workspaces", "proj", "task_1", "run_1");
    rmSync(wtDir, { recursive: true, force: true });
    const state = inspectRecovery({ runId: "run_1", worktreeDir: wtDir, outbox: recovered });
    expect(state.status).not.toBe("completed");
    expect(state.pendingEvents).toBeGreaterThan(0);
  });
});

describe("E2E: malicious fixture is contained", () => {
  it("blocks a forbidden credential file", async () => {
    const h = makeHarness({
      executor: new FakeExecutor({ writes: [{ name: ".env", content: "SECRET=1\n" }] }),
    });
    const result = await runWorker(makeRuntimeInput(h.repoRoot), h.deps);
    expect(result.status).toBe("blocked");
  });

  it("rejects a network/shell verification command (not in profile) and does not complete", async () => {
    const h = makeHarness();
    const result = await runWorker(
      makeRuntimeInput(h.repoRoot, { verificationCommands: ["curl http://evil", "bash -c id"] }),
      h.deps,
    );
    expect(result.status).toBe("failed");
    expect(result.verification?.rejected.length).toBeGreaterThan(0);
  });

  it("never exposes a host secret in the verification command env", async () => {
    const specs: ProcessRunSpec[] = [];
    const capturing = async (spec: ProcessRunSpec) => {
      specs.push(spec);
      return {
        code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        termination: "exit" as const,
        durationMs: 1,
      };
    };
    const h = makeHarness({ processRunner: capturing });
    await runWorker(makeRuntimeInput(h.repoRoot), h.deps);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) {
      const json = JSON.stringify(s.env);
      expect(json).not.toContain("OV_SERVICE_TOKEN");
      expect(json).not.toContain("ANTHROPIC_API_KEY");
      expect(s.env.SSH_AUTH_SOCK).toBeUndefined();
    }
  });
});
