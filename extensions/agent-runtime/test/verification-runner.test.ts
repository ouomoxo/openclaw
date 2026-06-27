import { describe, it, expect } from "vitest";
import type { RuntimeCommandResult, RuntimeCommandRunner } from "../src/command-runner.js";
import type { RepositoryExecutionProfile } from "../src/types.js";
import { createVerificationRunner } from "../src/verification-runner.js";

const profile: RepositoryExecutionProfile = {
  trustLevel: "fixture",
  allowedExecutables: ["node", "npm"],
  allowedVerificationCommands: [
    ["node", "--test"],
    ["npm", "test"],
  ],
  allowDependencyInstall: false,
  networkAllowed: false,
};

function fakeCommandRunner(results: RuntimeCommandResult[]) {
  let i = 0;
  const calls: { executable: string; args: string[] }[] = [];
  const runner: RuntimeCommandRunner = {
    async run(input) {
      calls.push({ executable: input.executable, args: input.args });
      return results[i++] ?? pass();
    },
  };
  return { runner, calls };
}

function pass(): RuntimeCommandResult {
  return {
    status: "passed",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    highRisk: false,
  };
}
function fail(): RuntimeCommandResult {
  return { ...pass(), status: "failed", exitCode: 1 };
}
function cancelled(): RuntimeCommandResult {
  return { ...pass(), status: "cancelled", exitCode: null };
}

const baseInput = {
  runId: "r1",
  cwd: "/wt",
  worktreeRoot: "/wt",
  environment: { PATH: "/usr/bin" },
  profile,
  timeoutMs: 1000,
  maxOutputBytes: 1000,
};

describe("VerificationRunner", () => {
  it("runs commands in input order and reports allPassed", async () => {
    const { runner, calls } = fakeCommandRunner([pass(), pass()]);
    const report = await createVerificationRunner(runner).runAll({
      ...baseInput,
      requestedCommands: [
        ["node", "--test"],
        ["npm", "test"],
      ],
    });
    expect(report.allPassed).toBe(true);
    expect(report.evidences.map((e) => e.executable)).toEqual(["node", "npm"]);
    expect(calls.map((c) => c.executable)).toEqual(["node", "npm"]);
  });

  it("does not treat a failed verification as passed", async () => {
    const { runner } = fakeCommandRunner([fail()]);
    const report = await createVerificationRunner(runner).runAll({
      ...baseInput,
      requestedCommands: [["node", "--test"]],
    });
    expect(report.allPassed).toBe(false);
    expect(report.evidences[0].status).toBe("failed");
  });

  it("rejects a command not in the profile allowlist (not a pass)", async () => {
    const { runner, calls } = fakeCommandRunner([pass()]);
    const report = await createVerificationRunner(runner).runAll({
      ...baseInput,
      requestedCommands: [["node", "evil.js"]],
    });
    expect(report.allPassed).toBe(false);
    expect(report.rejected.length).toBe(1);
    expect(calls.length).toBe(0);
  });

  it("stops running further verifications after cancellation", async () => {
    const { runner, calls } = fakeCommandRunner([cancelled(), pass()]);
    const report = await createVerificationRunner(runner).runAll({
      ...baseInput,
      requestedCommands: [
        ["node", "--test"],
        ["npm", "test"],
      ],
    });
    expect(report.cancelled).toBe(true);
    expect(calls.length).toBe(1); // second command never runs
    expect(report.allPassed).toBe(false);
  });
});
