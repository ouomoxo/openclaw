import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { WorktreeManager } from "../src/worktree.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

let repoRoot: string;
let runtimeRoot: string;
let headSha: string;

beforeAll(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "ar-repo-"));
  runtimeRoot = mkdtempSync(join(tmpdir(), "ar-rt-"));
  git(repoRoot, "init", "-b", "main");
  git(repoRoot, "config", "user.email", "test@localhost");
  git(repoRoot, "config", "user.name", "Test");
  writeFileSync(join(repoRoot, "file.txt"), "hello\n");
  git(repoRoot, "add", "file.txt");
  git(repoRoot, "commit", "-m", "init");
  headSha = git(repoRoot, "rev-parse", "HEAD");
});

describe("WorktreeManager (real temp git repo)", () => {
  it("creates an isolated worktree on a per-run branch without touching the main tree", async () => {
    const wm = new WorktreeManager();
    const result = await wm.prepare({
      runId: "run_a",
      taskId: "task_a",
      projectKey: "proj",
      repositoryPath: repoRoot,
      baseBranch: "main",
      baseRevision: headSha,
      runtimeRoot,
      allowedRepositoryRoots: [repoRoot],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {return;}
    expect(result.worktree.branch).toBe("agent/task_a/run_a");
    expect(existsSync(result.worktree.worktreeDir)).toBe(true);
    // main working tree is untouched: still on main at the original HEAD
    expect(git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(repoRoot, "rev-parse", "HEAD")).toBe(headSha);
    // the worktree is checked out on the new branch
    expect(git(result.worktree.worktreeDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "agent/task_a/run_a",
    );

    await wm.cleanup("run_a");
    expect(existsSync(result.worktree.worktreeDir)).toBe(false);
  });

  it("blocks when baseRevision does not match the repository HEAD", async () => {
    const wm = new WorktreeManager();
    const result = await wm.prepare({
      runId: "run_b",
      taskId: "task_b",
      projectKey: "proj",
      repositoryPath: repoRoot,
      baseBranch: "main",
      baseRevision: "0000000000000000000000000000000000000000",
      runtimeRoot,
      allowedRepositoryRoots: [repoRoot],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {return;}
    expect(result.code).toBe("BASE_REVISION_MISMATCH");
  });

  it("rejects a repository outside the allowlist", async () => {
    const wm = new WorktreeManager();
    const result = await wm.prepare({
      runId: "run_c",
      taskId: "task_c",
      projectKey: "proj",
      repositoryPath: repoRoot,
      baseBranch: "main",
      runtimeRoot,
      allowedRepositoryRoots: [join(tmpdir(), "some-other-root")],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {return;}
    expect(result.code).toBe("REPOSITORY_NOT_ALLOWLISTED");
  });

  it("blocks a non-git repository path", async () => {
    const notRepo = mkdtempSync(join(tmpdir(), "ar-notrepo-"));
    const wm = new WorktreeManager();
    const result = await wm.prepare({
      runId: "run_d",
      taskId: "task_d",
      projectKey: "proj",
      repositoryPath: notRepo,
      baseBranch: "main",
      runtimeRoot,
      allowedRepositoryRoots: [notRepo],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {return;}
    expect(result.code).toBe("NOT_A_GIT_REPOSITORY");
  });
});
