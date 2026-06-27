/**
 * Redaction helpers. The bridge must never surface the service token, full Authorization header,
 * stack traces, full raw HTTP bodies, the full rawInstruction, or internal filesystem paths.
 */

const SENSITIVE_KEYS = new Set([
  "authorization",
  "servicetoken",
  "token",
  "bearer",
  "ov_service_token",
  "password",
  "secret",
  "apikey",
  "api_key",
]);

const REDACTED = "[REDACTED]";

/** Mask a token, keeping only a short non-reversible hint of its length class. */
export function redactToken(token: string | undefined): string {
  if (!token) {
    return REDACTED;
  }
  return REDACTED;
}

/** Mask an Authorization header value. */
export function redactAuthorizationHeader(_value: string | undefined): string {
  return `Bearer ${REDACTED}`;
}

/** Truncate a potentially sensitive instruction so logs never carry the full text. */
export function truncateRawInstruction(value: string, max = 80): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}… (${value.length} chars, truncated)`;
}

/** Deep-redact known sensitive keys in an arbitrary value for safe logging. */
export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return REDACTED;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redactObject(val, depth + 1);
    }
    return out;
  }
  return value;
}

/** Build redacted HTTP headers for logging (Authorization always masked). */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

/**
 * Produce a safe, bounded error message: strips absolute filesystem paths, collapses anything that
 * looks like a stack trace, and caps length. Never returns a raw internal exception verbatim.
 */
export function safeErrorMessage(input: unknown, max = 200): string {
  let text =
    typeof input === "string" ? input : input instanceof Error ? input.message : "Unknown error";
  // Drop stack-trace tails.
  text = text.split("\n")[0] ?? text;
  // Strip absolute unix/home paths and Windows paths.
  text = text.replace(/(?:\/[^\s:]+)+/g, "[path]").replace(/[A-Za-z]:\\[^\s:]+/g, "[path]");
  if (text.length > max) {
    text = `${text.slice(0, max)}…`;
  }
  return text.trim() || "Unknown error";
}
