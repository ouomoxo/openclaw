// QA Lab tests cover fake-provider runtime hook installation.
import {
  getWhatsAppMonitorRuntimeOptions,
  setWhatsAppMonitorRuntimeOptions,
} from "@openclaw/whatsapp/runtime-setter-api.js";
import { beforeEach, describe, expect, it } from "vitest";
import { installFakeProviderRuntimeHooks } from "./fake-provider-runtime-hooks.js";

describe("installFakeProviderRuntimeHooks", () => {
  beforeEach(() => {
    setWhatsAppMonitorRuntimeOptions();
  });

  it("registers the WhatsApp fake-provider socket when the fake provider env is present", () => {
    installFakeProviderRuntimeHooks({
      CRABLINE_WHATSAPP_API_ROOT: "http://127.0.0.1:49152/crabline/whatsapp",
    });

    expect(getWhatsAppMonitorRuntimeOptions().createSocket).toBeTypeOf("function");
  });

  it("leaves WhatsApp monitor options untouched without fake-provider env", () => {
    installFakeProviderRuntimeHooks({});

    expect(getWhatsAppMonitorRuntimeOptions()).toEqual({});
  });
});
