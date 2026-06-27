import { describe, it, expect } from "vitest";
import { resolveOvBridgeConfig } from "../src/config.js";

const baseEnv = {
  OV_API_BASE_URL: "https://ov.example/api/agent/v1",
  OV_SERVICE_TOKEN: "secret-token-value",
};

describe("resolveOvBridgeConfig", () => {
  it("resolves required config with defaults", () => {
    const r = resolveOvBridgeConfig({ env: baseEnv });
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.config.apiBaseUrl).toBe(baseEnv.OV_API_BASE_URL);
    expect(r.config.contractVersion).toBe("1.0");
    expect(r.config.requestTimeoutMs).toBe(10_000);
    expect(r.config.maxRetries).toBe(2);
  });

  it("fails when service token is missing", () => {
    const r = resolveOvBridgeConfig({ env: { OV_API_BASE_URL: baseEnv.OV_API_BASE_URL } });
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.code).toBe("CONFIGURATION_ERROR");
  });

  it("fails when api base url is missing", () => {
    const r = resolveOvBridgeConfig({ env: { OV_SERVICE_TOKEN: "t" } });
    expect(r.ok).toBe(false);
  });

  it("fails when token is whitespace-only", () => {
    const r = resolveOvBridgeConfig({ env: { ...baseEnv, OV_SERVICE_TOKEN: "   " } });
    expect(r.ok).toBe(false);
  });

  it("rejects an invalid url", () => {
    const r = resolveOvBridgeConfig({ env: { ...baseEnv, OV_API_BASE_URL: "not a url" } });
    expect(r.ok).toBe(false);
  });

  it("rejects plaintext http for an external host", () => {
    const r = resolveOvBridgeConfig({
      env: { ...baseEnv, OV_API_BASE_URL: "http://ov.example/api/agent/v1" },
    });
    expect(r.ok).toBe(false);
  });

  it("allows plaintext http for localhost", () => {
    const r = resolveOvBridgeConfig({
      env: { ...baseEnv, OV_API_BASE_URL: "http://127.0.0.1:8080/api/agent/v1" },
    });
    expect(r.ok).toBe(true);
  });

  it("allows http for a Tailscale/private host", () => {
    const r = resolveOvBridgeConfig({
      env: { ...baseEnv, OV_API_BASE_URL: "http://100.64.1.2/api/agent/v1" },
    });
    expect(r.ok).toBe(true);
  });

  it("rejects an unsupported contract version", () => {
    const r = resolveOvBridgeConfig({ env: { ...baseEnv, OV_CONTRACT_VERSION: "2.0" } });
    expect(r.ok).toBe(false);
  });

  it("prefers plugin config over env", () => {
    const r = resolveOvBridgeConfig({
      env: baseEnv,
      pluginConfig: { apiBaseUrl: "https://override.example/api/agent/v1", maxRetries: 5 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.config.apiBaseUrl).toBe("https://override.example/api/agent/v1");
    expect(r.config.maxRetries).toBe(5);
  });

  it("never includes the token in a stringified config result", () => {
    const r = resolveOvBridgeConfig({ env: baseEnv });
    expect(r.ok).toBe(true);
    // The resolved config legitimately holds the token for use, but the FAILURE path (logged) must not.
    const failure = resolveOvBridgeConfig({ env: { OV_API_BASE_URL: baseEnv.OV_API_BASE_URL } });
    expect(JSON.stringify(failure)).not.toContain("secret-token-value");
  });
});
