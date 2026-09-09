/**
 * Local QC Check List drafts.
 *
 * A checklist is created by exploding a GRN into one row per physical hide, exactly as
 * the desk form's `inward_no` handler does. The operator then measures each hide. Rows
 * are written back in bulk inside one transaction, because the grid autosaves while
 * they type and a per-row round trip to disk would reintroduce the stutter this
 * application exists to remove.
 */
import { randomUUID } from "node:crypto";

import { sql, type Db } from "../connection";
import { flt } from "../../domain/frappeValues";
import { grandTotal } from "../../domain/summary";
import { matchRate, type RateIndex } from "../../domain/rates";
import { matchSize, type SizeIndex } from "../../domain/sizing";
import { enqueue } from "./outbox";
import { validateForConfirm, type RowProblem } from "../../domain/validation";

export type ChecklistState = "draft" | "queued" | "sent" | "confirmed" | "failed";

export interface DetailRow {
	id: number;
	idx: number;
	item_code: string | null;
	item_name: string | null;
	skin_type: string | null;
	grade: string | null;
	size: string | null;
	status: "Accepted" | "Rejected" | null;
	feetage: number;
	no_pieces: number;
	rate: number;
	net_amount: number;
}

export interface Checklist {
	local_name: string;
	offline_uuid: string;
	inward_no: string | null;
	vendor: string | null;
	vendor_name: string | null;
	date: string | null;
	inward_date: string | null;
	addless: number;
	return_pieces: number;
	grand_total: number;
	state: ChecklistState;
	erp_name: string | null;
	created_by: string;
	rows: DetailRow[];
	selectors: string[];
	measurers: string[];
}

/** Local series, distinct from the server's QCCL- so the two are never confused. */
function nextLocalName(db: Db): string {
	const row = sql(db, "SELECT value FROM meta WHERE key = 'local_series'").get() as
		| { value: string }
		| undefined;
	const next = Number.parseInt(row?.value ?? "0", 10) + 1;
	sql(db,
		"INSERT INTO meta (key, value) VALUES ('local_series', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
	).run(String(next));
	return `QCL-${String(next).padStart(6, "0")}`;
}

/**
 * Explode a GRN into one draft row per hide.
 *
 * The desk form does the same thing and deliberately does NOT carry the grade across
 * from the inward row, even though Inward Raw Hide Detail requires one: the grade on
 * the GRN is the supplier's claim, and QC's job is to judge each hide for itself.
 */
export function createFromInward(db: Db, inwardNo: string, createdBy: string): Checklist {
	const inward = sql(db, "SELECT * FROM inward_raw_hides WHERE name = ?").get(inwardNo) as
		| { name: string; vendor: string; vendor_name: string; date: string }
		| undefined;
	if (!inward) throw new Error(`Inward Raw Hide ${inwardNo} is not in the local mirror. Pull first.`);

	const details = sql(db, "SELECT * FROM inward_raw_hide_details WHERE parent = ? ORDER BY idx")
		.all(inwardNo) as { item_code: string; item_name: string; skin_type: string; no_pieces: number }[];

	return db.transaction(() => {
		const localName = nextLocalName(db);
		const offlineUuid = randomUUID();

		sql(db,
			`INSERT INTO qc_check_lists
			   (local_name, offline_uuid, inward_no, vendor, vendor_name, date, inward_date, state, created_by)
			 VALUES (?, ?, ?, ?, ?, date('now'), ?, 'draft', ?)`
		).run(localName, offlineUuid, inwardNo, inward.vendor, inward.vendor_name, inward.date, createdBy);

		const insertRow = sql(db,
			`INSERT INTO qc_check_list_details (parent, idx, item_code, item_name, skin_type, no_pieces)
			 VALUES (?, ?, ?, ?, ?, 1)`
		);

		let idx = 0;
		for (const detail of details) {
			for (let piece = 0; piece < Math.trunc(detail.no_pieces ?? 0); piece++) {
				idx += 1;
				insertRow.run(localName, idx, detail.item_code, detail.item_name, detail.skin_type);
			}
		}

		return loadChecklist(db, localName)!;
	})();
}

export function loadChecklist(db: Db, localName: string): Checklist | null {
	const header = sql(db, "SELECT * FROM qc_check_lists WHERE local_name = ?").get(localName) as
		| Omit<Checklist, "rows" | "selectors" | "measurers">
		| undefined;
	if (!header) return null;

	const rows = sql(db, "SELECT * FROM qc_check_list_details WHERE parent = ? ORDER BY idx")
		.all(localName) as DetailRow[];

	const people = sql(db, "SELECT kind, employee FROM qc_check_list_persons WHERE parent = ? ORDER BY kind, idx")
		.all(localName) as { kind: "selector" | "measurer"; employee: string }[];

	return {
		...header,
		rows,
		selectors: people.filter((p) => p.kind === "selector").map((p) => p.employee),
		measurers: people.filter((p) => p.kind === "measurer").map((p) => p.employee),
	};
}

