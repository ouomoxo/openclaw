import { describe, it, expect } from "vitest";
import {
  buildSecurityPosture,
  defaultExperimentalPosture,
  buildSecurityPostureEvent,
} from "../src/security-posture.js";

describe("security posture", () => {
  it("default experimental posture is not production-eligible", () => {
    const p = defaultExperimentalPosture();
    expect(p.environmentSanitized).toBe(true);
    expect(p.workspaceIsolated).toBe(true);
    expect(p.processUserVerifiedNonRoot).toBe(false);
    expect(p.resourceLimitsVerified).toBe(false);
    expect(p.networkIsolationVerified).toBe(false);
    expect(p.productionEligible).toBe(false);
    expect(p.limitations.length).toBeGreaterThan(0);
  });

  it("productionEligible is true only when every boundary is verified", () => {
    const all = buildSecurityPosture({
      environmentSanitized: true,
      workspaceIsolated: true,
      processUserVerifiedNonRoot: true,
      resourceLimitsVerified: true,
      networkIsolationVerified: true,
    });
    expect(all.productionEligible).toBe(true);
    const missingOne = buildSecurityPosture({
      environmentSanitized: true,
      workspaceIsolated: true,
      processUserVerifiedNonRoot: true,
      resourceLimitsVerified: true,
      networkIsolationVerified: false,
    });
    expect(missingOne.productionEligible).toBe(false);
  });

  it("posture event marks container isolation unverified and not production-eligible", () => {
    const e = buildSecurityPostureEvent(defaultExperimentalPosture());
    expect(e.type).toBe("RUNTIME_SECURITY_POSTURE_RECORDED");
    expect(e.containerIsolationVerified).toBe(false);
    expect(e.productionEligible).toBe(false);
    expect(e.sandboxLevel).toBe("workspace-isolated-env-sanitized");
  });
});
