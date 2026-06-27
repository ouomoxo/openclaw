/** Secret redaction for artifact bytes (R5). Best-effort: never modifies source files, only stored copies. */

const SECRET_LINE =
  /((?:authorization|api[_-]?key|secret|token|password|passwd|bearer|private[_-]?key)\s*[:=]\s*)(\S+)/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._-]{10,}/gi;
const AWS = /\b(AKIA|ASIA)[A-Z0-9]{12,}\b/g;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g;

const PROVIDER_TOKENS =
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,})\b/g;
const CONN_URL = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s:@/]+@/gi;

export function redactSecrets(text: string): string {
  return text
    .replace(PRIVATE_KEY_BLOCK, "[REDACTED PRIVATE KEY]")
    .replace(SECRET_LINE, (_m, k: string) => `${k}[REDACTED]`)
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(AWS, "[REDACTED]")
    .replace(PROVIDER_TOKENS, "[REDACTED]")
    .replace(CONN_URL, (_m, scheme) => `${scheme}[REDACTED]@`);
}

/** Safe, bounded error message: first line only, absolute paths stripped, length-capped. */
export function safeErrorMessage(input: unknown, max = 200): string {
  let text =
    typeof input === "string" ? input : input instanceof Error ? input.message : "Unknown error";
  text = text.split("\n")[0] ?? text;
  text = text.replace(/(?:\/[^\s:]+)+/g, "[path]").replace(/[A-Za-z]:\\[^\s:]+/g, "[path]");
  if (text.length > max) {
    text = `${text.slice(0, max)}…`;
  }
  return text.trim() || "Unknown error";
}
