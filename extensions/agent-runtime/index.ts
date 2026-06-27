// Agent Execution Runtime plugin entry.
// EXPERIMENTAL: fixture/temp repositories only; not production-eligible (see docs/ov-integration/ADR-runtime-executor.md).
// The runtime is shipped as library modules under ./src; gateway/service wiring (ACP binding via
// getAcpSessionManager) lands with the Single Worker phase (OC-R7).
import { definePluginEntry } from "./api.js";

export default definePluginEntry({
  id: "agent-runtime",
  name: "Agent Execution Runtime",
  description: "Experimental worker-run execution runtime over ACP (fixture/temp repos only).",
  register() {
    // No runtime registration yet — worker/service wiring is added in a later phase.
  },
});
