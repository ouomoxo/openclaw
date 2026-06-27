// Qa Lab plugin module implements WhatsApp-specific fake-provider runtime setup.
import fs from "node:fs/promises";
import path from "node:path";
import type { QaCrablineProviderRuntime, QaStartedOpenClawCrablineAdapter } from "./types.js";

async function stageWhatsAppAuthDir(params: {
  adapter: QaStartedOpenClawCrablineAdapter;
  outputDir: string;
}): Promise<string> {
  const selfJid = params.adapter.manifest.selfJid?.trim() || "15550000000@s.whatsapp.net";
  const authDir = path.join(params.outputDir, "artifacts", "crabline", "whatsapp-auth");
  await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(authDir, "creds.json"),
    `${JSON.stringify({ me: { id: selfJid } }, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  return authDir;
}

export const WHATSAPP_FAKE_PROVIDER_RUNTIME: QaCrablineProviderRuntime = {
  channel: "whatsapp",
  async setup({ adapter, outputDir }) {
    const authDir = await stageWhatsAppAuthDir({ adapter, outputDir });
    return {
      createGatewayConfigInput() {
        return {
          channels: {
            whatsapp: {
              accounts: {
                [adapter.accountId]: {
                  authDir,
                  enabled: true,
                },
              },
            },
          },
        };
      },
      createRuntimeEnvPatch() {
        const { CRABLINE_WHATSAPP_ADMIN_TOKEN: _adminToken, ...env } =
          adapter.createChannelDriverSmokeEnv({});
        return env;
      },
    };
  },
};
