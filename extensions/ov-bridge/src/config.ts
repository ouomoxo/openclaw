import type { OvBridgeConfig } from "./types.js";

export type ConfigResult =
  | { ok: true; config: OvBridgeConfig }
  | { ok: false; code: "CONFIGURATION_ERROR"; message: string };

export interface ConfigSource {
  env?: Record<string, string | undefined>;
  pluginConfig?: unknown;
}

const DEFAULTS = {
  contractVersion: "1.0" as const,
  requestTimeoutMs: 10_000,
  maxRetries: 2,
};

/** Hosts allowed over plaintext http: loopback, RFC1918 private, .local, Tailscale CGNAT (100.64/10). */
function isLoopbackOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return true;
  }
  if (host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host.startsWith("10.") || host.startsWith("192.168.")) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) {
    return true;
  }
  // Tailscale tailnet CGNAT range 100.64.0.0/10
  const m = /^100\.(\d{1,3})\./.exec(host);
  if (m && Number(m[1]) >= 64 && Number(m[1]) <= 127) {
    return true;
  }
  return false;
}

function pick(pluginConfig: Record<string, unknown> | undefined, key: string): unknown {
  return pluginConfig ? pluginConfig[key] : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/**
 * Resolve and validate OV bridge config from plugin config (precedence) then env.
 * Returns a structured CONFIGURATION_ERROR instead of throwing so the tool can map it cleanly.
 */
export function resolveOvBridgeConfig(source: ConfigSource): ConfigResult {
  const env = source.env ?? {};
  const pc =
    source.pluginConfig && typeof source.pluginConfig === "object"
      ? (source.pluginConfig as Record<string, unknown>)
      : undefined;

  const apiBaseUrlRaw = asString(pick(pc, "apiBaseUrl")) ?? env.OV_API_BASE_URL;
  const serviceTokenRaw = asString(pick(pc, "serviceToken")) ?? env.OV_SERVICE_TOKEN;
  const contractVersion =
    asString(pick(pc, "contractVersion")) ?? env.OV_CONTRACT_VERSION ?? DEFAULTS.contractVersion;
  const requestTimeoutMs =
    asNumber(pick(pc, "requestTimeoutMs")) ??
    asNumber(env.OV_REQUEST_TIMEOUT_MS) ??
    DEFAULTS.requestTimeoutMs;
  const maxRetries =
    asNumber(pick(pc, "maxRetries")) ?? asNumber(env.OV_MAX_RETRIES) ?? DEFAULTS.maxRetries;

  const apiBaseUrl = apiBaseUrlRaw?.trim();
  const serviceToken = serviceTokenRaw?.trim();

  if (!apiBaseUrl) {
    return {
      ok: false,
      code: "CONFIGURATION_ERROR",
      message: "Missing OV API base URL (OV_API_BASE_URL).",
    };
  }
  if (!serviceToken) {
    return {
      ok: false,
      code: "CONFIGURATION_ERROR",
      message: "Missing OV service token (OV_SERVICE_TOKEN).",
    };
  }

  let url: URL;
  try {
    url = new URL(apiBaseUrl);
  } catch {
    return {
      ok: false,
      code: "CONFIGURATION_ERROR",
      message: "OV API base URL is not a valid URL.",
    };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      ok: false,
      code: "CONFIGURATION_ERROR",
      message: "OV API base URL must use http or https.",
    };
  }
  if (url.protocol === "http:" && !isLoopbackOrPrivateHost(url.hostname)) {
    return {
      ok: false,
      code: "CONFIGURATION_ERROR",
      message:
        "Plaintext http is only allowed for loopback/private hosts; use https for external OV.",
    };
  }

  if (contractVersion !== "1.0") {
    return {
      ok: false,
      code: "CONFIGURATION_ERROR",
      message: `Unsupported contract version "${contractVersion}"; this bridge speaks 1.0.`,
    };
  }
  if (requestTimeoutMs <= 0) {
    return {
      ok: false,
      code: "CONFIGURATION_ERROR",
      message: "requestTimeoutMs must be positive.",
    };
  }
  if (maxRetries < 0 || !Number.isInteger(maxRetries)) {
    return {
      ok: false,
      code: "CONFIGURATION_ERROR",
      message: "maxRetries must be a non-negative integer.",
    };
  }

  return {
    ok: true,
    config: { apiBaseUrl, serviceToken, contractVersion: "1.0", requestTimeoutMs, maxRetries },
  };
}
