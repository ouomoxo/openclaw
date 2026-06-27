import { describe, it, expect } from "vitest";
import { buildSanitizedEnv, isBlockedEnvName } from "../src/env-allowlist.js";

const hostEnv: Record<string, string> = {
  PATH: "/usr/bin",
  LANG: "en_US.UTF-8",
  HOME: "/Users/real",
  OV_SERVICE_TOKEN: "leak-ov",
  GITHUB_TOKEN: "leak-gh",
  AWS_SECRET_ACCESS_KEY: "leak-aws",
  SSH_AUTH_SOCK: "/tmp/ssh.sock",
  ANTHROPIC_API_KEY: "leak-anthropic",
  SOME_PASSWORD: "leak-pw",
};

describe("buildSanitizedEnv", () => {
  it("carries only allowlisted names and forces the runtime HOME", () => {
    const env = buildSanitizedEnv({ runtimeHome: "/rt/homes/run1" }, hostEnv);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.HOME).toBe("/rt/homes/run1");
  });

  it("never carries host secret values", () => {
    const env = buildSanitizedEnv({ runtimeHome: "/rt" }, hostEnv);
    const json = JSON.stringify(env);
    for (const v of ["leak-ov", "leak-gh", "leak-aws", "leak-anthropic", "leak-pw"]) {
      expect(json).not.toContain(v);
    }
    expect(env.OV_SERVICE_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("no resulting env name is a blocked/secret name", () => {
    const env = buildSanitizedEnv(
      { runtimeHome: "/rt", explicit: { GIT_AUTHOR_NAME: "Agent Runtime" } },
      hostEnv,
    );
    for (const name of Object.keys(env)) {
      expect(isBlockedEnvName(name)).toBe(false);
    }
  });

  it("fails closed when the allowlist contains a blocked name", () => {
    expect(() =>
      buildSanitizedEnv({ runtimeHome: "/rt", allowlist: ["PATH", "GITHUB_TOKEN"] }, hostEnv),
    ).toThrow();
  });

  it("fails closed when an explicit value uses a blocked name", () => {
    expect(() =>
      buildSanitizedEnv({ runtimeHome: "/rt", explicit: { MY_TOKEN: "x" } }, hostEnv),
    ).toThrow();
  });
});
