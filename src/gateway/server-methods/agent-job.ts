import { AGENT_RUN_ABORTED_ERROR, isAbortedAgentStopReason } from "../../agents/run-termination.js";
import {
  isHardAgentRunTimeoutPhase,
  normalizeAgentRunTimeoutPhase,
  normalizeProviderStarted,
  type AgentRunTimeoutPhase,
} from "../../agents/run-timeout-attribution.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { formatBlockedLivenessError, isBlockedLivenessState } from "../../shared/agent-liveness.js";
import { setSafeTimeout } from "../../utils/timer-delay.js";

const AGENT_RUN_CACHE_TTL_MS = 10 * 60_000;
/**
 * Embedded runs can emit transient lifecycle `error` events while auth/model
 * failover is still in progress. Give errors a short grace window so a
 * subsequent `start` event can cancel premature terminal snapshots.
 */
const AGENT_RUN_ERROR_RETRY_GRACE_MS = 15_000;
/**
 * Some embedded runtimes emit an intermediate lifecycle `end` with
 * `aborted=true` immediately before retrying the same run. Hold timeout
 * snapshots briefly so `agent.wait` does not resolve to a stale timeout when a
 * final success is about to arrive.
 */
const AGENT_RUN_TIMEOUT_RETRY_GRACE_MS = 15_000;
const MIN_COMPARABLE_EPOCH_MS = Date.parse("2000-01-01T00:00:00Z");

const agentRunCache = new Map<string, AgentRunSnapshot>();
const agentRunStarts = new Map<string, number>();
const pendingAgentRunErrors = new Map<string, PendingAgentRunError>();
const pendingAgentRunTimeouts = new Map<string, PendingAgentRunTerminal>();
const agentRunWaiterCounts = new Map<string, number>();
let agentRunListenerStarted = false;

type AgentRunSnapshot = {
  runId: string;
  status: "ok" | "error" | "timeout";
  startedAt?: number;
  endedAt?: number;
  error?: string;
  stopReason?: string;
  livenessState?: string;
  yielded?: boolean;
  pendingError?: boolean;
  hardTimeout?: boolean;
  deferTimeoutSurface?: boolean;
  timeoutPhase?: AgentRunTimeoutPhase;
  providerStarted?: boolean;
  ts: number;
};

type PendingAgentRunTerminal = {
  snapshot: AgentRunSnapshot;
  dueAt: number;
  timer: NodeJS.Timeout;
};

type PendingAgentRunError = PendingAgentRunTerminal;

function pruneAgentRunCache(now = Date.now()) {
  for (const [runId, entry] of agentRunCache) {
    if (now - entry.ts > AGENT_RUN_CACHE_TTL_MS) {
      agentRunCache.delete(runId);
    }
  }
}

function stripPendingOnlySnapshotFields(entry: AgentRunSnapshot): AgentRunSnapshot {
  if (entry.deferTimeoutSurface !== true) {
    return entry;
  }
  const { deferTimeoutSurface: _deferTimeoutSurface, ...publicEntry } = entry;
  return publicEntry;
}

function recordAgentRunSnapshot(entry: AgentRunSnapshot) {
  pruneAgentRunCache(entry.ts);
  const existing = agentRunCache.get(entry.runId);
  if (existing?.hardTimeout === true) {
    if (entry.status === "timeout") {
      agentRunCache.set(
        entry.runId,
        stripPendingOnlySnapshotFields(mergeHardTimeoutSnapshot(existing, entry)),
      );
      return;
    }
    if (shouldKeepHardTimeoutOverSnapshot(existing, entry)) {
      return;
    }
  }
  agentRunCache.set(entry.runId, stripPendingOnlySnapshotFields(entry));
}

