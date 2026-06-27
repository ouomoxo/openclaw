import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import {
  ArtifactCollector,
  isForbiddenChangedFile,
  parsePorcelainZ,
} from "../src/artifact-collector.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

let repo: string;
let store: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ar-art-repo-"));
  store = mkdtempSync(join(tmpdir(), "ar-art-store-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "t@localhost");
  git(repo, "config", "user.name", "T");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-m", "init");
});

function collector() {
  return new ArtifactCollector({
    storeRoot: store,
    taskId: "task_1",
    runId: "run_1",
    now: () => new Date("2026-06-28T00:00:00Z"),
  });
}

describe("ArtifactCollector", () => {
  it("redacts secrets, hashes stored bytes, and uses a store-relative path", () => {
    const art = collector().collectText(
      "command-stdout",
      "out.txt",
      "api_key=SUPERSECRET123\nhello\nBearer abcdef0123456789\n",
    );
    expect(isAbsolute(art.relativePath)).toBe(false);
    expect(art.relativePath).toContain("artifacts/task_1/run_1");
    const stored = readFileSync(join(store, art.relativePath), "utf8");
    expect(stored).not.toContain("SUPERSECRET123");
    expect(stored).not.toContain("abcdef0123456789");
    expect(stored).toContain("[REDACTED]");
    expect(stored).toContain("hello");
    expect(art.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(art.sizeBytes).toBe(Buffer.byteLength(stored, "utf8"));
  });

  it("caps artifact size and records truncation via sizeBytes", () => {
    const big = "x".repeat(10_000);
    const c = new ArtifactCollector({
      storeRoot: store,
      taskId: "t",
      runId: "r",
      maxArtifactBytes: 1000,
      now: () => new Date(),
    });
    const art = c.collectText("command-stdout", "big.txt", big);
    expect(art.sizeBytes).toBe(1000);
  });

  it("collects real git change evidence and flags forbidden files", async () => {
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    writeFileSync(join(repo, ".env"), "SECRET=1\n");
    const ev = await collector().collectGitEvidence(repo);
    const paths = ev.changedFiles.map((c) => c.path).toSorted((a, b) => a.localeCompare(b));
    expect(paths).toContain("a.txt");
    expect(paths).toContain(".env");
    expect(ev.forbiddenChanges.map((c) => c.path)).toContain(".env");
    expect(ev.head).toMatch(/^[0-9a-f]{40}$/);
    expect(ev.branch).toBe("main");
    expect(ev.artifacts.length).toBe(3);
    for (const a of ev.artifacts) {
      expect(existsSync(join(store, a.relativePath))).toBe(true);
    }
  });

  it("flags credential-like file names", () => {
    for (const p of [
      ".env",
      ".env.local",
      "x.pem",
      "id_rsa",
      "credentials.json",
      "secrets.yaml",
      ".npmrc",
      ".netrc",
    ]) {
      expect(isForbiddenChangedFile(p)).toBe(true);
    }
    expect(isForbiddenChangedFile("src/index.ts")).toBe(false);
  });

  it("parses porcelain -z output", () => {
    const out = "A  new.ts\0 M mod.ts\0?? untracked.ts\0";
    const files = parsePorcelainZ(out);
    expect(files).toEqual([
      { path: "new.ts", changeType: "created" },
      { path: "mod.ts", changeType: "modified" },
      { path: "untracked.ts", changeType: "created" },
    ]);
  });
});
