/**
 * End-to-end against a real Frappe server.
 *
 * Everything below the Electron window runs for real here: a password sign-in that
 * returns an API key pair, a live master pull into SQLite, a checklist measured through
 * the same repository calls the grid uses, and a push that leaves a submitted QC Check
 * List in ERPNext. The unit suites prove the parts agree with the Python; this proves
 * the whole path works against the actual site.
 *
 * Skipped automatically unless a bench is reachable, so the normal suite stays offline:
 *   SLWQC_E2E=1 npx vitest run tests/e2e
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, openDatabase, setDb, sql, type Db } from "../../electron/db/connection";
import { SCHEMA } from "../helpers/testDb";
import { applyPullResult, listOpenInwards, loadMasterIndexes, readCursors } from "../../electron/db/repositories/masters";
import { confirm, createFromInward, loadChecklist, saveRows } from "../../electron/db/repositories/checklists";
import { listQueue } from "../../electron/db/repositories/outbox";
import { SyncEngine } from "../../electron/sync/engine";
import { ErpnextClient, loginForKeys } from "../../electron/sync/erpnext";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const USER = process.env.SLWQC_E2E_USER ?? "qcop@slw.test";
const PASSWORD = process.env.SLWQC_E2E_PASSWORD ?? "QcStation!2026";

// A bench pinned to one site, so the Host header plays no part:
//   cd sites && ../env/bin/python -m frappe.utils.bench_helper frappe --site slw.com serve --port 8901
// A shared `frappe serve` that hosts several sites resolves by Host header and, with
// serve_default_site set, can answer for the wrong site entirely.
const BASE_URL = process.env.SLWQC_E2E_URL ?? "http://127.0.0.1:8901";

const enabled = process.env.SLWQC_E2E === "1";
const suite = enabled ? describe : describe.skip;

let db: Db;
let dir: string;
let client: ErpnextClient;

suite("live sync against a real bench", () => {
	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "slwqc-e2e-"));
		db = openDatabase(path.join(dir, "qc.db"), SCHEMA);
	}, 60_000);

	afterAll(() => {
		closeDatabase();
		setDb(null);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("signs in with a password and receives an API key pair", async () => {
		const bootstrap = await loginForKeys(BASE_URL, USER, PASSWORD);

		expect(bootstrap.user).toBe(USER);
		expect(bootstrap.api_key).toBeTruthy();
		expect(bootstrap.api_secret).toBeTruthy();
		expect(bootstrap.roles).toContain("Stock Manager");

		client = new ErpnextClient({
			baseUrl: BASE_URL,
			apiKey: bootstrap.api_key,
			apiSecret: bootstrap.api_secret,
		});

		// From here on the password is irrelevant; the key pair carries the session.
		expect((await client.ping()).user).toBe(USER);
	}, 60_000);

	it("pulls the masters into the local mirror", async () => {
		await new SyncEngine({ db, client }).pullOnce();

		expect(readCursors(db)["Skin Type Range"]).toBeTruthy();

		const indexes = loadMasterIndexes(db);
		expect(indexes.grades.length).toBeGreaterThan(0);
		// Stock Manager now holds permlevel-1 read on Tounch Rate, so QC sees pricing.
		expect(indexes.ratesVisible).toBe(true);

		const rangeCount = (sql(db, "SELECT COUNT(*) AS n FROM skin_type_ranges").get() as { n: number }).n;
		expect(rangeCount).toBeGreaterThan(0);
	}, 120_000);

	it("offers the open GRN and explodes it into one row per hide", () => {
		const inwards = listOpenInwards(db);
		expect(inwards.length).toBeGreaterThan(0);

		const grn = inwards[0]!;
		const list = createFromInward(db, grn.name, USER);

		expect(list.rows).toHaveLength(grn.total_qty);
		expect(list.vendor_name).toBeTruthy();
		// The supplier's grade is deliberately not carried over; QC judges each hide.
		expect(list.rows.every((row) => row.grade === null)).toBe(true);
	}, 30_000);

	it("resolves sizes locally, with no network call per keystroke", () => {
		const list = latestChecklist();
		const indexes = loadMasterIndexes(db);

		// What the grid does on each commit, for every row at once.
		saveRows(
			db,
			list.local_name,
			list.rows.map((row, index) => ({ id: row.id, feetage: index % 2 === 0 ? 8 : 45, grade: "A" })),
			indexes
		);

		const measured = loadChecklist(db, list.local_name)!;
		expect(measured.rows.every((row) => row.size)).toBe(true);

		// Rates come from the mirrored rate card, with no call per keystroke. Only skin
		// types that actually have a Tounch Rate get one: the seed prices Cow and not Goat,
		// so an unpriced row is correct here and must not be mistaken for a broken lookup.
		const priced = measured.rows.filter((row) => row.skin_type === "Cow");
		const unpriced = measured.rows.filter((row) => row.skin_type !== "Cow");
		expect(priced.length).toBeGreaterThan(0);
		expect(priced.every((row) => row.rate > 0)).toBe(true);
		expect(priced.every((row) => row.net_amount > 0)).toBe(true);
		expect(unpriced.every((row) => row.rate === 0)).toBe(true);
	}, 30_000);

	it("pushes a confirmed checklist and gets a submitted document back", async () => {
		const list = latestChecklist();

		expect(confirm(db, list.local_name).ok).toBe(true);
		await new SyncEngine({ db, client }).pushOnce();

		const pushed = loadChecklist(db, list.local_name)!;
		expect(pushed.state).toBe("confirmed");
		expect(pushed.erp_name).toMatch(/^QCCL-/);

		const [queued] = listQueue(db);
		expect(queued!.state).toBe("confirmed");

		// on_submit closes the GRN, and the mirror must reflect it or the operator is
		// offered work that is already done.
		const grn = sql(db, "SELECT status FROM inward_raw_hides WHERE name = ?").get(pushed.inward_no) as {
			status: string;
		};
		expect(grn.status).toBe("Complete");
		expect(listOpenInwards(db).map((row) => row.name)).not.toContain(pushed.inward_no);
	}, 180_000);

	it("is idempotent: pushing the same checklist again resolves to the same document", async () => {
		const list = latestChecklist(["confirmed"]);
		const uuid = list.offline_uuid;
		const erpName = list.erp_name;

		// Force a second push of a document the server already has.
		sql(db, "UPDATE outbox SET state = 'queued', next_attempt_at = datetime('now') WHERE offline_uuid = ?").run(uuid);
		await new SyncEngine({ db, client }).pushOnce();

		expect(loadChecklist(db, list.local_name)!.erp_name).toBe(erpName);
	}, 180_000);
});

/** The most recent local checklist in any of the given states. */
function latestChecklist(states: string[] = ["draft", "queued", "failed", "confirmed"]) {
	const holes = states.map(() => "?").join(", ");
	const row = sql(
		db,
		`SELECT local_name FROM qc_check_lists WHERE state IN (${holes}) ORDER BY created_at DESC, local_name DESC LIMIT 1`
	).get(states) as { local_name: string } | undefined;

	if (!row) throw new Error(`No local checklist in state(s): ${states.join(", ")}`);

	const checklist = loadChecklist(db, row.local_name);
	if (!checklist) throw new Error(`Checklist ${row.local_name} disappeared.`);
	return checklist;
}
