/**
 * Durable runtime-event outbox (R6). Candidate #2: a plugin-owned SQLite store (node:sqlite) — durable
 * across restarts, sequence-preserving, deduped by eventId, and decoupled from any core DB table. An
 * in-memory store mirrors the same semantics for fast tests. Delivery uses a Mock receiver with a bounded
 * retry + dead-letter policy. Crash-consistency invariant: an event is durably appended BEFORE any delivery.
 */
import { DatabaseSync } from "node:sqlite";
import type { RuntimeEvent } from "./events.js";
import type { DeliveryResult, RuntimeEventReceiver } from "./receiver.js";

export interface OutboxRecord {
  event: RuntimeEvent;
  status: "pending" | "delivered" | "dead-letter";
  attempts: number;
  nextAttemptAt?: string;
  lastErrorCode?: string;
}

export interface OutboxStore {
  /** Durable append (dedup by eventId). Must be called BEFORE any external delivery. */
  append(event: RuntimeEvent): void;
  /** Pending records eligible for delivery now, in sequence order. */
  listPending(nowMs: number, limit: number): OutboxRecord[];
  markDelivered(eventId: string): void;
  markFailed(
    eventId: string,
    code: string,
    nextAttemptAt: string | undefined,
    deadLetter: boolean,
  ): void;
  all(): OutboxRecord[];
  countPending(): number;
}

/** HTTP-ish delivery failure codes that are retryable. */
const RETRYABLE_CODES = new Set([
  "NETWORK",
  "RATE-LIMITED",
  "UNAVAILABLE",
  "429",
  "502",
  "503",
  "504",
  "TIMEOUT",
]);

export function isRetryableDelivery(result: DeliveryResult): boolean {
  if (result.permanent) {
    return false;
  }
  if (result.errorCode && RETRYABLE_CODES.has(result.errorCode.toUpperCase())) {
    return true;
  }
  // Default: unknown transient → retryable (bounded by maxAttempts).
  return !result.permanent;
}

// --- In-memory store ---

export function createInMemoryOutboxStore(): OutboxStore {
  const records = new Map<string, OutboxRecord>(); // insertion order = sequence order
  return {
    append(event) {
      if (records.has(event.eventId)) {
        return;
      } // dedup
      records.set(event.eventId, { event, status: "pending", attempts: 0 });
    },
    listPending(nowMs, limit) {
      const out: OutboxRecord[] = [];
      for (const r of records.values()) {
        if (r.status !== "pending") {
          continue;
        }
        if (r.nextAttemptAt && Date.parse(r.nextAttemptAt) > nowMs) {
          continue;
        }
        out.push(r);
        if (out.length >= limit) {
          break;
        }
      }
      return out.toSorted((a, b) => a.event.sequence - b.event.sequence);
    },
    markDelivered(eventId) {
      const r = records.get(eventId);
      if (r) {
        r.status = "delivered";
      }
    },
    markFailed(eventId, code, nextAttemptAt, deadLetter) {
      const r = records.get(eventId);
      if (!r) {
        return;
      }
      r.attempts += 1;
      r.lastErrorCode = code;
      if (deadLetter) {
        r.status = "dead-letter";
      } else if (nextAttemptAt !== undefined) {
        r.nextAttemptAt = nextAttemptAt;
      }
    },
    all: () => [...records.values()],
    countPending: () => [...records.values()].filter((r) => r.status === "pending").length,
  };
}

// --- SQLite store (durable, restart-recoverable) ---

export function createSqliteOutboxStore(dbPath: string): OutboxStore {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS outbox (
      event_id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error_code TEXT,
      enqueued_at INTEGER NOT NULL
    );
  `);
  const toRecord = (row: Record<string, unknown>): OutboxRecord => ({
    event: JSON.parse(row.event_json as string) as RuntimeEvent,
    status: row.status as OutboxRecord["status"],
    attempts: Number(row.attempts),
    ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at as string } : {}),
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code as string } : {}),
  });
  return {
    append(event) {
      db.prepare(
        `INSERT OR IGNORE INTO outbox (event_id, seq, event_json, status, attempts, enqueued_at)
         VALUES (?, ?, ?, 'pending', 0, ?)`,
      ).run(event.eventId, event.sequence, JSON.stringify(event), Date.now());
    },
    listPending(nowMs, limit) {
      const rows = db
        .prepare(
          `SELECT * FROM outbox WHERE status = 'pending'
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY seq ASC LIMIT ?`,
        )
        .all(new Date(nowMs).toISOString(), limit) as Record<string, unknown>[];
      return rows.map(toRecord);
    },
    markDelivered(eventId) {
      db.prepare(`UPDATE outbox SET status = 'delivered' WHERE event_id = ?`).run(eventId);
    },
    markFailed(eventId, code, nextAttemptAt, deadLetter) {
      db.prepare(
        `UPDATE outbox SET attempts = attempts + 1, last_error_code = ?,
           status = ?, next_attempt_at = ? WHERE event_id = ?`,
      ).run(code, deadLetter ? "dead-letter" : "pending", nextAttemptAt ?? null, eventId);
    },
    all() {
      const rows = db.prepare(`SELECT * FROM outbox ORDER BY seq ASC`).all() as Record<
        string,
        unknown
      >[];
      return rows.map(toRecord);
    },
    countPending() {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`).get() as {
        n: number;
      };
      return row.n;
    },
  };
}

// --- Delivery loop ---

export interface FlushOptions {
  store: OutboxStore;
  receiver: RuntimeEventReceiver;
  maxAttempts: number;
  now: () => number;
  rng?: () => number;
  backoffBaseMs?: number;
  limit?: number;
}

export interface FlushSummary {
  delivered: number;
  retried: number;
  deadLettered: number;
}

/** Attempt delivery of pending events. Bounded retry with backoff; permanent/maxed failures → dead-letter. */
export async function flushOutbox(options: FlushOptions): Promise<FlushSummary> {
  const rng = options.rng ?? Math.random;
  const base = options.backoffBaseMs ?? 250;
  const summary: FlushSummary = { delivered: 0, retried: 0, deadLettered: 0 };
  const pending = options.store.listPending(options.now(), options.limit ?? 100);

  for (const record of pending) {
    const result = await options.receiver.send(record.event);
    if (result.ok) {
      options.store.markDelivered(record.event.eventId);
      summary.delivered += 1;
      continue;
    }
    const attemptsAfter = record.attempts + 1;
    const retryable = isRetryableDelivery(result);
    if (!retryable || attemptsAfter >= options.maxAttempts) {
      options.store.markFailed(
        record.event.eventId,
        result.errorCode ?? "UNKNOWN",
        undefined,
        true,
      );
      summary.deadLettered += 1;
    } else {
      const delay = base * 2 ** record.attempts + Math.floor(rng() * base);
      const nextAttemptAt = new Date(options.now() + delay).toISOString();
      options.store.markFailed(
        record.event.eventId,
        result.errorCode ?? "UNKNOWN",
        nextAttemptAt,
        false,
      );
      summary.retried += 1;
    }
  }
  return summary;
}