export function listChecklists(db: Db, state?: ChecklistState) {
	const text = state
		? "SELECT * FROM qc_check_lists WHERE state = ? ORDER BY created_at DESC"
		: "SELECT * FROM qc_check_lists ORDER BY created_at DESC";
	return (state ? sql(db, text).all(state) : sql(db, text).all()) as Omit<
		Checklist,
		"rows" | "selectors" | "measurers"
	>[];
}

export interface RowPatch {
	id: number;
	grade?: string | null;
	feetage?: number;
	item_code?: string | null;
	item_name?: string | null;
	skin_type?: string | null;
	size?: string | null;
	status?: "Accepted" | "Rejected" | null;
	no_pieces?: number;
}

/**
 * Persist edited rows, re-resolving size and rate from the in-memory indexes.
 *
 * Everything happens in one transaction, so the autosave that fires while the operator
 * is still typing either lands whole or not at all. Size and rate are recomputed here
 * rather than trusted from the caller, so the screen and the database cannot disagree
 * about what a feetage implies.
 */
export function saveRows(
	db: Db,
	localName: string,
	patches: readonly RowPatch[],
	indexes: { sizeIndex: SizeIndex; rateIndex: RateIndex }
): { updated: number; grand_total: number } {
	if (!patches.length) return { updated: 0, grand_total: readGrandTotal(db, localName) };

	assertEditable(db, localName);

	return db.transaction(() => {
		const select = sql(db, "SELECT * FROM qc_check_list_details WHERE id = ? AND parent = ?");
		const update = sql(db,
			`UPDATE qc_check_list_details
			    SET item_code = ?, item_name = ?, skin_type = ?, grade = ?, size = ?, status = ?,
			        feetage = ?, no_pieces = ?, rate = ?, net_amount = ?
			  WHERE id = ?`
		);

		let updated = 0;
		for (const patch of patches) {
			const current = select.get(patch.id, localName) as DetailRow | undefined;
			if (!current) continue;

			const merged = { ...current, ...patch };
			const feetage = flt(merged.feetage);
			// An explicit size on the patch is an operator override and wins; otherwise the
			// band is re-derived, so correcting a feetage cannot leave a stale size behind.
			const size =
				patch.size !== undefined
					? patch.size
					: matchSize(indexes.sizeIndex, merged.skin_type, feetage) || null;
			const rate = matchRate(indexes.rateIndex, merged.skin_type, merged.grade, size);

			update.run(
				merged.item_code ?? null,
				merged.item_name ?? null,
				merged.skin_type ?? null,
				merged.grade ?? null,
				size,
				merged.status ?? null,
				feetage,
				Math.trunc(flt(merged.no_pieces)) || 1,
				rate,
				feetage * rate,
				patch.id
			);
			updated += 1;
		}

		const total = recalculateTotal(db, localName);
		return { updated, grand_total: total };
	})();
}

function readGrandTotal(db: Db, localName: string): number {
	const row = sql(db, "SELECT grand_total FROM qc_check_lists WHERE local_name = ?").get(localName) as
		| { grand_total: number }
		| undefined;
	return row?.grand_total ?? 0;
}

function recalculateTotal(db: Db, localName: string): number {
	const rows = sql(db, "SELECT feetage, rate FROM qc_check_list_details WHERE parent = ?")
		.all(localName) as { feetage: number; rate: number }[];
	const total = grandTotal(rows);
	sql(db, "UPDATE qc_check_lists SET grand_total = ?, updated_at = datetime('now') WHERE local_name = ?").run(
		total,
		localName
	);
	return total;
}

/** A checklist that has reached the outbox is the server's business, not the operator's. */
function assertEditable(db: Db, localName: string): void {
	const row = sql(db, "SELECT state FROM qc_check_lists WHERE local_name = ?").get(localName) as
		| { state: ChecklistState }
		| undefined;
	if (!row) throw new Error(`Checklist ${localName} not found.`);
	if (row.state !== "draft" && row.state !== "failed") {
		throw new Error(`Checklist ${localName} is ${row.state} and can no longer be edited.`);
	}
}

export function updateHeader(
	db: Db,
	localName: string,
	patch: { date?: string; addless?: number; selectors?: string[]; measurers?: string[] }
): void {
	assertEditable(db, localName);

	db.transaction(() => {
		if (patch.date !== undefined || patch.addless !== undefined) {
			sql(db,
				`UPDATE qc_check_lists
				    SET date = COALESCE(?, date), addless = COALESCE(?, addless), updated_at = datetime('now')
				  WHERE local_name = ?`
			).run(patch.date ?? null, patch.addless ?? null, localName);
		}

		for (const [kind, people] of [
			["selector", patch.selectors],
			["measurer", patch.measurers],
		] as const) {
			if (!people) continue;
			sql(db, "DELETE FROM qc_check_list_persons WHERE parent = ? AND kind = ?").run(localName, kind);
			const insert = sql(db,
				"INSERT INTO qc_check_list_persons (parent, kind, employee, idx) VALUES (?, ?, ?, ?)"
			);
			people.forEach((employee, position) => insert.run(localName, kind, employee, position + 1));
		}
	})();
}

