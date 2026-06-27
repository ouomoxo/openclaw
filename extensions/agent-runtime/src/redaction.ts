/** Secret redaction for artifact bytes (R5). Best-effort: never modifies source files, only stored copies. */

const SECRET_LINE =
  /((?:authorization|api[_-]?key|secret|token|password|passwd|bearer|private[_-]?key)\s*[:=]\s*)(\S+)/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._-]{10,}/gi;
const AWS = /\b(AKIA|ASIA)[A-Z0-9]{12,}\b/g;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g;

export function redactSecrets(text: string): string {
  return text
    .replace(PRIVATE_KEY_BLOCK, "[REDACTED PRIVATE KEY]")
    .replace(SECRET_LINE, (_m, k: string) => `${k}[REDACTED]`)
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(AWS, "[REDACTED]");
}
