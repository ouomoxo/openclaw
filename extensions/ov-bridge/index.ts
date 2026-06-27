// OV Bridge plugin entry. Registers ov_create_task; no core changes, no startup side effects.
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { createOvApiClient } from "./src/client/ov-api-client.js";
import { resolveOvBridgeConfig } from "./src/config.js";
import { createOvCreateTaskTool } from "./src/tools/create-task.js";

export default definePluginEntry({
  id: "ov-bridge",
  name: "OV Bridge",
  description: "OV Control Plane bridge: registers ov_create_task (first vertical slice).",
  register(api: OpenClawPluginApi) {
    const tool = createOvCreateTaskTool({
      resolveConfig: () =>
        resolveOvBridgeConfig({ env: process.env, pluginConfig: api.pluginConfig }),
      createClient: (config) => createOvApiClient(config),
    });
    api.registerTool(() => [tool], { names: ["ov_create_task"] });
  },
});
