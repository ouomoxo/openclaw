import { describe, it, expect } from "vitest";
import { validateRuntimeRunInput } from "../src/input.js";
import type { RuntimeRunInput } from "../src/types.js";

function validInput(): RuntimeRunInput {
  return {
    version: "0.1",
    taskId: "task_1",
    runId: "run_1",
    correlationId: "corr_1",
    role: "worker",
    repository: { path: "/tmp/repo", baseBranch: "main" },
    objective: "Fix the failing test",
    acceptanceCriteria: ["tests pass"],
    constraints: [],
    permissions: {
      filesystem: "workspace-write",
      shell: true,
      network: false,
      gitCommit: true,
      gitPush: false,
      deployment: false,
    },
    verificationCommands: ["vitest run"],
    limits: { timeoutMs: 60_000, maxOutputBytes: 1_000_000 },
  };
}

describe("validateRuntimeRunInput", () => {
  it("accepts a valid worker input", () => {
    expect(validateRuntimeRunInput(validInput()).success).toBe(true);
  });

  it("rejects network=true (no network isolation in this phase)", () => {
    const i = validInput();
    i.permissions.network = true as unknown as false;
    const r = validateRuntimeRunInput(i);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.issues.some((x) => x.path === "/permissions/network")).toBe(true);
    }
  });

  it("rejects gitPush=true and deployment=true", () => {
    const i = validInput();
    (i.permissions as { gitPush: boolean }).gitPush = true;
    (i.permissions as { deployment: boolean }).deployment = true;
    const r = validateRuntimeRunInput(i);
    expect(r.success).toBe(false);
  });

  it("requires taskId/runId/correlationId", () => {
    const i = validInput() as unknown as Record<string, unknown>;
    delete i.taskId;
    expect(validateRuntimeRunInput(i).success).toBe(false);
  });

  it("rejects a wrong version/role", () => {
    const i = { ...validInput(), version: "1.0" };
    expect(validateRuntimeRunInput(i).success).toBe(false);
  });

  it("rejects non-positive limits", () => {
    const i = validInput();
    i.limits.timeoutMs = 0;
    expect(validateRuntimeRunInput(i).success).toBe(false);
  });
});
