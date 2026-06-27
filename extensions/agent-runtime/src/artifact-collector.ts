/**
 * Artifact collector (R5). Writes evidence under a per-run store dir and records SHA-256 of the STORED
 * bytes. Git change detection uses real git output (never model self-report). Security: writes only inside
 * the store root, redacts secret patterns (without touching source files), enforces a size cap, records
 * truncation, and flags forbidden (credential-like) changed files. Artifact metadata exposes only a
 * store-relative path — never an absolute host path.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { redactSecrets } from "./redaction.js";
import type { ChangedFile, RuntimeArtifact, RuntimeArtifactType } from "./types.js";
import type { GitRunner } from "./worktree.js";
import { createDefaultGitRunner } from "./worktree.js";

const BLOCKED_FILE = [
  /(^|\/)\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|p8|ppk)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|\/)credentials.*$/i,
  /(^|\/)\.?secrets.*$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)kubeconfig$/i,
  /(^|\/)\.kube\/config$/i,
];

export function isForbiddenChangedFile(path: string): boolean {
  return BLOCKED_FILE.some((re) => re.test(path));
}

export interface GitEvidence {
  artifacts: RuntimeArtifact[];
  changedFiles: ChangedFile[];
  forbiddenChanges: ChangedFile[];
  head: string;
  branch: string;
}

export interface ArtifactCollectorOptions {
  storeRoot: string;
  taskId: string;
  runId: string;
  maxArtifactBytes?: number;
  now: () => Date;
  git?: GitRunner;
}

export class ArtifactCollector {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly git: GitRunner;
  private counter = 0;

  constructor(private readonly options: ArtifactCollectorOptions) {
    this.dir = join(resolve(options.storeRoot), "artifacts", options.taskId, options.runId);
    this.maxBytes = options.maxArtifactBytes ?? 5_000_000;
    this.git = options.git ?? createDefaultGitRunner();
    mkdirSync(this.dir, { recursive: true });
  }

  /** Write redacted, size-capped text as an artifact; hashes the stored bytes. */
  collectText(type: RuntimeArtifactType, name: string, text: string): RuntimeArtifact {
    const redacted = redactSecrets(text);
    const capped = Buffer.from(redacted, "utf8");
    const stored = capped.length > this.maxBytes ? capped.subarray(0, this.maxBytes) : capped;
    const fileName = `${String(this.counter++).padStart(3, "0")}-${name}`;
    const abs = join(this.dir, fileName);
    // defense: stored path must stay inside the store dir
    if (!isInside(abs, this.dir)) {
      throw new Error("artifact write path escaped the store root");
    }
    writeFileSync(abs, stored);
    const relativePath = relative(resolve(this.options.storeRoot), abs);
    return {
      artifactId: `art_${this.options.runId}_${fileName}`,
      taskId: this.options.taskId,
      runId: this.options.runId,
      type,
      relativePath,
      sha256: createHash("sha256").update(stored).digest("hex"),
      sizeBytes: stored.length,
      mimeType: "text/plain",
      createdAt: this.options.now().toISOString(),
    };
  }

  /** Collect git change evidence from the worktree using real git (porcelain -z, diff, HEAD, branch). */
  async collectGitEvidence(worktreeDir: string): Promise<GitEvidence> {
    const [statusRes, diffRes, headRes, branchRes] = await Promise.all([
      this.git(["-C", worktreeDir, "status", "--porcelain=v1", "-z"], worktreeDir),
      this.git(["-C", worktreeDir, "diff", "--binary", "--no-ext-diff", "HEAD"], worktreeDir),
      this.git(["-C", worktreeDir, "rev-parse", "HEAD"], worktreeDir),
      this.git(["-C", worktreeDir, "branch", "--show-current"], worktreeDir),
    ]);
    const changedFiles = parsePorcelainZ(statusRes.stdout);
    const forbiddenChanges = changedFiles.filter((c) => isForbiddenChangedFile(c.path));
    const artifacts: RuntimeArtifact[] = [
      this.collectText("git-status", "git-status.txt", statusRes.stdout.split("\u0000").join("\n")),
      this.collectText(
        "changed-files",
        "changed-files.json",
        JSON.stringify(changedFiles, null, 2),
      ),
    ];
    // H2/M4: do not persist the diff (which carries file content) when a forbidden file changed.
    if (forbiddenChanges.length === 0) {
      artifacts.push(this.collectText("git-diff", "git-diff.patch", diffRes.stdout));
    }
    return {
      artifacts,
      changedFiles,
      forbiddenChanges,
      head: headRes.stdout.trim(),
      branch: branchRes.stdout.trim(),
    };
  }
}

/** Parse `git status --porcelain=v1 -z` (NUL-delimited) into changed files. */
export function parsePorcelainZ(out: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const records = out.split("\u0000").filter((r) => r.length > 0);
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    if (rec === undefined) {
      continue;
    }
    const x = rec[0] ?? " ";
    const y = rec[1] ?? " ";
    const path = rec.slice(3);
    // renames/copies consume a following NUL-separated old path
    if (x === "R" || x === "C") {
      i += 1;
    }
    const changeType: ChangedFile["changeType"] =
      x === "D" || y === "D" ? "deleted" : x === "A" || x === "?" ? "created" : "modified";
    if (path) {
      files.push({ path, changeType });
    }
  }
  return files;
}

function isInside(target: string, root: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}
