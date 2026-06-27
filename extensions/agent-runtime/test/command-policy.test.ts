import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { validateCommand, isHighRiskCommand, DENY_EXECUTABLES } from "../src/command-policy.js";
import type { RepositoryExecutionProfile } from "../src/types.js";

const profile: RepositoryExecutionProfile = {
  trustLevel: "fixture",
  allowedExecutables: ["git", "vitest", "node", "npx"],
  allowedVerificationCommands: ["vitest run", "npx tsc"],
  allowDependencyInstall: false,
  networkAllowed: false,
};

let worktree: string;
let escapeLink: string;

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "ar-cmd-"));
  worktree = join(root, "wt");
  const outside = join(root, "outside");
  mkdirSync(worktree);
  mkdirSync(outside);
  escapeLink = join(worktree, "escape");
  symlinkSync(outside, escapeLink);
});

describe("command policy", () => {
  it("denies shell interpreters and remote/privilege tools", () => {
    for (const exe of ["sh", "bash", "sudo", "ssh", "curl", "docker"]) {
      expect(DENY_EXECUTABLES.has(exe)).toBe(true);
      const r = validateCommand({
        executable: exe,
        args: [],
        cwd: worktree,
        worktreeRoot: worktree,
        profile,
        kind: "agent",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("EXECUTABLE_DENIED");
      }
    }
  });

  it("rejects executables not in the profile allowlist", () => {
    const r = validateCommand({
      executable: "cargo",
      args: ["build"],
      cwd: worktree,
      worktreeRoot: worktree,
      profile,
      kind: "agent",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("EXECUTABLE_NOT_ALLOWLISTED");
    }
  });

  it("accepts an allowlisted agent command inside the worktree", () => {
    const r = validateCommand({
      executable: "git",
      args: ["status"],
      cwd: worktree,
      worktreeRoot: worktree,
      profile,
      kind: "agent",
    });
    expect(r.ok).toBe(true);
  });

  it("requires verification commands to be explicitly allowlisted", () => {
    const bad = validateCommand({
      executable: "git",
      args: ["diff"],
      cwd: worktree,
      worktreeRoot: worktree,
      profile,
      kind: "verification",
    });
    expect(bad.ok).toBe(false);
    const ok = validateCommand({
      executable: "vitest",
      args: ["run"],
      cwd: worktree,
      worktreeRoot: worktree,
      profile,
      kind: "verification",
    });
    expect(ok.ok).toBe(true);
  });

  it("treats node -e / python -c / npx as high-risk", () => {
    expect(isHighRiskCommand("node", ["-e", "x"])).toBe(true);
    expect(isHighRiskCommand("python3", ["-c", "x"])).toBe(true);
    expect(isHighRiskCommand("npx", ["tsc"])).toBe(true);
    expect(isHighRiskCommand("node", ["script.js"])).toBe(false);
  });

  it("rejects high-risk commands unless explicitly allowlisted", () => {
    const denied = validateCommand({
      executable: "npx",
      args: ["eslint"],
      cwd: worktree,
      worktreeRoot: worktree,
      profile,
      kind: "agent",
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.code).toBe("HIGH_RISK_NOT_EXPLICIT");
    }
    const allowed = validateCommand({
      executable: "npx",
      args: ["tsc"],
      cwd: worktree,
      worktreeRoot: worktree,
      profile,
      kind: "verification",
    });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.highRisk).toBe(true);
    }
  });

  it("rejects a cwd that escapes the worktree via symlink", () => {
    const r = validateCommand({
      executable: "git",
      args: ["status"],
      cwd: escapeLink,
      worktreeRoot: worktree,
      profile,
      kind: "agent",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("CWD_OUTSIDE_WORKTREE");
    }
  });
});
