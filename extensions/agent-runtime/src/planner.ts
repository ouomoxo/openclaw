/**
 * Planner role (R8). Read-only: proposes a structured plan but never writes files or git. A Planner-proposed
 * verification command is NOT auto-trusted — it must still pass the repository profile AND the external
 * RuntimeRunInput allowlist before the worker would run it.
 */
import { matchesAllowedVerification } from "./command-policy.js";
import type { ParseResult, ValidationIssue } from "./parse.js";
import type { RepositoryExecutionProfile } from "./types.js";

/** Planner permissions — strictly read-only. */
export const PLANNER_PERMISSIONS = {
  repository: "read-only",
  shell: "read-only-allowlist",
  network: false,
  fileWrite: false,
  gitWrite: false,
} as const;

export interface RepositoryContext {
  repository?: string;
  baseBranch?: string;
  technologyProfile: string[];
  architectureConstraints: string[];
}

export interface PlannerInput {
  taskId: string;
  runId: string;
  objective: string;
  acceptanceCriteria: string[];
  repositoryContext: RepositoryContext;
}

export interface PlanStep {
  id: string;
  description: string;
  expectedChanges: string[];
}

export interface PlannerResult {
  summary: string;
  assumptions: string[];
  steps: PlanStep[];
  requestedPermissions: string[];
  expectedFiles: string[];
  verificationCommands: string[];
  risks: string[];
  blockers: string[];
}

export function validatePlannerResult(raw: unknown): ParseResult<PlannerResult> {
  const issues: ValidationIssue[] = [];
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => typeof v === "string";
  const strArr = (v: unknown) => Array.isArray(v) && v.every(str);

  if (!str(r.summary)) {
    issues.push({ path: "/summary", message: "summary must be a string" });
  }
  for (const k of [
    "assumptions",
    "requestedPermissions",
    "expectedFiles",
    "verificationCommands",
    "risks",
    "blockers",
  ]) {
    if (!strArr(r[k])) {
      issues.push({ path: `/${k}`, message: `${k} must be string[]` });
    }
  }
  if (
    !Array.isArray(r.steps) ||
    !r.steps.every(
      (s) =>
        s &&
        typeof s === "object" &&
        str((s as PlanStep).id) &&
        str((s as PlanStep).description) &&
        strArr((s as PlanStep).expectedChanges),
    )
  ) {
    issues.push({ path: "/steps", message: "steps must be PlanStep[]" });
  }
  if (issues.length > 0) {
    return { success: false, issues };
  }
  return { success: true, data: raw as PlannerResult };
}

/**
 * Filter Planner-proposed verification commands to those permitted by BOTH the repository profile and the
 * external RuntimeRunInput allowlist. Returns the permitted argv list; anything else is dropped (not run).
 */
export function selectAllowedPlannerVerifications(
  proposed: string[],
  profile: RepositoryExecutionProfile,
  runInputCommands: string[],
): string[][] {
  const runInputArgvs = runInputCommands.map((c) => c.trim().split(/\s+/).filter(Boolean));
  const inRunInput = (argv: string[]) =>
    runInputArgvs.some((a) => a.length === argv.length && a.every((x, i) => x === argv[i]));
  return proposed
    .map((c) => c.trim().split(/\s+/).filter(Boolean))
    .filter((argv) => argv.length > 0)
    .filter((argv) =>
      matchesAllowedVerification(argv[0], argv.slice(1), profile.allowedVerificationCommands),
    )
    .filter((argv) => inRunInput(argv));
}
