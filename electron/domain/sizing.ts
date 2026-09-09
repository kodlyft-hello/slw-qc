/**
 * Size band resolution: the client-side port of `_size_ranges` / `_match_size` in
 * `slw/slw/doctype/qc_check_list/qc_check_list.py`.
 *
 * On the desk form this costs a debounced round trip per feetage entry, and a second
 * one for the rate. Resolving it from an in-memory index instead is the single change
 * that lets an operator type as fast as they can measure.
 */
import { flt } from "./frappeValues";

export interface SkinTypeRange {
	range_name: string;
	skin_type: string;
	min_range: number;
	max_range: number;
	status?: string;
}

export type SizeIndex = Map<string, SkinTypeRange[]>;

function key(skinType: string | null | undefined): string {
	return (skinType ?? "").trim();
}

/**
 * Group active ranges by skin type, ascending by lower bound.
 *
 * The server iterates whatever order `frappe.get_all` happened to return, so with
 * overlapping bands its answer is not defined. Sorting here at least makes the client
 * deterministic; `findOverlaps` is what actually surfaces the underlying data problem.
 */
export function buildSizeIndex(ranges: readonly SkinTypeRange[]): SizeIndex {
	const index: SizeIndex = new Map();

	for (const range of ranges) {
		if (range.status && range.status !== "Active") continue;
		const bucket = index.get(key(range.skin_type));
		if (bucket) bucket.push(range);
		else index.set(key(range.skin_type), [range]);
	}

	for (const bucket of index.values()) {
		bucket.sort((a, b) => flt(a.min_range) - flt(b.min_range));
	}

	return index;
}

/** Range name covering `feetage`, or "" when nothing does - matching `_match_size`. */
export function matchSize(index: SizeIndex, skinType: string | null | undefined, feetage: unknown): string {
	const feet = flt(feetage);
	for (const range of index.get(key(skinType)) ?? []) {
		if (flt(range.min_range) <= feet && feet <= flt(range.max_range)) return range.range_name;
	}
	return "";
}

/**
 * Skin types whose active bands overlap, and the bands that do.
 *
 * Worth reporting rather than silently tolerating: where two bands cover the same
 * feetage the server's choice is arbitrary, so a row can show one size on the station
 * and come back from the push carrying another. The fix is in the Skin Type Range
 * master, not in either client.
 */
export function findOverlaps(index: SizeIndex): { skin_type: string; a: string; b: string }[] {
	const clashes: { skin_type: string; a: string; b: string }[] = [];

	for (const [skinType, bucket] of index) {
		for (let i = 1; i < bucket.length; i++) {
			const previous = bucket[i - 1]!;
			const current = bucket[i]!;
			if (flt(current.min_range) <= flt(previous.max_range)) {
				clashes.push({ skin_type: skinType, a: previous.range_name, b: current.range_name });
			}
		}
	}

	return clashes;
}

/** Feetage bands with no cover at all, so a gap is reported before a shift, not during it. */
export function findGaps(index: SizeIndex): { skin_type: string; from: number; to: number }[] {
	const gaps: { skin_type: string; from: number; to: number }[] = [];

	for (const [skinType, bucket] of index) {
		for (let i = 1; i < bucket.length; i++) {
			const previous = bucket[i - 1]!;
			const current = bucket[i]!;
			if (flt(current.min_range) > flt(previous.max_range)) {
				gaps.push({ skin_type: skinType, from: flt(previous.max_range), to: flt(current.min_range) });
			}
		}
	}

	return gaps;
}
