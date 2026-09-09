/**
 * The outbox: the queue of confirmed checklists waiting for ERPNext.
 *
 * States are draft, queued, sent, confirmed, failed, and `qc_check_lists.state` mirrors
 * whichever state the outbox row holds so list screens can filter without a join. The
 * two are only ever written together, inside a transaction.
 *
 * The distinction that matters most here is between a transport failure and a rejection.
 * A timeout means the server may or may not have committed, so it must not consume an
 * attempt or trip the backoff - the tick simply aborts and retries. A validation error
 * is a real answer and does count.
 */
import { sql, type Db } from "../connection";

export type OutboxState = "draft" | "queued" | "sent" | "confirmed" | "failed";

export interface OutboxRow {
	id: number;
	offline_uuid: string;
	local_name: string;
	payload_json: string;
	state: OutboxState;
	attempts: number;
	next_attempt_at: string | null;
	last_error: string | null;
	erp_name: string | null;
	created_by: string;
	created_at: string;
	updated_at: string;
}

/**
 * Exponential backoff: 1s, 2s, 4s ... doubling per attempt.
 *
 * Faithful to the POS client's `LEAST(POW(2, LEAST(attempts, 8)), 900)`. Note that
 * capping the *exponent* at 8 means the real ceiling is 2^8 = 256 seconds and the 900
 * second cap never binds. Kept as-is so both clients back off identically; the outer
 * cap stays only as the guard it was written to be.
 */
export const MAX_BACKOFF_SECONDS = 900;
const MAX_BACKOFF_EXPONENT = 8;

export function backoffSeconds(attempts: number): number {
	return Math.min(2 ** Math.min(attempts, MAX_BACKOFF_EXPONENT), MAX_BACKOFF_SECONDS);
}

export function enqueue(
	db: Db,
	entry: { offlineUuid: string; localName: string; payload: unknown; createdBy: string }
): void {
	sql(db,
		`INSERT INTO outbox (offline_uuid, local_name, payload_json, state, next_attempt_at, created_by)
		 VALUES (?, ?, ?, 'queued', datetime('now'), ?)
		 ON CONFLICT(offline_uuid) DO UPDATE SET
		   payload_json = excluded.payload_json,
		   state = 'queued',
		   next_attempt_at = datetime('now'),
		   last_error = NULL,
		   updated_at = datetime('now')`
	).run(entry.offlineUuid, entry.localName, JSON.stringify(entry.payload), entry.createdBy);
}

/** Rows due for a push attempt now, oldest first. */
export function dueForPush(db: Db, limit = 20): OutboxRow[] {
	return sql(db,
			`SELECT * FROM outbox
			  WHERE state IN ('queued', 'failed', 'sent')
			    AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
			  ORDER BY id ASC
			  LIMIT ?`
		)
		.all(limit) as OutboxRow[];
}

/**
 * Mark rows as in flight before the request goes out.
 *
 * If the process dies mid-request these stay 'sent' and are retried on the next tick.
 * That is safe precisely because push is idempotent on offline_uuid: a retry of a
 * request the server already committed resolves to the existing document rather than
 * inserting a second one.
 */
export function markSent(db: Db, offlineUuids: string[]): void {
	if (!offlineUuids.length) return;
	const statement = sql(db,
		"UPDATE outbox SET state = 'sent', updated_at = datetime('now') WHERE offline_uuid = ?"
	);
	db.transaction(() => {
		for (const uuid of offlineUuids) statement.run(uuid);
	})();
}

export function markConfirmed(db: Db, offlineUuid: string, erpName: string): void {
	db.transaction(() => {
		sql(db,
			`UPDATE outbox SET state = 'confirmed', erp_name = ?, last_error = NULL,
			        next_attempt_at = NULL, updated_at = datetime('now')
			  WHERE offline_uuid = ?`
		).run(erpName, offlineUuid);

		sql(db,
			`UPDATE qc_check_lists SET state = 'confirmed', erp_name = ?, updated_at = datetime('now')
			  WHERE offline_uuid = ?`
		).run(erpName, offlineUuid);
	})();
}

export function markFailed(db: Db, offlineUuid: string, error: string): void {
	db.transaction(() => {
		// The delay is computed here rather than in SQL: SQLite only exposes POWER() when
		// it was compiled with the math extension, so doing this in the statement would
		// work on one build and silently produce NULL - meaning "retry immediately,
		// forever" - on another.
		const current = sql(db, "SELECT attempts FROM outbox WHERE offline_uuid = ?").get(offlineUuid) as
			| { attempts: number }
			| undefined;
		const delay = backoffSeconds(current?.attempts ?? 0);

		sql(db,
			`UPDATE outbox
			    SET state = 'failed',
			        attempts = attempts + 1,
			        last_error = ?,
			        next_attempt_at = datetime('now', '+' || ? || ' seconds'),
			        updated_at = datetime('now')
			  WHERE offline_uuid = ?`
		).run(error, delay, offlineUuid);

		sql(db,
			"UPDATE qc_check_lists SET state = 'failed', updated_at = datetime('now') WHERE offline_uuid = ?"
		).run(offlineUuid);
	})();
}

/**
 * Return in-flight rows to the queue without consuming an attempt.
 *
 * Used when the request never got an answer - the station is offline, or the request
 * timed out. Counting that as a failure would push a station that is merely
 * disconnected into a 15-minute backoff for no reason.
 */
export function releaseInFlight(db: Db, offlineUuids: string[]): void {
	if (!offlineUuids.length) return;
	const statement = sql(db,
		`UPDATE outbox SET state = 'queued', next_attempt_at = datetime('now'), updated_at = datetime('now')
		  WHERE offline_uuid = ? AND state = 'sent'`
	);
	db.transaction(() => {
		for (const uuid of offlineUuids) statement.run(uuid);
	})();
}

/** Operator-driven retry: clears the backoff so the next tick picks the row up. */
export function retryNow(db: Db, offlineUuid: string): void {
	sql(db,
		`UPDATE outbox SET state = 'queued', next_attempt_at = datetime('now'), last_error = NULL,
		        updated_at = datetime('now')
		  WHERE offline_uuid = ? AND state != 'confirmed'`
	).run(offlineUuid);
}

export function listQueue(db: Db, state?: OutboxState): OutboxRow[] {
	if (state) {
		return sql(db, "SELECT * FROM outbox WHERE state = ? ORDER BY id DESC").all(state) as OutboxRow[];
	}
	return sql(db, "SELECT * FROM outbox ORDER BY id DESC").all() as OutboxRow[];
}

export function queueCounts(db: Db): Record<OutboxState, number> {
	const counts = { draft: 0, queued: 0, sent: 0, confirmed: 0, failed: 0 } as Record<OutboxState, number>;
	for (const row of sql(db, "SELECT state, COUNT(*) AS n FROM outbox GROUP BY state").all() as {
		state: OutboxState;
		n: number;
	}[]) {
		counts[row.state] = row.n;
	}
	return counts;
}
