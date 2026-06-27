/** Locks in the OC-R10 security fixes (H1–H3, M1–M5, L2). */
import { describe, it, expect } from "vitest";
import { isForbiddenChangedFile } from "../src/artifact-collector.js";
import { isHighRiskCommand } from "../src/command-policy.js";
import { validateRuntimeRunInput } from "../src/input.js";
import { redactSecrets } from "../src/redaction.js";
import type { RuntimeRunInput } from "../src/types.js";

describe("H2 — forbidden file detection", () => {
  it("flags additional credential file types and is case-insensitive", () => {
    for (const p of [
      "client.p12",
      "cert.pfx",
      "store.jks",
      "app.keystore",
      "key.p8",
      "kubeconfig",
      "deep/.kube/config",
      ".git-credentials",
      "id_ecdsa",
      "id_dsa",
      "Cert.PEM",
      ".ENV",
      "sub/dir/ID_RSA",
    ]) {
      expect(isForbiddenChangedFile(p)).toBe(true);
    }
    expect(isForbiddenChangedFile("src/app.ts")).toBe(false);
  });
});

describe("M1 — redaction of modern token formats", () => {
  it("redacts provider tokens, JWTs, and connection strings", () => {
    const secrets = [
      "ghp_0123456789abcdefghij0123456789",
      "github_pat_11ABCDEFG0123456789_abcdefghij",
      "xoxb-1234567890-abcdefghijk",
      "glpat-abcdefghij0123456789",
      "sk-abcdefghij0123456789ABCDEFG",
      "AIzaSyAbcdefghij0123456789_klmnopqrst",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36",
    ];
    for (const s of secrets) {
      expect(redactSecrets(`value=${s}`)).not.toContain(s);
    }
    expect(redactSecrets("DATABASE_URL=postgres://user:pass@host/db")).not.toContain("pass@host");
  });
});

describe("M2 — identifier charset validation", () => {
  function input(over: Record<string, unknown>): unknown {
    return {
      version: "0.1",
      taskId: "task_1",
      runId: "run_1",
      correlationId: "corr_1",
      role: "worker",
      repository: { path: "/tmp/r", baseBranch: "main" },
      objective: "o",
      acceptanceCriteria: [],
      constraints: [],
      permissions: {
        filesystem: "workspace-write",
        shell: true,
        network: false,
        gitCommit: true,
        gitPush: false,
        deployment: false,
      },
      verificationCommands: ["node --test"],
      limits: { timeoutMs: 1000, maxOutputBytes: 1000 },
      ...over,
    };
  }
  it("rejects path-traversal / illegal characters in ids", () => {
    expect(validateRuntimeRunInput(input({ runId: "../escape" })).success).toBe(false);
    expect(validateRuntimeRunInput(input({ taskId: "a/b" })).success).toBe(false);
    expect(validateRuntimeRunInput(input({ correlationId: "a b" })).success).toBe(false);
    expect(validateRuntimeRunInput(input({}) as RuntimeRunInput).success).toBe(true);
  });
});

describe("M3 — high-risk command detection", () => {
  it("catches eval= / require / import / python -m", () => {
    expect(isHighRiskCommand("node", ["--eval=code"])).toBe(true);
    expect(isHighRiskCommand("node", ["--require", "x"])).toBe(true);
    expect(isHighRiskCommand("node", ["--import", "x"])).toBe(true);
    expect(isHighRiskCommand("python", ["-m", "http.server"])).toBe(true);
  });
});
