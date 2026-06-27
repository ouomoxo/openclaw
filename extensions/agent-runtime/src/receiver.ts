/** Runtime event receiver (R6). Mock receiver for tests; OvRuntimeEventReceiver comes later. */
import type { RuntimeEvent } from "./events.js";

export interface DeliveryResult {
  ok: boolean;
  /** Permanent failures must NOT be retried (schema-invalid, 401/403, unsupported version, permanent reject). */
  permanent?: boolean;
  errorCode?: string;
}

export interface RuntimeEventReceiver {
  send(event: RuntimeEvent): Promise<DeliveryResult>;
}

export type MockFailScenario =
  | "network"
  | "rate-limited"
  | "unavailable"
  | "invalid-schema"
  | "forbidden"
  | "unsupported-version";

export interface MockReceiverOptions {
  /** Number of initial deliveries that fail before succeeding (for retry tests). */
  failTimes?: number;
  failScenario?: MockFailScenario;
}

export interface MockReceiver extends RuntimeEventReceiver {
  /** All deliveries received, including duplicates (the receiver is idempotent but accepts repeats). */
  readonly received: RuntimeEvent[];
  /** Distinct event ids seen (idempotency view). */
  uniqueEventIds(): string[];
  reset(): void;
}

const PERMANENT: ReadonlySet<MockFailScenario> = new Set([
  "invalid-schema",
  "forbidden",
  "unsupported-version",
]);

export function createMockReceiver(options: MockReceiverOptions = {}): MockReceiver {
  const received: RuntimeEvent[] = [];
  const seen = new Set<string>();
  let remainingFailures = options.failTimes ?? 0;

  return {
    received,
    uniqueEventIds: () => [...seen],
    reset() {
      received.length = 0;
      seen.clear();
      remainingFailures = options.failTimes ?? 0;
    },
    async send(event) {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        const scenario = options.failScenario ?? "network";
        return { ok: false, permanent: PERMANENT.has(scenario), errorCode: scenario.toUpperCase() };
      }
      // Idempotent: duplicate eventId is accepted (recorded) but counted once in the unique view.
      received.push(event);
      seen.add(event.eventId);
      return { ok: true };
    },
  };
}
