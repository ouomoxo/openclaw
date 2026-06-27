/**
 * Reviewer role (R8). Runs in a separate ACP session with NO write permission. It judges on actual
 * artifacts + verification evidence, never on the model's own change summary. A Reviewer pass is NOT a
 * task completion. This module owns the schemas + an evidence-consistency check.
 */
import type { ParseResult, ValidationIssue } from "./parse.js";
import type { PlannerResult } from "./planner.js";
import type { ChangedFile, RuntimeArtifact, VerificationEvidence } from "./types.js";

/** Reviewer permissions — read-only, no write. */
export const REVIEWER_PERMISSIONS = {
  repository: "read-only",
  fileWrite: false,
  gitWrite: false,
  network: false,
} as const;

export interface ReviewerInput {
  objective: string;
  acceptanceCriteria: string[];
  plan?: PlannerResult;
  changedFiles: ChangedFile[];
  artifacts: RuntimeArtifact[];
  verifications: VerificationEvidence[];
}

export type ReviewerSeverity = "info" | "warning" | "error" | "critical";

export interface ReviewerFinding {
  severity: ReviewerSeverity;
  category: string;
  description: string;
  evidence?: string;
  recommendation?: string;
}

export interface ReviewerResult {
  decision: "pass" | "request-changes" | "blocked";
  findings: ReviewerFinding[];
  unmetCriteria: string[];
  requiredVerifications: string[];
}

export function validateReviewerResult(raw: unknown): ParseResult<ReviewerResult> {
  const issues: ValidationIssue[] = [];
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.decision !== "pass" && r.decision !== "request-changes" && r.decision !== "blocked") {
    issues.push({ path: "/decision", message: "decision must be pass|request-changes|blocked" });
  }
  const strArr = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
  if (!strArr(r.unmetCriteria)) {
    issues.push({ path: "/unmetCriteria", message: "unmetCriteria must be string[]" });
  }
  if (!strArr(r.requiredVerifications)) {
    issues.push({
      path: "/requiredVerifications",
      message: "requiredVerifications must be string[]",
    });
  }
  if (
    !Array.isArray(r.findings) ||
    !r.findings.every(
      (f) => f && typeof f === "object" && typeof (f as ReviewerFinding).description === "string",
    )
  ) {
    issues.push({ path: "/findings", message: "findings must be ReviewerFinding[]" });
  }
  if (issues.length > 0) {
    return { success: false, issues };
  }
  return { success: true, data: raw as ReviewerResult };
}

/**
 * Evidence guardrail: a reviewer "pass" is only consistent when every required verification actually
 * passed in the evidence and no unmet criteria remain. Returns true when the pass is evidence-backed.
 */
export function isPassEvidenceConsistent(
  result: ReviewerResult,
  verifications: VerificationEvidence[],
): boolean {
  if (result.decision !== "pass") {
    return true;
  } // only "pass" is constrained
  if (result.unmetCriteria.length > 0) {
    return false;
  }
  const passedSet = new Set(
    verifications
      .filter((v) => v.status === "passed")
      .map((v) => `${v.executable} ${v.args.join(" ")}`.trim()),
  );
  return result.requiredVerifications.every((rv) => passedSet.has(rv.trim()));
}
