import { describe, it, expect } from "vitest";
import {
  redactToken,
  redactAuthorizationHeader,
  truncateRawInstruction,
  redactObject,
  redactHeaders,
  safeErrorMessage,
} from "../src/security/redaction.js";

describe("redaction", () => {
  it("never reveals the token", () => {
    expect(redactToken("super-secret-token")).not.toContain("super-secret-token");
    expect(redactAuthorizationHeader("Bearer super-secret-token")).not.toContain(
      "super-secret-token",
    );
  });

  it("truncates a long raw instruction", () => {
    const long = "x".repeat(500);
    const out = truncateRawInstruction(long, 80);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain("truncated");
  });

  it("deep-redacts sensitive keys", () => {
    const out = redactObject({
      serviceToken: "t",
      nested: { authorization: "Bearer t", ok: "keep" },
    }) as Record<string, unknown>;
    const json = JSON.stringify(out);
    expect(json).not.toContain("Bearer t");
    expect(json).not.toContain('"t"');
    expect(json).toContain("keep");
  });

  it("redacts Authorization header for logging", () => {
    const out = redactHeaders({ Authorization: "Bearer secret", "X-Correlation-ID": "c1" });
    expect(out.Authorization).not.toContain("secret");
    expect(out["X-Correlation-ID"]).toBe("c1");
  });

  it("strips filesystem paths and stack traces from error messages", () => {
    const err = new Error(
      "boom at /Users/ouomoxo/secret/file.ts:10\n    at foo (/Users/ouomoxo/x.ts:1)",
    );
    const msg = safeErrorMessage(err);
    expect(msg).not.toContain("/Users/ouomoxo");
    expect(msg).not.toContain("\n");
    expect(msg).toContain("boom");
  });

  it("caps error message length", () => {
    expect(safeErrorMessage("y".repeat(1000), 200).length).toBeLessThanOrEqual(201);
  });
});
