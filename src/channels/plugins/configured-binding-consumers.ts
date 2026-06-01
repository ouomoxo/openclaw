import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  CompiledConfiguredBinding,
  ConfiguredBindingRecordResolution,
  ConfiguredBindingRuleConfig,
  ConfiguredBindingTargetFactory,
} from "./binding-types.js";
import type { ChannelConfiguredBindingConversationRef } from "./types.adapters.js";

/** Parsed routing fields extracted from a configured binding session key. */
export type ParsedConfiguredBindingSessionKey = {
  channel: string;
  accountId: string;
};

/** Consumer contract for binding config types that materialize stateful targets. */
export type ConfiguredBindingConsumer = {
  id: string;
  supports: (binding: ConfiguredBindingRuleConfig) => boolean;
  buildTargetFactory: (params: {
    cfg: OpenClawConfig;
    binding: ConfiguredBindingRuleConfig;
    channel: string;
    agentId: string;
    target: ChannelConfiguredBindingConversationRef;
    bindingConversationId: string;
  }) => ConfiguredBindingTargetFactory | null;
  parseSessionKey?: (params: { sessionKey: string }) => ParsedConfiguredBindingSessionKey | null;
  matchesSessionKey?: (params: {
    sessionKey: string;
    compiledBinding: CompiledConfiguredBinding;
    accountId: string;
    materializedTarget: ConfiguredBindingRecordResolution;
  }) => boolean;
};

const registeredConfiguredBindingConsumers = new Map<string, ConfiguredBindingConsumer>();

/** Lists registered configured-binding consumers in registration order. */
export function listConfiguredBindingConsumers(): ConfiguredBindingConsumer[] {
  return [...registeredConfiguredBindingConsumers.values()];
}

/** Resolves the first registered consumer that supports a raw binding config. */
export function resolveConfiguredBindingConsumer(
  binding: ConfiguredBindingRuleConfig,
): ConfiguredBindingConsumer | null {
  for (const consumer of listConfiguredBindingConsumers()) {
    if (consumer.supports(binding)) {
      return consumer;
    }
  }
  return null;
}

/** Registers a configured-binding consumer once by trimmed id. */
export function registerConfiguredBindingConsumer(consumer: ConfiguredBindingConsumer): void {
  const id = consumer.id.trim();
  if (!id) {
    throw new Error("Configured binding consumer id is required");
  }
  const existing = registeredConfiguredBindingConsumers.get(id);
  if (existing) {
    return;
  }
  registeredConfiguredBindingConsumers.set(id, {
    ...consumer,
    id,
  });
}
