// Qa Lab plugin module implements shared fake-provider runtime helpers.
import type {
  QaCrablineProviderRuntime,
  QaCrablineProviderRuntimeSetup,
  QaStartedOpenClawCrablineAdapter,
} from "./types.js";

type RuntimeEnvMapper = (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;

export function createDefaultFakeProviderRuntimeSetup(
  adapter: QaStartedOpenClawCrablineAdapter,
  options?: { mapRuntimeEnv?: RuntimeEnvMapper },
): QaCrablineProviderRuntimeSetup {
  return {
    createRuntimeEnvPatch: () =>
      options?.mapRuntimeEnv?.(adapter.createChannelDriverSmokeEnv({})) ??
      adapter.createChannelDriverSmokeEnv({}),
  };
}

export function createDefaultFakeProviderRuntime(
  channel: string,
  options?: { mapRuntimeEnv?: RuntimeEnvMapper },
): QaCrablineProviderRuntime {
  return {
    channel,
    async setup({ adapter }) {
      return createDefaultFakeProviderRuntimeSetup(adapter, options);
    },
  };
}
