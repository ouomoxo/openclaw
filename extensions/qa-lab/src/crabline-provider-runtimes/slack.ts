// Qa Lab plugin module implements Slack fake-provider runtime setup.
import { createDefaultFakeProviderRuntime } from "./shared.js";

export const SLACK_FAKE_PROVIDER_RUNTIME = createDefaultFakeProviderRuntime("slack");
