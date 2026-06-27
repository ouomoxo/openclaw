import { describe, it, expect } from "vitest";
import { gateRepositoryTrust, FIXTURE_PROFILE } from "../src/repository-profile.js";
import type { RepositoryExecutionProfile } from "../src/types.js";

const make = (
  trustLevel: RepositoryExecutionProfile["trustLevel"],
): RepositoryExecutionProfile => ({
  trustLevel,
  allowedExecutables: ["git"],
  allowedVerificationCommands: [],
  allowDependencyInstall: false,
  networkAllowed: false,
});

describe("gateRepositoryTrust", () => {
  it("allows fixture repositories", () => {
    expect(gateRepositoryTrust(FIXTURE_PROFILE).ok).toBe(true);
    expect(gateRepositoryTrust(make("fixture")).ok).toBe(true);
  });

  it("rejects trusted-local without explicit opt-in", () => {
    const r = gateRepositoryTrust(make("trusted-local"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("TRUSTED_LOCAL_NOT_PERMITTED");
    }
  });

  it("allows trusted-local only with explicit opt-in", () => {
    expect(gateRepositoryTrust(make("trusted-local"), { allowTrustedLocal: true }).ok).toBe(true);
  });

  it("rejects untrusted repositories", () => {
    const r = gateRepositoryTrust(make("untrusted"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("UNTRUSTED_REPOSITORY");
    }
  });
});
