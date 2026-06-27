// QA Lab plugin module installs fake-provider runtime hooks for channel plugins.
import { createWhatsAppSocket } from "@openclaw/crabline/whatsapp-socket-factory";
import {
  setWhatsAppMonitorRuntimeOptions,
  type WhatsAppCreateSocket,
  type WhatsAppSocket,
} from "@openclaw/whatsapp/runtime-setter-api.js";

function hasWhatsAppFakeProviderEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CRABLINE_WHATSAPP_API_ROOT?.trim());
}

const createFakeProviderWhatsAppSocket: WhatsAppCreateSocket = async (printQr, verbose) =>
  (await createWhatsAppSocket(printQr, verbose)) as WhatsAppSocket;

export function installFakeProviderRuntimeHooks(env: NodeJS.ProcessEnv = process.env): void {
  if (hasWhatsAppFakeProviderEnv(env)) {
    setWhatsAppMonitorRuntimeOptions({ createSocket: createFakeProviderWhatsAppSocket });
  }
}
