/** Repository trust gating (ADR-9 / §7). This phase: fixture allowed, trusted-local explicit-only, untrusted rejected. */
import type { RepositoryExecutionProfile } from "./types.js";

/** Default profile for bundled test fixtures: no network, no dependency install, narrow executables. */
export const FIXTURE_PROFILE: RepositoryExecutionProfile = {
  trustLevel: "fixture",
  allowedExecutables: ["git", "node", "npm", "pnpm", "tsc", "vitest", "eslint", "oxlint"],
  allowedVerificationCommands: [],
  allowDependencyInstall: false,
  networkAllowed: false,
};

export type TrustGate = { ok: true } | { ok: false; code: string; reason: string };

/** Gate a repository profile for execution. `allowTrustedLocal` must be explicitly set by a test. */
export function gateRepositoryTrust(
  profile: RepositoryExecutionProfile,
  opts: { allowTrustedLocal?: boolean } = {},
): TrustGate {
  switch (profile.trustLevel) {
    case "fixture":
      return { ok: true };
    case "trusted-local":
      return opts.allowTrustedLocal
        ? { ok: true }
        : {
            ok: false,
            code: "TRUSTED_LOCAL_NOT_PERMITTED",
            reason: "trusted-local execution requires explicit opt-in",
          };
    case "untrusted":
      return {
        ok: false,
        code: "UNTRUSTED_REPOSITORY",
        reason: "untrusted repositories are not executable in this phase",
      };
    default:
      return { ok: false, code: "UNKNOWN_TRUST_LEVEL", reason: "unknown trust level" };
  }
}
