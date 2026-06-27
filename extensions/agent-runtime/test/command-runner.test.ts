import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { createRuntimeCommandRunner } from "../src/command-runner.js";
import type { ProcessRunner, ProcessRunResult, ProcessRunSpec } from "../src/process-runner.js";
import type { RepositoryExecutionProfile } from "../src/types.js";

let worktree: string;

beforeAll(() => {
  worktree = mkdtempSync(join(tmpdir(), "ar-cr-"));
});

const profile: RepositoryExecutionProfile = {
  trustLevel: "fixture",
  allowedExecutables: ["node", "git"],
  allowedVerificationCommands: [["node", "--test"]],
  allowDependencyInstall: false,
  networkAllowed: false,
};

function fakeRunner(impl?: (spec: ProcessRunSpec) => ProcessRunResult) {
  const calls: ProcessRunSpec[] = [];
  const runner: ProcessRunner = async (spec) => {
    calls.push(spec);
    return (
      impl?.(spec) ?? {
        code: 0,
        signal: null,
        stdout: "ok",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        termination: "exit",
        durationMs: 1,
      }
    );
  };
  return { runner, calls };
}

describe("RuntimeCommandRunner", () => {
  it("passes only the sanitized env (never merges host process.env)", async () => {
    const { runner, calls } = fakeRunner();
    const cr = createRuntimeCommandRunner(runner);
    await cr.run({
      runId: "r1",
      cwd: worktree,
      executable: "node",
      args: ["--test"],
      timeoutMs: 1000,
      maxOutputBytes: 1000,
      environment: { PATH: "/usr/bin", HOME: "/rt" },
      worktreeRoot: worktree,
      profile,
      kind: "verification",
    });
    expect(calls.length).toBe(1);
    expect(calls[0].env).toEqual({ PATH: "/usr/bin", HOME: "/rt" });
    expect(Object.keys(calls[0].env)).not.toContain("OV_SERVICE_TOKEN");
  });

  it("blocks a denied executable without executing", async () => {
    const { runner, calls } = fakeRunner();
    const cr = createRuntimeCommandRunner(runner);
    const r = await cr.run({
      runId: "r1",
      cwd: worktree,
      executable: "bash",
      args: ["-c", "x"],
      timeoutMs: 1000,
      maxOutputBytes: 1000,
      environment: {},
      worktreeRoot: worktree,
      profile,
      kind: "agent",
    });
    expect(r.status).toBe("blocked");
    expect(r.blockedCode).toBe("EXECUTABLE_DENIED");
    expect(calls.length).toBe(0);
  });

  it("blocks a cwd outside the worktree without executing", async () => {
    const { runner, calls } = fakeRunner();
    const cr = createRuntimeCommandRunner(runner);
    const r = await cr.run({
      runId: "r1",
      cwd: tmpdir(),
      executable: "node",
      args: ["--test"],
      timeoutMs: 1000,
      maxOutputBytes: 1000,
      environment: {},
      worktreeRoot: worktree,
      profile,
      kind: "verification",
    });
    expect(r.status).toBe("blocked");
    expect(r.blockedCode).toBe("CWD_OUTSIDE_WORKTREE");
    expect(calls.length).toBe(0);
  });

  it("maps exit code, timeout, and cancellation to distinct statuses", async () => {
    const fail = fakeRunner(() => ({
      code: 1,
      signal: null,
      stdout: "",
      stderr: "boom",
      stdoutTruncated: false,
      stderrTruncated: false,
      termination: "exit",
      durationMs: 1,
    }));
    const failR = await createRuntimeCommandRunner(fail.runner).run(base());
    expect(failR.status).toBe("failed");
    expect(failR.exitCode).toBe(1);

    const to = fakeRunner(() => ({
      code: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      termination: "timeout",
      durationMs: 1,
    }));
    expect((await createRuntimeCommandRunner(to.runner).run(base())).status).toBe("timed-out");

    const ab = fakeRunner(() => ({
      code: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      termination: "aborted",
      durationMs: 1,
    }));
    expect((await createRuntimeCommandRunner(ab.runner).run(base())).status).toBe("cancelled");
  });

  it("preserves a terminating signal", async () => {
    const sig = fakeRunner(() => ({
      code: null,
      signal: "SIGSEGV",
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      termination: "signal",
      durationMs: 1,
    }));
    const r = await createRuntimeCommandRunner(sig.runner).run(base());
    expect(r.status).toBe("failed");
    expect(r.signal).toBe("SIGSEGV");
  });

  function base() {
    return {
      runId: "r1",
      cwd: worktree,
      executable: "node",
      args: ["--test"],
      timeoutMs: 1000,
      maxOutputBytes: 1000,
      environment: { PATH: "/usr/bin" },
      worktreeRoot: worktree,
      profile,
      kind: "verification" as const,
    };
  }
});
