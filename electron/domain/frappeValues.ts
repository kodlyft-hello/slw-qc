/**
 * Ports of Frappe's `flt` and `cint`.
 *
 * The server re-derives size, rate and the summary on every push, so any place the
 * client rounds or coerces differently from Python is a place the operator watches a
 * number change after syncing. These two functions are the floor that the rest of the
 * domain layer stands on, so they copy Frappe's semantics rather than using the
 * nearest JavaScript equivalent.
 */

/** Frappe `flt`: anything unparseable is 0, never NaN. */
export function flt(value: unknown, precision?: number): number {
	let out: number;

	if (typeof value === "number") out = value;
	else if (typeof value === "string") {
		// Frappe strips commas before parsing, so "1,234.5" is 1234.5 and not NaN.
		const parsed = Number.parseFloat(value.replace(/,/g, "").trim());
		out = Number.isFinite(parsed) ? parsed : 0;
	} else if (typeof value === "boolean") out = value ? 1 : 0;
	else out = 0;

	if (!Number.isFinite(out)) out = 0;
	return precision === undefined ? out : round(out, precision);
}

/** Frappe `cint`: truncates toward zero, like Python's `int(float(x))`. */
export function cint(value: unknown): number {
	return Math.trunc(flt(value));
}

/**
 * Half-away-from-zero rounding, which is what Python's `flt` uses and what a QC
 * operator expects. JavaScript's `Math.round` breaks ties toward positive infinity, so
 * it disagrees on every negative half.
 */
export function round(value: number, precision = 0): number {
	const factor = 10 ** precision;
	const scaled = value * factor;
	// Nudge past the float representation error that makes 1.005 land just under the tie.
	const corrected = Number.parseFloat(scaled.toPrecision(15));
	const rounded = corrected < 0 ? -Math.round(-corrected) : Math.round(corrected);
	return rounded / factor;
}

/**
 * Python's `sorted()` on strings, which compares code points. The desk script sorts the
 * summary with `localeCompare`, so it and the server already disagree on any pair the
 * locale collates differently - "a" before "B" in a locale, "B" before "a" by code
 * point. The server's ordering is the one that persists, so it is the one copied here.
 */
export function pythonCompare(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}
