import { describe, it, expect } from "vitest";
import {
  PLANNER_PERMISSIONS,
  selectAllowedPlannerVerifications,
  validatePlannerResult,
  type PlannerResult,
} from "../src/planner.js";
import {
  REVIEWER_PERMISSIONS,
  isPassEvidenceConsistent,
  validateReviewerResult,
  type ReviewerResult,
} from "../src/reviewer.js";
import type { RepositoryExecutionProfile, VerificationEvidence } from "../src/types.js";

const planner: PlannerResult = {
  summary: "Fix login bug",
  assumptions: [],
  steps: [{ id: "s1", description: "edit auth", expectedChanges: ["src/auth.ts"] }],
  requestedPermissions: ["workspace-write"],
  expectedFiles: ["src/auth.ts"],
  verificationCommands: ["node --test", "rm -rf /"],
  risks: [],
  blockers: [],
};

const profile: RepositoryExecutionProfile = {
  trustLevel: "fixture",
  allowedExecutables: ["node"],
  allowedVerificationCommands: [["node", "--test"]],
  allowDependencyInstall: false,
  networkAllowed: false,
};

describe("Planner", () => {
  it("is read-only with no write permissions", () => {
    expect(PLANNER_PERMISSIONS.fileWrite).toBe(false);
    expect(PLANNER_PERMISSIONS.gitWrite).toBe(false);
    expect(PLANNER_PERMISSIONS.network).toBe(false);
  });

  it("validates a structured plan", () => {
    expect(validatePlannerResult(planner).success).toBe(true);
    expect(validatePlannerResult({ summary: 1 }).success).toBe(false);
  });

  it("does not auto-trust planner verification commands (profile ∩ runInput only)", () => {
    const allowed = selectAllowedPlannerVerifications(planner.verificationCommands, profile, [
      "node --test",
    ]);
    expect(allowed).toEqual([["node", "--test"]]);
    // "rm -rf /" is dropped (not in profile/runInput)
    expect(allowed.some((a) => a[0] === "rm")).toBe(false);
  });

  it("drops a command allowed by profile but absent from RuntimeRunInput", () => {
    const allowed = selectAllowedPlannerVerifications(["node --test"], profile, []);
    expect(allowed).toEqual([]);
  });
});

const verifications: VerificationEvidence[] = [
  { id: "v1", type: "test", executable: "node", args: ["--test"], status: "passed", durationMs: 1 },
];

describe("Reviewer", () => {
  it("has no write permission", () => {
    expect(REVIEWER_PERMISSIONS.fileWrite).toBe(false);
    expect(REVIEWER_PERMISSIONS.gitWrite).toBe(false);
  });

  it("validates a reviewer result", () => {
    const ok: ReviewerResult = {
      decision: "request-changes",
      findings: [{ severity: "warning", category: "test", description: "x" }],
      unmetCriteria: ["tests"],
      requiredVerifications: [],
    };
    expect(validateReviewerResult(ok).success).toBe(true);
    expect(validateReviewerResult({ decision: "yes" }).success).toBe(false);
  });

  it("rejects an evidence-inconsistent pass (unmet criteria or unverified requirement)", () => {
    const goodPass: ReviewerResult = {
      decision: "pass",
      findings: [],
      unmetCriteria: [],
      requiredVerifications: ["node --test"],
    };
    expect(isPassEvidenceConsistent(goodPass, verifications)).toBe(true);

    const badPassUnmet: ReviewerResult = {
      decision: "pass",
      findings: [],
      unmetCriteria: ["tests"],
      requiredVerifications: [],
    };
    expect(isPassEvidenceConsistent(badPassUnmet, verifications)).toBe(false);

    const badPassUnverified: ReviewerResult = {
      decision: "pass",
      findings: [],
      unmetCriteria: [],
      requiredVerifications: ["node build"],
    };
    expect(isPassEvidenceConsistent(badPassUnverified, verifications)).toBe(false);
  });
});
