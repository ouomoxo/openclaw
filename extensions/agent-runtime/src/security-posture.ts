/**
 * Security posture (ADR-8 / §11). Computed by the runtime and stamped onto results — never settable by the
 * model/worker. `productionEligible` requires ALL isolation boundaries verified; in this phase several are
 * known-false (see ADR-4 evidence), so it is always false here.
 */
import type { RuntimeSecurityPosture } from "./types.js";

/** Known limitations in the experimental phase (ADR-4 evidence). */
export const EXPERIMENTAL_LIMITATIONS: readonly string[] = [
  "ACP model process runs on host (no container isolation)",
  "ACP model process may inherit gateway environment (process isolation incomplete)",
  "no enforced CPU/RAM/PID resource limits",
  "no enforced outbound network isolation",
  "host credential paths may be visible to the ACP process",
];

export interface PostureMeasurements {
  environmentSanitized: boolean;
  workspaceIsolated: boolean;
  processUserVerifiedNonRoot: boolean;
  resourceLimitsVerified: boolean;
  networkIsolationVerified: boolean;
  limitations?: string[];
}

/** Build the posture. productionEligible is derived (AND of all boundaries) — not an input. */
export function buildSecurityPosture(m: PostureMeasurements): RuntimeSecurityPosture {
  const productionEligible =
    m.environmentSanitized &&
    m.workspaceIsolated &&
    m.processUserVerifiedNonRoot &&
    m.resourceLimitsVerified &&
    m.networkIsolationVerified;
  return {
    environmentSanitized: m.environmentSanitized,
    workspaceIsolated: m.workspaceIsolated,
    processUserVerifiedNonRoot: m.processUserVerifiedNonRoot,
    resourceLimitsVerified: m.resourceLimitsVerified,
    networkIsolationVerified: m.networkIsolationVerified,
    productionEligible,
    limitations: m.limitations ?? [...EXPERIMENTAL_LIMITATIONS],
  };
}

/** Default posture for this phase: env sanitized + workspace isolated, everything else unverified → not production-eligible. */
export function defaultExperimentalPosture(): RuntimeSecurityPosture {
  return buildSecurityPosture({
    environmentSanitized: true,
    workspaceIsolated: true,
    processUserVerifiedNonRoot: false,
    resourceLimitsVerified: false,
    networkIsolationVerified: false,
  });
}

export interface SecurityPostureEvent {
  type: "RUNTIME_SECURITY_POSTURE_RECORDED";
  sandboxLevel: "workspace-isolated-env-sanitized";
  containerIsolationVerified: false;
  networkIsolationVerified: boolean;
  productionEligible: boolean;
  posture: RuntimeSecurityPosture;
}

export function buildSecurityPostureEvent(posture: RuntimeSecurityPosture): SecurityPostureEvent {
  return {
    type: "RUNTIME_SECURITY_POSTURE_RECORDED",
    sandboxLevel: "workspace-isolated-env-sanitized",
    containerIsolationVerified: false,
    networkIsolationVerified: posture.networkIsolationVerified,
    productionEligible: posture.productionEligible,
    posture,
  };
}
