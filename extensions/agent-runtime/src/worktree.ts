/**
 * Worktree manager (§9 / ADR-7). Creates an ISOLATED git worktree + branch per run, mirroring the
 * validated argv shape used by core's update-runner. The main working tree is never modified: every op
 * runs `git -C <gitRoot> worktree …` into a separate dir. Forbidden: reset --hard, clean -fd, force/remote
 * push, checking out user branches in the main tree. The git runner is injected (argv spawn, no shell).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a git invocation as argv (never a shell string). Injectable for tests. */
export type GitRunner = (
  args: string[],
  cwd: string,
  signal?: AbortSignal,
) => Promise<GitCommandResult>;

export interface PrepareWorktreeInput {
  runId: string;
  taskId: string;
  projectKey: string;
  repositoryPath: string;
  baseBranch: string;
  baseRevision?: string;
  runtimeRoot: string;
  /** Repository paths allowed for execution; repositoryPath must resolve inside one of these. */
  allowedRepositoryRoots: string[];
}

export interface PreparedWorktree {
  runId: string;
  worktreeDir: string;
  branch: string;
  baseRevision: string;
  gitRoot: string;
}

export type PrepareResult =
  | { ok: true; worktree: PreparedWorktree }
  | { ok: false; status: "blocked"; code: string; reason: string };

export interface WorktreeState {
  runId: string;
  worktreeExists: boolean;
  worktreeDir: string;
}

function withinAny(target: string, roots: string[]): boolean {
  const real = safeRealpath(target);
  if (real === null) {
    return false;
  }
  return roots.some((root) => {
    const realRoot = safeRealpath(root);
    if (realRoot === null) {
      return false;
    }
    return real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
  });
}

function safeRealpath(p: string): string | null {
  try {
    return realpathSync(resolve(p));
  } catch {
    return null;
  }
}

/** Default git runner: argv spawn, no shell, bounded timeout. Production wiring may swap in the SDK runner. */
export function createDefaultGitRunner(timeoutMs = 30_000): GitRunner {
  return (args, cwd, signal) =>
    new Promise<GitCommandResult>((resolveResult, reject) => {
      const child = spawn("git", args, { cwd, env: process.env, signal });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        // Raw output — callers trim where needed (porcelain -z and binary diff must NOT be trimmed).
        resolveResult({ code: code ?? -1, stdout, stderr });
      });
    });
}

export class WorktreeManager {
  private readonly prepared = new Map<string, PreparedWorktree>();

  constructor(private readonly git: GitRunner = createDefaultGitRunner()) {}

  async prepare(input: PrepareWorktreeInput): Promise<PrepareResult> {
    // 1. repository allowlist
    if (!withinAny(input.repositoryPath, input.allowedRepositoryRoots)) {
      return blocked("REPOSITORY_NOT_ALLOWLISTED", "repository path is not within an allowed root");
    }

    // 2. resolve the git root (must be a real repo)
    const topLevel = await this.git(
      ["-C", input.repositoryPath, "rev-parse", "--show-toplevel"],
      input.repositoryPath,
    );
    if (topLevel.code !== 0) {
      return blocked("NOT_A_GIT_REPOSITORY", "repository path is not a git repository");
    }
    const gitRoot = topLevel.stdout.trim();
    if (!withinAny(gitRoot, input.allowedRepositoryRoots)) {
      return blocked("GIT_ROOT_NOT_ALLOWLISTED", "resolved git root is not within an allowed root");
    }

    // 3. resolve the base revision and validate baseRevision if supplied
    const baseRef = await this.git(["-C", gitRoot, "rev-parse", input.baseBranch], gitRoot);
    if (baseRef.code !== 0) {
      return blocked("BASE_BRANCH_UNRESOLVED", `cannot resolve base branch '${input.baseBranch}'`);
    }
    const baseRevision = baseRef.stdout.trim();
    if (input.baseRevision !== undefined && input.baseRevision !== baseRevision) {
      return blocked(
        "BASE_REVISION_MISMATCH",
        "provided baseRevision does not match the repository HEAD",
      );
    }

    // 4. branch + worktree dir (never touches the main working tree)
    const branch = `agent/${input.taskId}/${input.runId}`;
    const worktreeDir = join(
      input.runtimeRoot,
      "workspaces",
      input.projectKey,
      input.taskId,
      input.runId,
    );
    mkdirSync(join(input.runtimeRoot, "workspaces", input.projectKey, input.taskId), {
      recursive: true,
    });

    // 5. create the worktree on a fresh branch at the base revision
    const add = await this.git(
      ["-C", gitRoot, "worktree", "add", "-b", branch, worktreeDir, baseRevision],
      gitRoot,
    );
    if (add.code !== 0) {
      return blocked("WORKTREE_ADD_FAILED", `git worktree add failed: ${truncate(add.stderr)}`);
    }

    // 6. verify the worktree path exists and is writable
    if (!existsSync(worktreeDir) || !isWritable(worktreeDir)) {
      return blocked("WORKTREE_UNUSABLE", "worktree directory missing or not writable");
    }

    const worktree: PreparedWorktree = {
      runId: input.runId,
      worktreeDir,
      branch,
      baseRevision,
      gitRoot,
    };
    this.prepared.set(input.runId, worktree);
    return { ok: true, worktree };
  }

  async inspect(runId: string): Promise<WorktreeState> {
    const wt = this.prepared.get(runId);
    if (!wt) {
      return { runId, worktreeExists: false, worktreeDir: "" };
    }
    return { runId, worktreeExists: existsSync(wt.worktreeDir), worktreeDir: wt.worktreeDir };
  }

  async cleanup(runId: string): Promise<void> {
    const wt = this.prepared.get(runId);
    if (!wt) {
      return;
    }
    await this.git(
      ["-C", wt.gitRoot, "worktree", "remove", "--force", wt.worktreeDir],
      wt.gitRoot,
    ).catch(() => undefined);
    await this.git(["-C", wt.gitRoot, "worktree", "prune"], wt.gitRoot).catch(() => undefined);
    if (existsSync(wt.worktreeDir)) {
      rmSync(wt.worktreeDir, { recursive: true, force: true });
    }
    this.prepared.delete(runId);
  }
}

function blocked(code: string, reason: string): PrepareResult {
  return { ok: false, status: "blocked", code, reason };
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isWritable(dir: string): boolean {
  try {
    const probe = join(dir, `.agent-runtime-write-probe`);
    mkdirSync(probe);
    rmSync(probe, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
