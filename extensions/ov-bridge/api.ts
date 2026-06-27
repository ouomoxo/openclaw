// OV Bridge public SDK surface. Plugins import only from openclaw/plugin-sdk/* and local barrels.
export { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
export type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  AnyAgentTool,
} from "openclaw/plugin-sdk/plugin-entry";
export { jsonResult } from "openclaw/plugin-sdk/core";