function clearPendingAgentRunError(runId: string) {
  const pending = pendingAgentRunErrors.get(runId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingAgentRunErrors.delete(runId);
}

function clearPendingAgentRunTimeout(runId: string) {
  const pending = pendingAgentRunTimeouts.get(runId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingAgentRunTimeouts.delete(runId);
}

function schedulePendingAgentRunError(snapshot: AgentRunSnapshot) {
  clearPendingAgentRunTimeout(snapshot.runId);
  clearPendingAgentRunError(snapshot.runId);
  const dueAt = Date.now() + AGENT_RUN_ERROR_RETRY_GRACE_MS;
  const timer = setTimeout(() => {
    const pending = pendingAgentRunErrors.get(snapshot.runId);
    if (!pending) {
      return;
    }
    pendingAgentRunErrors.delete(snapshot.runId);
    recordAgentRunSnapshot(pending.snapshot);
  }, AGENT_RUN_ERROR_RETRY_GRACE_MS);
  timer.unref?.();
  pendingAgentRunErrors.set(snapshot.runId, { snapshot, dueAt, timer });
}

function mergeHardTimeoutSnapshot(
  existing: AgentRunSnapshot,
  snapshot: AgentRunSnapshot,
): AgentRunSnapshot {
  return {
    ...existing,
    error: existing.error ?? snapshot.error,
    stopReason: existing.stopReason ?? snapshot.stopReason,
    livenessState: existing.livenessState ?? snapshot.livenessState,
    yielded: existing.yielded ?? snapshot.yielded,
    pendingError: existing.pendingError ?? snapshot.pendingError,
    timeoutPhase: existing.timeoutPhase ?? snapshot.timeoutPhase,
    providerStarted: existing.providerStarted ?? snapshot.providerStarted,
    hardTimeout: true,
    deferTimeoutSurface: existing.deferTimeoutSurface === true,
  };
}

function schedulePendingAgentRunTimeout(snapshot: AgentRunSnapshot) {
  clearPendingAgentRunError(snapshot.runId);
  const existing = pendingAgentRunTimeouts.get(snapshot.runId);
  if (existing?.snapshot.hardTimeout === true) {
    existing.snapshot = mergeHardTimeoutSnapshot(existing.snapshot, snapshot);
    return;
  }
  clearPendingAgentRunTimeout(snapshot.runId);
  const dueAt = Date.now() + AGENT_RUN_TIMEOUT_RETRY_GRACE_MS;
  const timer = setTimeout(() => {
    const pending = pendingAgentRunTimeouts.get(snapshot.runId);
    if (!pending) {
      return;
    }
    pendingAgentRunTimeouts.delete(snapshot.runId);
    recordAgentRunSnapshot(pending.snapshot);
  }, AGENT_RUN_TIMEOUT_RETRY_GRACE_MS);
  timer.unref?.();
  pendingAgentRunTimeouts.set(snapshot.runId, { snapshot, dueAt, timer });
}

function getPendingAgentRunError(runId: string) {
  const pending = pendingAgentRunErrors.get(runId);
  if (!pending) {
    return undefined;
  }
  return {
    snapshot: pending.snapshot,
    dueAt: pending.dueAt,
  };
}

function getPendingAgentRunTimeout(runId: string) {
  const pending = pendingAgentRunTimeouts.get(runId);
  if (!pending) {
    return undefined;
  }
  return {
    snapshot: pending.snapshot,
    dueAt: pending.dueAt,
  };
}

function createPendingErrorTimeoutSnapshot(snapshot: AgentRunSnapshot): AgentRunSnapshot {
  // Keep this non-terminal: the retry grace can still be canceled by a later
  // lifecycle start, so omit terminal fields such as endedAt and stopReason.
  return {
    runId: snapshot.runId,
    status: "timeout",
    startedAt: snapshot.startedAt,
    error: snapshot.error,
    pendingError: true,
    ...(snapshot.providerStarted !== undefined
      ? { providerStarted: snapshot.providerStarted }
      : {}),
    ts: Date.now(),
  };
}

function shouldSurfacePendingTimeoutSnapshot(
  snapshot: AgentRunSnapshot,
  opts?: { dueAt?: number; now?: number },
): boolean {
  const now = opts?.now ?? Date.now();
  return (
    snapshot.status === "timeout" &&
    snapshot.hardTimeout === true &&
    (snapshot.deferTimeoutSurface !== true ||
      (typeof opts?.dueAt === "number" && opts.dueAt <= now))
  );
}

function shouldKeepHardTimeoutOverSnapshot(
  hardTimeoutSnapshot: AgentRunSnapshot | undefined,
  snapshot: AgentRunSnapshot,
): boolean {
  if (hardTimeoutSnapshot?.hardTimeout !== true || snapshot.status === "timeout") {
    return false;
  }
  if (typeof hardTimeoutSnapshot.endedAt !== "number") {
    return true;
  }
  return typeof snapshot.endedAt !== "number" || snapshot.endedAt > hardTimeoutSnapshot.endedAt;
}

function isBeforeFreshLifecycleWindow(params: {
  snapshot: AgentRunSnapshot;
  ignoreLifecycleEventsBeforeMs?: number;
}) {
  const { ignoreLifecycleEventsBeforeMs, snapshot } = params;
  if (
    typeof ignoreLifecycleEventsBeforeMs !== "number" ||
    ignoreLifecycleEventsBeforeMs < MIN_COMPARABLE_EPOCH_MS
  ) {
    return false;
  }
  const terminalAt = snapshot.endedAt ?? snapshot.startedAt;
  return (
    typeof terminalAt === "number" &&
    terminalAt >= MIN_COMPARABLE_EPOCH_MS &&
    terminalAt < ignoreLifecycleEventsBeforeMs
  );
}

function createSnapshotFromLifecycleEvent(params: {
  runId: string;
  phase: "end" | "error";
  data?: Record<string, unknown>;
}): AgentRunSnapshot {
  const { runId, phase, data } = params;
  const startedAt =
    typeof data?.startedAt === "number" ? data.startedAt : agentRunStarts.get(runId);
  const endedAt = typeof data?.endedAt === "number" ? data.endedAt : undefined;
  const error = typeof data?.error === "string" ? data.error : undefined;
  const stopReason = typeof data?.stopReason === "string" ? data.stopReason : undefined;
  const livenessState = typeof data?.livenessState === "string" ? data.livenessState : undefined;
  const blocked = isBlockedLivenessState(livenessState);
  const abortedStopReason = isAbortedAgentStopReason(stopReason);
  const timeoutPhase = normalizeAgentRunTimeoutPhase(data?.timeoutPhase);
  const hardTimeoutPhase = isHardAgentRunTimeoutPhase(timeoutPhase);
  const abortedEnd = phase === "end" && data?.aborted === true;
  const status = hardTimeoutPhase
    ? "timeout"
    : phase === "error" || blocked || abortedStopReason
      ? "error"
      : data?.aborted
        ? "timeout"
        : "ok";
  const resolvedError =
    abortedStopReason && !hardTimeoutPhase && !error ? AGENT_RUN_ABORTED_ERROR : error;
  const providerStarted = normalizeProviderStarted(data?.providerStarted);
  return {
    runId,
    status,
    startedAt,
    endedAt,
    error: blocked ? formatBlockedLivenessError(resolvedError) : resolvedError,
    stopReason,
    livenessState,
    ...(data?.yielded === true ? { yielded: true } : {}),
    ...(hardTimeoutPhase ? { hardTimeout: true } : {}),
    ...(abortedEnd && timeoutPhase !== "post_turn" ? { deferTimeoutSurface: true } : {}),
    ...(timeoutPhase ? { timeoutPhase } : {}),
    ...(providerStarted !== undefined ? { providerStarted } : {}),
    ts: Date.now(),
  };
}

function ensureAgentRunListener() {
  if (agentRunListenerStarted) {
    return;
  }
  agentRunListenerStarted = true;
  onAgentEvent((evt) => {
    if (!evt) {
      return;
    }
    if (evt.stream !== "lifecycle") {
      return;
    }
    const phase = evt.data?.phase;
    if (phase === "start") {
      const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
      agentRunStarts.set(evt.runId, startedAt ?? Date.now());
      clearPendingAgentRunError(evt.runId);
      clearPendingAgentRunTimeout(evt.runId);
      // A new start means this run is active again (or retried). Drop stale
      // terminal snapshots so waiters don't resolve from old state.
      agentRunCache.delete(evt.runId);
      return;
    }
    if (phase !== "end" && phase !== "error") {
      return;
    }
    const snapshot = createSnapshotFromLifecycleEvent({
      runId: evt.runId,
      phase,
      data: evt.data,
    });
    agentRunStarts.delete(evt.runId);
    if (snapshot.status === "timeout") {
      schedulePendingAgentRunTimeout(snapshot);
      return;
    }
    const pendingTimeout = pendingAgentRunTimeouts.get(evt.runId);
    if (shouldKeepHardTimeoutOverSnapshot(pendingTimeout?.snapshot, snapshot)) {
      return;
    }
    if (phase === "error") {
      schedulePendingAgentRunError(snapshot);
      return;
    }
    clearPendingAgentRunError(evt.runId);
    clearPendingAgentRunTimeout(evt.runId);
    recordAgentRunSnapshot(snapshot);
  });
}

function getCachedAgentRun(runId: string) {
  pruneAgentRunCache();
  return agentRunCache.get(runId);
}

function addAgentRunWaiter(runId: string): () => void {
  agentRunWaiterCounts.set(runId, (agentRunWaiterCounts.get(runId) ?? 0) + 1);
  let removed = false;
  return () => {
    if (removed) {
      return;
    }
    removed = true;
    const nextCount = (agentRunWaiterCounts.get(runId) ?? 1) - 1;
    if (nextCount <= 0) {
      agentRunWaiterCounts.delete(runId);
      return;
    }
    agentRunWaiterCounts.set(runId, nextCount);
  };
}

export async function waitForAgentJob(params: {
  runId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  ignoreCachedSnapshot?: boolean;
  ignoreLifecycleEventsBeforeMs?: number;
}): Promise<AgentRunSnapshot | null> {
  const {
    runId,
    timeoutMs,
    signal,
    ignoreCachedSnapshot = false,
    ignoreLifecycleEventsBeforeMs,
  } = params;
  ensureAgentRunListener();
  const cached = ignoreCachedSnapshot ? undefined : getCachedAgentRun(runId);
  if (cached) {
    return cached;
  }
  const pendingTimeout = getPendingAgentRunTimeout(runId);
  if (
    pendingTimeout &&
    !isBeforeFreshLifecycleWindow({
      snapshot: pendingTimeout.snapshot,
      ignoreLifecycleEventsBeforeMs,
    }) &&
    (!ignoreCachedSnapshot ||
      pendingTimeout.snapshot.hardTimeout === true ||
      pendingTimeout.snapshot.timeoutPhase) &&
    shouldSurfacePendingTimeoutSnapshot(pendingTimeout.snapshot, {
      dueAt: pendingTimeout.dueAt,
    })
  ) {
    const snapshot = pendingTimeout.snapshot;
    clearPendingAgentRunTimeout(runId);
    recordAgentRunSnapshot(snapshot);
    return stripPendingOnlySnapshotFields(snapshot);
  }
  if (timeoutMs <= 0 || signal?.aborted) {
    return null;
  }

  return await new Promise((resolve) => {
    let settled = false;
    let pendingErrorTimer: NodeJS.Timeout | undefined;
    let pendingTimeoutTimer: NodeJS.Timeout | undefined;
    let pendingTimeoutSnapshot: AgentRunSnapshot | undefined;
    let onAbort: (() => void) | undefined;
    let removeWaiter = () => {};

    const clearPendingErrorTimer = () => {
      if (!pendingErrorTimer) {
        return;
      }
      clearTimeout(pendingErrorTimer);
      pendingErrorTimer = undefined;
    };

    const clearPendingTimeoutTimer = () => {
      if (!pendingTimeoutTimer) {
        return;
      }
      clearTimeout(pendingTimeoutTimer);
      pendingTimeoutTimer = undefined;
      pendingTimeoutSnapshot = undefined;
    };

    const finish = (entry: AgentRunSnapshot | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearPendingErrorTimer();
      clearPendingTimeoutTimer();
      unsubscribe();
      removeWaiter();
      if (onAbort) {
        signal?.removeEventListener("abort", onAbort);
      }
      resolve(entry ? stripPendingOnlySnapshotFields(entry) : null);
    };

    const scheduleTerminalFinish = (
      kind: "error" | "timeout",
      snapshot: AgentRunSnapshot,
      delayMs: number,
    ) => {
      if (kind === "timeout" && pendingTimeoutSnapshot?.hardTimeout === true) {
        pendingTimeoutSnapshot = mergeHardTimeoutSnapshot(pendingTimeoutSnapshot, snapshot);
        return;
      }
      clearPendingErrorTimer();
      clearPendingTimeoutTimer();
      if (kind === "timeout") {
        pendingTimeoutSnapshot = snapshot;
      }
      const timerRef = setSafeTimeout(() => {
        const latest = ignoreCachedSnapshot ? undefined : getCachedAgentRun(runId);
        if (latest) {
          finish(latest);
          return;
        }
        const terminalSnapshot =
          kind === "timeout" ? (pendingTimeoutSnapshot ?? snapshot) : snapshot;
        recordAgentRunSnapshot(terminalSnapshot);
        finish(terminalSnapshot);
      }, delayMs);
      timerRef.unref?.();
      if (kind === "error") {
        pendingErrorTimer = timerRef;
      } else {
        pendingTimeoutTimer = timerRef;
      }
    };

    const scheduleErrorFinish = (
      snapshot: AgentRunSnapshot,
      delayMs = AGENT_RUN_ERROR_RETRY_GRACE_MS,
    ) => {
      scheduleTerminalFinish("error", snapshot, delayMs);
    };

    const scheduleTimeoutFinish = (
      snapshot: AgentRunSnapshot,
      delayMs = snapshot.deferTimeoutSurface === true ||
      (snapshot.hardTimeout === true && snapshot.timeoutPhase !== "post_turn")
        ? AGENT_RUN_TIMEOUT_RETRY_GRACE_MS
        : 0,
    ) => {
      scheduleTerminalFinish("timeout", snapshot, delayMs);
    };

    if (!ignoreCachedSnapshot) {
      const pendingError = getPendingAgentRunError(runId);
      if (pendingError) {
        scheduleErrorFinish(pendingError.snapshot, pendingError.dueAt - Date.now());
      }
      const pendingTimeout = getPendingAgentRunTimeout(runId);
      if (pendingTimeout) {
        scheduleTimeoutFinish(pendingTimeout.snapshot, pendingTimeout.dueAt - Date.now());
      }
    }

    const unsubscribe = onAgentEvent((evt) => {
      if (!evt || evt.stream !== "lifecycle") {
        return;
      }
      if (evt.runId !== runId) {
        return;
      }
      const phase = evt.data?.phase;
      if (phase === "start") {
        clearPendingErrorTimer();
        clearPendingTimeoutTimer();
        return;
      }
      if (phase !== "end" && phase !== "error") {
        return;
      }
      const latest = ignoreCachedSnapshot ? undefined : getCachedAgentRun(runId);
      if (latest) {
        finish(latest);
        return;
      }
      const snapshot = createSnapshotFromLifecycleEvent({
        runId: evt.runId,
        phase,
        data: evt.data,
      });
      if (
        isBeforeFreshLifecycleWindow({
          snapshot,
          ignoreLifecycleEventsBeforeMs,
        })
      ) {
        return;
      }
      if (snapshot.status === "timeout") {
        scheduleTimeoutFinish(snapshot);
        return;
      }
      if (shouldKeepHardTimeoutOverSnapshot(pendingTimeoutSnapshot, snapshot)) {
        return;
      }
      if (phase === "error") {
        scheduleErrorFinish(snapshot);
        return;
      }
      recordAgentRunSnapshot(snapshot);
      finish(snapshot);
    });
    removeWaiter = addAgentRunWaiter(runId);

    const timer = setSafeTimeout(() => {
      const pendingTimeout = getPendingAgentRunTimeout(runId);
      if (
        pendingTimeout &&
        !isBeforeFreshLifecycleWindow({
          snapshot: pendingTimeout.snapshot,
          ignoreLifecycleEventsBeforeMs,
        }) &&
        shouldSurfacePendingTimeoutSnapshot(pendingTimeout.snapshot, {
          dueAt: pendingTimeout.dueAt,
        })
      ) {
        recordAgentRunSnapshot(pendingTimeout.snapshot);
        finish(pendingTimeout.snapshot);
        return;
      }
      const pendingError = getPendingAgentRunError(runId);
      if (
        pendingError &&
        isBeforeFreshLifecycleWindow({
          snapshot: pendingError.snapshot,
          ignoreLifecycleEventsBeforeMs,
        })
      ) {
        finish(null);
        return;
      }
      finish(pendingError ? createPendingErrorTimeoutSnapshot(pendingError.snapshot) : null);
    }, timeoutMs);
    onAbort = () => finish(null);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

ensureAgentRunListener();

export const testing = {
  getWaiterCount(runId?: string): number {
    if (runId) {
      return agentRunWaiterCounts.get(runId) ?? 0;
    }
    let total = 0;
    for (const count of agentRunWaiterCounts.values()) {
      total += count;
    }
    return total;
  },
  resetWaiters(): void {
    agentRunWaiterCounts.clear();
  },
};
export { testing as __testing };
