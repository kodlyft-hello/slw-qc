/**
 * One SQLite handle for the entire test run.
 *
 * better-sqlite3 is a native addon whose Database destructor calls
 * RemoveEnvironmentCleanupHook. If a *discarded* handle is finalised after the worker's
 * V8 environment has gone, the worker aborts outright:
 *
 *   RemoveEnvironmentCleanupHook: Assertion (env) != nullptr
 *
 * The crash is therefore a function of how many handles get thrown away, not of how the
 * tests are written - which is why it showed up intermittently and moved between files
 * as tests were added. Opening exactly one handle, keeping it referenced for the life of
 * the process and clearing the tables between tests removes the churn completely. It is
 * also considerably faster than recreating the schema for every test.
 *
 * The handle is deliberately never closed. The process is about to exit, SQLite has
 * nothing buffered that a close would flush that exit does not, and a live reference at
 * exit is precisely the case the addon handles cleanly.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase, sql, type Db } from "../../electron/db/connection";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA = fs.readFileSync(path.join(here, "../../electron/db/schema.sql"), "utf8");

let handle: Db | null = null;
let dir: string | null = null;

export function openTestDb(_label = "test"): Db {
	if (!handle) {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "slwqc-"));
		handle = openDatabase(path.join(dir, "qc.db"), SCHEMA);
		// Best-effort cleanup of the scratch directory; the handle itself stays open.
		process.on("exit", () => {
			if (dir) fs.rmSync(dir, { recursive: true, force: true });
		});
	}
	return handle;
}

/** No-op: the shared handle outlives every individual test file. */
export function closeTestDb(): void {}

/** Empty every table, leaving the schema in place. */
export function resetTestDb(db: Db): void {
	const tables = (
		sql(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
			name: string;
		}[]
	).map((row) => row.name);

	db.pragma("foreign_keys = OFF");
	db.transaction(() => {
		for (const table of tables) sql(db, `DELETE FROM ${table}`).run();
		// Restart AUTOINCREMENT so row ids are comparable across tests.
		sql(db, "DELETE FROM sqlite_sequence").run();
	})();
	db.pragma("foreign_keys = ON");
}