/**
 * Trim the last N rows, mirroring Return Pieces.
 *
 * The desk form does this once and then permanently locks the field, so a mistyped
 * count is unrecoverable without starting the checklist again. Here it is just an edit
 * to a draft and can be redone by re-exploding the GRN, so the count is free to change
 * until the checklist is confirmed.
 */
export function setReturnPieces(db: Db, localName: string, count: number): number {
	assertEditable(db, localName);

	return db.transaction(() => {
		const rows = sql(db, "SELECT id FROM qc_check_list_details WHERE parent = ? ORDER BY idx DESC")
			.all(localName) as { id: number }[];

		const wanted = Math.max(0, Math.trunc(count));
		if (wanted > rows.length) {
			throw new Error(`Return Pieces cannot be greater than available rows (${rows.length}).`);
		}

		const doomed = rows.slice(0, wanted).map((row) => row.id);
		if (doomed.length) {
			sql(db,
				`DELETE FROM qc_check_list_details WHERE id IN (${doomed.map(() => "?").join(", ")})`
			).run(doomed);
		}

		// Renumber so idx stays 1..n and the grid's row numbers match the document's.
		const remaining = sql(db, "SELECT id FROM qc_check_list_details WHERE parent = ? ORDER BY idx")
			.all(localName) as { id: number }[];
		const renumber = sql(db, "UPDATE qc_check_list_details SET idx = ? WHERE id = ?");
		remaining.forEach((row, position) => renumber.run(position + 1, row.id));

		sql(db,
			"UPDATE qc_check_lists SET return_pieces = ?, updated_at = datetime('now') WHERE local_name = ?"
		).run(wanted, localName);

		recalculateTotal(db, localName);
		return remaining.length;
	})();
}

export interface ConfirmResult {
	ok: boolean;
	problems: RowProblem[];
}

/**
 * Confirm a draft: validate it, then write the document state and its outbox row in one
 * transaction.
 *
 * Atomicity is the point. A checklist can never be marked queued without something
 * queued to send it, and never sit in the outbox while the operator believes it is
 * still an editable draft.
 */
export function confirm(db: Db, localName: string): ConfirmResult {
	assertEditable(db, localName);

	const checklist = loadChecklist(db, localName);
	if (!checklist) throw new Error(`Checklist ${localName} not found.`);

	const problems = validateForConfirm(checklist.rows);
	if (problems.length) return { ok: false, problems };

	db.transaction(() => {
		// Deliberately thin: size, rate, net_amount, grand_total and the summary are all
		// recomputed by QCCheckList.validate on the server, so sending this app's copies
		// would only create a way for the two to disagree.
		const payload = {
			offline_uuid: checklist.offline_uuid,
			inward_no: checklist.inward_no,
			date: checklist.date,
			addless: checklist.addless,
			return_pieces: checklist.return_pieces,
			qc_person_details: checklist.selectors,
			qc_measurer_details: checklist.measurers,
			qc_checklist_details: checklist.rows.map((row) => ({
				item_code: row.item_code,
				skin_type: row.skin_type,
				grade: row.grade,
				feetage: row.feetage,
				no_pieces: row.no_pieces,
				status: row.status,
			})),
		};

		enqueue(db, {
			offlineUuid: checklist.offline_uuid,
			localName,
			payload,
			createdBy: checklist.created_by,
		});

		sql(db,
			"UPDATE qc_check_lists SET state = 'queued', updated_at = datetime('now') WHERE local_name = ?"
		).run(localName);
	})();

	return { ok: true, problems: [] };
}

/**
 * Reflect a server confirmation locally.
 *
 * Flipping the mirrored GRN to Complete matters: `QCCheckList.on_submit` does it server
 * side, and without mirroring it the GRN keeps appearing in the picker and the operator
 * can start a second checklist for work that is already done.
 */
export function applyServerConfirmation(
	db: Db,
	offlineUuid: string,
	erpName: string,
	inwardNo: string | null,
	inwardStatus: string | null
): void {
	db.transaction(() => {
		sql(db,
			"UPDATE qc_check_lists SET state = 'confirmed', erp_name = ?, updated_at = datetime('now') WHERE offline_uuid = ?"
		).run(erpName, offlineUuid);

		if (inwardNo && inwardStatus) {
			sql(db, "UPDATE inward_raw_hides SET status = ? WHERE name = ?").run(inwardStatus, inwardNo);
		}
	})();
}
