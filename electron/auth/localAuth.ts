/**
 * Operator sign-in.
 *
 * Two paths, and which one runs depends only on whether the server can be reached:
 *
 *   online  - the password is checked by Frappe, the station receives that user's own
 *             API key pair, and a bcrypt hash of the password is cached locally.
 *   offline - the password is checked against that cached hash, so a station keeps
 *             working through a network outage. Measuring hides does not need the
 *             server; only pushing does.
 *
 * The cached hash is never a substitute for server authorisation. It only unlocks a
 * station that this user has already signed in to at least once, and the API pair it
 * unlocks is still subject to the user's real permissions on every call.
 */
import bcrypt from "bcryptjs";

import { sql, type Db } from "../db/connection";

/** Mirrors QC_ROLES in slw/api/qc_desktop.py. */
export const QC_ROLES = ["System Manager", "Stock Manager", "Purchase Manager", "Administrator"];

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 5;
const BCRYPT_ROUNDS = 10;

export class AuthError extends Error {
	override readonly name = "AuthError";
}

export interface Session {
	user: string;
	fullName: string;
	roles: string[];
	offline: boolean;
}

interface OperatorRow {
	username: string;
	full_name: string | null;
	roles_json: string;
	password_hash: string | null;
	failed_attempts: number;
	locked_until: string | null;
	disabled: number;
}

function readOperator(db: Db, username: string): OperatorRow | undefined {
	return sql(db, "SELECT * FROM operators WHERE username = ?").get(username) as OperatorRow | undefined;
}

export function hasQcRole(roles: readonly string[]): boolean {
	return roles.some((role) => QC_ROLES.includes(role));
}

/** Record a successful server sign-in so the same operator can get in while offline. */
export async function rememberOperator(
	db: Db,
	username: string,
	password: string,
	fullName: string,
	roles: string[]
): Promise<void> {
	const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
	sql(db,
		`INSERT INTO operators (username, full_name, roles_json, password_hash, failed_attempts, locked_until, last_login_at, disabled)
		 VALUES (?, ?, ?, ?, 0, NULL, datetime('now'), 0)
		 ON CONFLICT(username) DO UPDATE SET
		   full_name = excluded.full_name,
		   roles_json = excluded.roles_json,
		   password_hash = excluded.password_hash,
		   failed_attempts = 0,
		   locked_until = NULL,
		   last_login_at = datetime('now'),
		   disabled = 0`
	).run(username, fullName, JSON.stringify(roles), hash);
}

/**
 * Offline sign-in against the cached hash.
 *
 * Lockout is deliberately per-username and local: a station left unattended on a
 * factory floor is physically accessible, and an unlimited offline guess rate against a
 * cached hash is the one place this design could be brute-forced.
 */
export async function loginOffline(db: Db, username: string, password: string): Promise<Session> {
	const operator = readOperator(db, username);

	if (!operator || operator.disabled) {
		throw new AuthError("Unknown operator, or this station has never signed them in.");
	}

	// SQLite writes "YYYY-MM-DD HH:MM:SS"; only the ISO "T" form parses reliably in JS,
	// and the value is UTC because datetime('now') is.
	if (operator.locked_until && new Date(operator.locked_until.replace(" ", "T") + "Z") > new Date()) {
		throw new AuthError(`Locked after too many attempts. Try again after ${operator.locked_until} UTC.`);
	}

	if (!operator.password_hash) {
		throw new AuthError("This operator must sign in online at least once on this station.");
	}

	if (!(await bcrypt.compare(password, operator.password_hash))) {
		const attempts = operator.failed_attempts + 1;
		sql(db,
			`UPDATE operators
			    SET failed_attempts = ?,
			        locked_until = CASE WHEN ? >= ? THEN datetime('now', '+' || ? || ' minutes') ELSE NULL END
			  WHERE username = ?`
		).run(attempts, attempts, MAX_ATTEMPTS, LOCK_MINUTES, username);
		// Deliberately the same message as an unknown user: revealing which half was
		// wrong tells an attacker which usernames are real.
		throw new AuthError("Unknown operator or wrong password.");
	}

	const roles = JSON.parse(operator.roles_json) as string[];
	if (!hasQcRole(roles)) {
		throw new AuthError(`${username} holds no role permitted to use QC Check List.`);
	}

	sql(db,
		"UPDATE operators SET failed_attempts = 0, locked_until = NULL, last_login_at = datetime('now') WHERE username = ?"
	).run(username);

	return { user: username, fullName: operator.full_name ?? username, roles, offline: true };
}

export function listKnownOperators(db: Db): { username: string; full_name: string | null }[] {
	return sql(db, "SELECT username, full_name FROM operators WHERE disabled = 0 ORDER BY username")
		.all() as { username: string; full_name: string | null }[];
}
