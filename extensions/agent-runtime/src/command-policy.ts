/**
 * Command policy (ADR-9 / §8). Every command must be argv-based (no shell), run inside the run worktree,
 * use an allowlisted executable, and pass the repository profile. Shell interpreters and remote/privilege
 * tools are denied. Arbitrary-code-execution commands (node -e, python -c, npx) are a separate high-risk tier.
 */
import { realpathSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import type { RepositoryExecutionProfile } from "./types.js";

/** Executables denied by default (shells, privilege escalation, remote/transfer, infra). */
export const DENY_EXECUTABLES: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "sudo",
  "su",
  "ssh",
  "scp",
  "curl",
  "wget",
  "nc",
  "socat",
  "docker",
  "kubectl",
  "terraform",
  "ansible",
]);

function exeName(executable: string): string {
  return basename(executable)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, "");
}

/** True when the command can execute arbitrary code beyond its named tool (separate risk tier). */
export function isHighRiskCommand(executable: string, args: string[]): boolean {
  const exe = exeName(executable);
  if (exe === "npx") {
    return true;
  }
  if (
    (exe === "node" || exe === "bun" || exe === "deno") &&
    args.some((a) => /^(-e|-p|--eval|--print)$/.test(a))
  ) {
    return true;
  }
  if ((exe === "python" || exe === "python3") && args.some((a) => a === "-c")) {
    return true;
  }
  return false;
}

/** Resolve realpaths (following symlinks) and check `cwd` stays within `root`. */
export function isWithinRoot(cwd: string, root: string): boolean {
  const realRoot = safeRealpath(root);
  const realCwd = safeRealpath(cwd);
  if (realRoot === null || realCwd === null) {
    return false;
  }
  return (
    realCwd === realRoot || realCwd.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)
  );
}

function safeRealpath(p: string): string | null {
  try {
    return realpathSync(resolve(p));
  } catch {
    return null; // non-existent path → cannot prove containment → reject
  }
}

export interface CommandValidationInput {
  executable: string;
  args: string[];
  cwd: string;
  worktreeRoot: string;
  profile: RepositoryExecutionProfile;
  /** "verification" must additionally be in the profile's allowedVerificationCommands. */
  kind: "verification" | "agent";
}

export type CommandValidation =
  | { ok: true; highRisk: boolean }
  | { ok: false; code: string; reason: string };

export function validateCommand(input: CommandValidationInput): CommandValidation {
  const exe = exeName(input.executable);

  if (DENY_EXECUTABLES.has(exe)) {
    return { ok: false, code: "EXECUTABLE_DENIED", reason: `executable '${exe}' is denied` };
  }
  if (!input.profile.allowedExecutables.map(exeName).includes(exe)) {
    return {
      ok: false,
      code: "EXECUTABLE_NOT_ALLOWLISTED",
      reason: `executable '${exe}' not in profile allowlist`,
    };
  }
  if (!isWithinRoot(input.cwd, input.worktreeRoot)) {
    return {
      ok: false,
      code: "CWD_OUTSIDE_WORKTREE",
      reason: "cwd is not inside the run worktree",
    };
  }

  const highRisk = isHighRiskCommand(input.executable, input.args);
  const fullCommand = [exe, ...input.args].join(" ");

  if (
    input.kind === "verification" &&
    !input.profile.allowedVerificationCommands.includes(fullCommand)
  ) {
    return {
      ok: false,
      code: "VERIFICATION_NOT_ALLOWLISTED",
      reason: `verification command not allowlisted: ${fullCommand}`,
    };
  }
  // High-risk commands must be explicitly listed as a verification command; never allowed implicitly.
  if (highRisk && !input.profile.allowedVerificationCommands.includes(fullCommand)) {
    return {
      ok: false,
      code: "HIGH_RISK_NOT_EXPLICIT",
      reason: `high-risk command requires explicit allowlisting: ${fullCommand}`,
    };
  }

  return { ok: true, highRisk };
}
