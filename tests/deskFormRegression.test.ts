/**
 * A regression guard for the desk form bug this application was built in response to.
 *
 * `slw/slw/doctype/qc_check_list/qc_check_list.js` used to reset a feetage cell to 0 and
 * throw a modal whenever a committed value fell below 5. Measuring at speed, the change
 * event fires on whatever is in the box when focus leaves, so the "1" on the way to "12"
 * committed on its own and the operator watched their measurement vanish. The modal's
 * focus handler then fired on a 300ms timer and moved the caret, sending the next digits
 * to a different cell.
 *
 * The desktop station fixes this for its own grid, but plenty of people still use the
 * browser form, so the fix was made there too. This drives the real file with stubbed
 * Frappe globals to prove the behaviour, because the two clients must not drift back
 * apart.
 *
 * Skipped when the `slw` app is not checked out alongside, so this suite stays
 * self-contained on a machine that only has the desktop client.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const DESK_JS = path.resolve(here, "../../slw/slw/slw/doctype/qc_check_list/qc_check_list.js");

const available = fs.existsSync(DESK_JS);
const suite = available ? describe : describe.skip;

interface Handlers {
	feetage: (frm: unknown, cdt: string, cdn: string) => void;
}

interface Harness {
	detail: Handlers;
	parent: { validate: (frm: unknown) => void };
	alerts: { indicator?: string }[];
	setValueCalls: { field: string; value: unknown }[];
	timers: unknown[];
	frm: {
		doc: { qc_checklist_details: Record<string, unknown>[]; docstatus: number };
		fields_dict: Record<string, unknown>;
		dirty: () => void;
		refresh_field: () => void;
		clear_table: () => void;
		add_child: () => void;
	};
	locals: Record<string, Record<string, Record<string, unknown>>>;
}

/** Load the desk script into a sandbox with just enough Frappe to run the handlers. */
function loadDeskForm(): Harness {
	const handlers: Record<string, Handlers> = {};
	const alerts: { indicator?: string }[] = [];
	const setValueCalls: { field: string; value: unknown }[] = [];
	const timers: unknown[] = [];

	const frappe = {
		ui: {
			form: {
				on: (doctype: string, h: Handlers) => {
					handlers[doctype] = h;
				},
			},
			Dialog: class {},
		},
		model: {
			set_value: (_dt: string, _dn: string, field: string, value: unknown) => {
				setValueCalls.push({ field, value });
			},
			clear_doc: () => {},
		},
		show_alert: (a: { indicator?: string }) => alerts.push(a),
		msgprint: () => {},
		throw: (e: string | { message: string }) => {
			const error = new Error(typeof e === "string" ? e : e.message) as Error & { frappeThrow?: boolean };
			error.frappeThrow = true;
			throw error;
		},
		confirm: () => {},
		call: () => {},
		xcall: () => Promise.resolve({ rates: {}, visible: true }),
		db: { get_list: () => Promise.resolve([]), get_doc: () => Promise.resolve({}) },
		utils: { debounce: (fn: unknown) => fn, scroll_to: () => {}, get_form_link: (_d: string, n: string) => n },
		new_doc: () => {},
	};

	const sandbox: Record<string, unknown> = {
		frappe,
		locals: {},
		flt: (v: unknown) => {
			const n = Number.parseFloat(String(v));
			return Number.isFinite(n) ? n : 0;
		},
		cint: (v: unknown) => Math.trunc(Number.parseFloat(String(v)) || 0),
		__: (text: string, args?: unknown[]) =>
			(args ?? []).reduce<string>((s, a, i) => s.replace(`{${i}}`, String(a)), text),
		$: () => ({ toggleClass: () => {} }),
		document: {
			getElementById: () => null,
			createElement: () => ({ style: {}, set textContent(_v: string) {} }),
			head: { appendChild: () => {} },
		},
		// Recorded, never run: a deferred focus is the second half of the original bug.
		setTimeout: (fn: unknown, ms: unknown) => timers.push({ fn, ms }),
		console,
	};
	sandbox.window = sandbox;

	vm.createContext(sandbox);
	vm.runInContext(fs.readFileSync(DESK_JS, "utf8"), sandbox, { filename: DESK_JS });

	const frm = {
		doc: { qc_checklist_details: [] as Record<string, unknown>[], docstatus: 0 },
		fields_dict: { qc_checklist_details: { grid: { grid_rows_by_docname: {} } } },
		dirty: () => {},
		refresh_field: () => {},
		clear_table: () => {},
		add_child: () => {},
	};

	return {
		detail: handlers["QC Check List Detail"]!,
		parent: handlers["QC Check List"] as unknown as { validate: (frm: unknown) => void },
		alerts,
		setValueCalls,
		timers,
		frm,
		locals: sandbox.locals as Harness["locals"],
	};
}

function withRow(harness: Harness, feetage: number) {
	const row = { doctype: "QC Check List Detail", name: "row1", idx: 1, feetage, skin_type: "Cow" };
	harness.locals["QC Check List Detail"] = { row1: row };
	harness.frm.doc.qc_checklist_details = [row as unknown as Record<string, unknown>];
	return row;
}

function typeFeetage(harness: Harness, feetage: number) {
	const row = withRow(harness, feetage);
	let threw = false;
	try {
		harness.detail.feetage(harness.frm, row.doctype, row.name);
	} catch {
		threw = true;
	}
	return { row, threw };
}

suite("desk form no longer eats measurements", () => {
	it("keeps an intermediate value instead of zeroing the cell", () => {
		const harness = loadDeskForm();
		const { row, threw } = typeFeetage(harness, 1);

		// The whole complaint: "1" on the way to "12" must survive its own commit.
		expect(threw).toBe(false);
		expect(row.feetage).toBe(1);
		// The decisive assertion. On the original code this recorded a write of 0.
		expect(harness.setValueCalls.filter((call) => call.field === "feetage")).toEqual([]);
	});

	it("warns rather than interrupting", () => {
		const harness = loadDeskForm();
		typeFeetage(harness, 1);
		expect(harness.alerts[0]?.indicator).toBe("orange");
	});

	it("keeps an over-range value too", () => {
		const harness = loadDeskForm();
		const { row, threw } = typeFeetage(harness, 500);
		expect(threw).toBe(false);
		expect(row.feetage).toBe(500);
	});

	it("says nothing at all about a valid measurement", () => {
		const harness = loadDeskForm();
		const { row, threw } = typeFeetage(harness, 12);
		expect(threw).toBe(false);
		expect(row.feetage).toBe(12);
		expect(harness.alerts).toEqual([]);
	});

	it("schedules no deferred focus, so the caret cannot be moved out from under the operator", () => {
		const harness = loadDeskForm();
		typeFeetage(harness, 1);
		typeFeetage(harness, 12);
		expect(harness.timers).toEqual([]);
	});

	it("still refuses to save a document with an out-of-range feetage", () => {
		// Marking instead of blocking must not mean invalid data reaches the server.
		const harness = loadDeskForm();
		withRow(harness, 1);
		expect(() => harness.parent.validate(harness.frm)).toThrow(/must be between 5 and 100/);
	});

	it("saves a valid document without complaint", () => {
		const harness = loadDeskForm();
		withRow(harness, 12);
		expect(() => harness.parent.validate(harness.frm)).not.toThrow();
	});
});
