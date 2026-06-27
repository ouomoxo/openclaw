// Qa Lab plugin module implements Telegram fake-provider runtime setup.
import { createDefaultFakeProviderRuntime } from "./shared.js";

export const TELEGRAM_FAKE_PROVIDER_RUNTIME = createDefaultFakeProviderRuntime("telegram");
