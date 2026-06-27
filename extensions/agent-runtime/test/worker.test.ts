import { describe, it, expect } from "vitest";
import { createInMemoryOutboxStore } from "../src/outbox.js";
import { canTransition, isTerminal } from "../src/worker-state.js";
import { inspectRecovery, runWorker } from "../src/worker.js";
import { FakeExecutor, makeHarness, makeRuntimeInput } from "./runtime-harness.js";

describe("worker state machine", () => {
  it("allows only forward + terminal transitions", () => {
    expect(canTransition("received", "preparing")).toBe(true);
    expect(canTransition("running", "verifying")).toBe(true);
    expect(canTransition("verifying", "completed")).toBe(true);
    expect(canTransition("completed", "running")).toBe(false);
    expect(canTransition("received", "completed")).toBe(false);
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("running")).toBe(false);
  });
});

describe("runWorker", () => {
  it("completes a happy-path run: worktree isolated, file changed, verification passed, events delivered", async () => {
    const h = makeHarness();
    const result = await runWorker(makeRuntimeInput(h.repoRoot), h.deps);
    expect(result.status).toBe("completed");
    expect(result.changedFiles.map((c) => c.path)).toContain("a.txt");
    expect(result.verification?.allPassed).toBe(true);
    expect(result.securityPosture.productionEligible).toBe(false);
    // events are ordered, terminal RUN_COMPLETED present, and delivered to the receiver
    const types = result.events.map((e) => e.type);
    expect(types[0]).toBe("RUN_RECEIVED");
    expect(types).toContain("RUN_COMPLETED");
    expect(result.events.map((e) => e.sequence)).toEqual(
      [...result.events.keys()].map((i) => i + 1),
    );
    expect(h.receiver.received.some((e) => e.type === "RUN_COMPLETED")).toBe(true);
  });

  it("does NOT complete when verification fails", async () => {
    const h = makeHarness({
      verificationResult: {
        code: 1,
        signal: null,
        stdout: "",
        stderr: "fail",
        stdoutTruncated: false,
        stderrTruncated: false,
        termination: "exit",
        durationMs: 1,
      },
    });
    const result = await runWorker(makeRuntimeInput(h.repoRoot), h.deps);
    expect(result.status).toBe("failed");
    expect(result.verification?.allPassed).toBe(false);
  });

  it("does NOT complete when the executor fails (model self-report ignored)", async () => {
    const h = makeHarness({
      executor: new FakeExecutor({ status: "failed", writes: [{ name: "a.txt", content: "x\n" }] }),
    });
    const result = await runWorker(makeRuntimeInput(h.repoRoot), h.deps);
    expect(result.status).toBe("failed");
  });

  it("blocks when a forbidden (credential-like) file is created", async () => {
    const h = makeHarness({
      executor: new FakeExecutor({ writes: [{ name: ".env", content: "SECRET=1\n" }] }),
    });
    const result = await runWorker(makeRuntimeInput(h.repoRoot), h.deps);
    expect(result.status).toBe("blocked");
    expect(result.forbiddenChanges.map((c) => c.path)).toContain(".env");
  });

  it("blocks an untrusted repository before doing work", async () => {
    const h = makeHarness({
      profile: {
        trustLevel: "untrusted",
        allowedExecutables: ["node"],
        allowedVerificationCommands: [],
        allowDependencyInstall: false,
        networkAllowed: false,
      },
    });
    const result = await runWorker(makeRuntimeInput(h.repoRoot), h.deps);
    expect(result.status).toBe("blocked");
  });

  it("cancels when the abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = makeHarness({ abortSignal: controller.signal });
    const result = await runWorker(makeRuntimeInput(h.repoRoot), h.deps);
    expect(result.status).toBe("cancelled");
  });
});

describe("inspectRecovery", () => {
  it("never auto-completes; classifies orphaned/running/unknown", () => {
    const outbox = createInMemoryOutboxStore();
    expect(inspectRecovery({ runId: "r", worktreeDir: "/does/not/exist", outbox }).status).toBe(
      "unknown",
    );
    expect(
      inspectRecovery({ runId: "r", worktreeDir: ".", outbox, executorState: "running" }).status,
    ).toBe("running");
    expect(
      inspectRecovery({ runId: "r", worktreeDir: ".", outbox, executorState: "idle" }).status,
    ).toBe("orphaned");
  });
});
