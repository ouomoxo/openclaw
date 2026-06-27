// Qa Lab plugin module defines fake-provider runtime extension points.
import type { StartedOpenClawCrablineAdapter } from "@openclaw/crabline";

export type QaCrablineChannelDriverSelection = {
  capabilityMatrixPath: "crabline-fake-provider-capabilities.json";
  channel: string;
  channelDriver: "crabline";
  smokeArtifactPath: "crabline-fake-provider-smoke.json";
};

export type QaCrablineManifest = {
  accessToken?: string;
  adminToken?: string;
  endpoints: {
    adminInboundUrl: string;
    apiRoot: string;
  };
  provider: string;
  recorderPath: string;
  selfJid?: string;
};

export type QaStartedOpenClawCrablineAdapter = Omit<StartedOpenClawCrablineAdapter, "manifest"> & {
  manifest: QaCrablineManifest;
};

export type QaCrablineProviderRuntimeSetup = {
  createGatewayConfigInput?(): Record<string, unknown>;
  createRuntimeEnvPatch(): NodeJS.ProcessEnv;
};

export type QaCrablineProviderRuntime = {
  channel: string;
  setup(params: {
    adapter: QaStartedOpenClawCrablineAdapter;
    outputDir: string;
  }): Promise<QaCrablineProviderRuntimeSetup>;
};
