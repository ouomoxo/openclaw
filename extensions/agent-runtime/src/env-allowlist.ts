/**
 * Environment minimization (ADR-9). The ACP session and every child command get a FRESHLY BUILT env
 * object containing only allowlisted names — host env is never copied wholesale. HOME is redirected to a
 * runtime-dedicated home. Pattern blocking is a secondary guard, not the primary mechanism.
 */

/** Always-safe, non-secret env names. */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME", // redirected to the runtime home — see buildSanitizedEnv
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "CI",
  "NO_COLOR",
];

/** Tool-specific names that may be added explicitly when a profile needs them (never automatic). */
export const TOOL_OPT_IN_ENV: readonly string[] = [
  "NODE_OPTIONS",
  "RUST_BACKTRACE",
  "CARGO_HOME",
  "npm_config_cache",
];

/** Secondary guard: env names that must never appear in a sanitized env. */
const BLOCKED_ENV_PATTERN =
  /(^(OV_|TELEGRAM_|SLACK_|GITHUB_|GH_|AWS_|GOOGLE_|AZURE_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|SSH_|DOCKER_))|(KUBECONFIG|DATABASE_URL)|(_?(TOKEN|SECRET|PASSWORD|KEY))$/i;

export function isBlockedEnvName(name: string): boolean {
  return BLOCKED_ENV_PATTERN.test(name);
}

export interface SanitizedEnvOptions {
  /** Allowed env names to carry over from the host (defaults to DEFAULT_ENV_ALLOWLIST). */
  allowlist?: readonly string[];
  /** Runtime-dedicated HOME (replaces host HOME). */
  runtimeHome: string;
  /** Explicit safe key/values set by the runtime (e.g. git identity, dedicated cache paths). */
  explicit?: Record<string, string>;
}

/**
 * Build a sanitized env from the allowlist only. Throws if the allowlist or explicit values try to
 * introduce a blocked (secret-shaped) name — fail closed.
 */
export function buildSanitizedEnv(
  options: SanitizedEnvOptions,
  hostEnv: Record<string, string | undefined>,
): Record<string, string> {
  const allowlist = options.allowlist ?? DEFAULT_ENV_ALLOWLIST;
  const out: Record<string, string> = {};

  for (const name of allowlist) {
    if (name === "HOME") {
      continue;
    } // forced below
    if (isBlockedEnvName(name)) {
      throw new Error(`env allowlist contains a blocked name: ${name}`);
    }
    const value = hostEnv[name];
    if (typeof value === "string") {
      out[name] = value;
    }
  }

  // Forced runtime-dedicated home + temp under it.
  out.HOME = options.runtimeHome;

  for (const [name, value] of Object.entries(options.explicit ?? {})) {
    if (isBlockedEnvName(name)) {
      throw new Error(`explicit env contains a blocked name: ${name}`);
    }
    out[name] = value;
  }

  return out;
}
