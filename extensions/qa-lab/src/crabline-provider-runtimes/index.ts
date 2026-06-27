// Qa Lab plugin module resolves fake-provider runtime setup.
import { SLACK_FAKE_PROVIDER_RUNTIME } from "./slack.js";
import { TELEGRAM_FAKE_PROVIDER_RUNTIME } from "./telegram.js";
import type { QaCrablineProviderRuntime } from "./types.js";
import { WHATSAPP_FAKE_PROVIDER_RUNTIME } from "./whatsapp.js";

const QA_FAKE_PROVIDER_RUNTIMES = [
  SLACK_FAKE_PROVIDER_RUNTIME,
  TELEGRAM_FAKE_PROVIDER_RUNTIME,
  WHATSAPP_FAKE_PROVIDER_RUNTIME,
];

const QA_FAKE_PROVIDER_RUNTIME_BY_CHANNEL = new Map<string, QaCrablineProviderRuntime>(
  QA_FAKE_PROVIDER_RUNTIMES.map((runtime) => [runtime.channel, runtime]),
);

export function getQaCrablineProviderRuntime(channel: string): QaCrablineProviderRuntime {
  const runtime = QA_FAKE_PROVIDER_RUNTIME_BY_CHANNEL.get(channel);
  if (runtime) {
    return runtime;
  }
  throw new Error(
    [
      `QA Lab does not support Crabline fake-provider channel "${channel}".`,
      `supported QA Lab fake-provider channels: ${[...QA_FAKE_PROVIDER_RUNTIME_BY_CHANNEL.keys()].toSorted().join(", ")}`,
    ].join(" "),
  );
}

export type {
  QaCrablineChannelDriverSelection,
  QaCrablineProviderRuntimeSetup,
  QaStartedOpenClawCrablineAdapter,
} from "./types.js";
