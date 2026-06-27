/** RuntimeRunInput validation (§3/§6). Enforces gitPush/deployment/network = false and required identifiers. */
import type { ParseResult, ValidationIssue } from "./parse.js";
import type { RuntimeRunInput } from "./types.js";

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value) && !value.includes("..");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export function validateRuntimeRunInput(raw: unknown): ParseResult<RuntimeRunInput> {
  const issues: ValidationIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.version !== "0.1") {
    add("/version", 'version must be "0.1"');
  }
  if (r.role !== "worker") {
    add("/role", 'role must be "worker"');
  }
  if (!safeId(r.taskId)) {
    add("/taskId", "taskId is required");
  }
  if (!safeId(r.runId)) {
    add("/runId", "runId is required");
  }
  if (!safeId(r.correlationId)) {
    add("/correlationId", "correlationId is required");
  }
  if (!nonEmptyString(r.objective)) {
    add("/objective", "objective is required");
  }

  const repo = (r.repository ?? {}) as Record<string, unknown>;
  if (!nonEmptyString(repo.path)) {
    add("/repository/path", "repository.path is required");
  }
  if (!nonEmptyString(repo.baseBranch)) {
    add("/repository/baseBranch", "repository.baseBranch is required");
  }
  if (repo.baseRevision !== undefined && !nonEmptyString(repo.baseRevision)) {
    add(
      "/repository/baseRevision",
      "repository.baseRevision must be a non-empty string when present",
    );
  }

  if (!stringArray(r.acceptanceCriteria)) {
    add("/acceptanceCriteria", "acceptanceCriteria must be string[]");
  }
  if (!stringArray(r.constraints)) {
    add("/constraints", "constraints must be string[]");
  }
  if (!stringArray(r.verificationCommands)) {
    add("/verificationCommands", "verificationCommands must be string[]");
  }

  const perms = (r.permissions ?? {}) as Record<string, unknown>;
  if (perms.filesystem !== "workspace-write") {
    add("/permissions/filesystem", 'filesystem must be "workspace-write"');
  }
  if (typeof perms.shell !== "boolean") {
    add("/permissions/shell", "shell must be boolean");
  }
  if (typeof perms.gitCommit !== "boolean") {
    add("/permissions/gitCommit", "gitCommit must be boolean");
  }
  if (perms.gitPush !== false) {
    add("/permissions/gitPush", "gitPush must be false in this runtime");
  }
  if (perms.deployment !== false) {
    add("/permissions/deployment", "deployment must be false in this runtime");
  }
  // §6/§15: network-enabled input is rejected (no network isolation guarantee in this phase).
  if (perms.network !== false) {
    add("/permissions/network", "network must be false in this experimental runtime");
  }

  const limits = (r.limits ?? {}) as Record<string, unknown>;
  if (typeof limits.timeoutMs !== "number" || limits.timeoutMs <= 0) {
    add("/limits/timeoutMs", "timeoutMs must be > 0");
  }
  if (typeof limits.maxOutputBytes !== "number" || limits.maxOutputBytes <= 0) {
    add("/limits/maxOutputBytes", "maxOutputBytes must be > 0");
  }
  if (
    limits.maxProcesses !== undefined &&
    (typeof limits.maxProcesses !== "number" || limits.maxProcesses <= 0)
  ) {
    add("/limits/maxProcesses", "maxProcesses must be > 0 when present");
  }

  if (issues.length > 0) {
    return { success: false, issues };
  }
  return { success: true, data: raw as RuntimeRunInput };
}
