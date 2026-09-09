/**
 * Touch rate resolution: the client-side port of `_touch_rate_map` in
 * `slw/slw/doctype/qc_check_list/qc_check_list.py`.
 *
 * The rule that matters is "latest wins": for a given skin type and grade the server
 * takes the newest Tounch Rate by `entry_date` then `creation`, and reads the size
 * rates off that one document alone. Older Tounch Rate documents are not consulted at
 * all, so a size priced only on last year's sheet resolves to 0, not to last year's
 * price. Getting this subtly wrong would show the operator a rate the server then
 * silently replaced.
 */
import { flt } from "./frappeValues";

export interface TouchRateDoc {
	name: string;
	skin_type: string;
	grade: string;
	entry_date: string | null;
	creation: string | null;
}

export interface TouchSizeDetail {
	parent: string;
	size: string;
	/** Withheld when the operator lacks permlevel-1 read on Tounch Rate. */
	tounch_rate?: number | null;
}

export type RateIndex = Map<string, number>;

const SEP = "|||";

export function rateKey(skinType: string, grade: string, size: string): string {
	return [skinType, grade, size].join(SEP);
}

function pairKey(skinType: string, grade: string): string {
	return skinType + SEP + grade;
}

/**
 * Descending by entry_date then creation, so the first document seen for a pair is the
 * one the server would pick. Blank dates sort last rather than throwing, mirroring how
 * MariaDB orders NULLs under DESC.
 */
function newestFirst(a: TouchRateDoc, b: TouchRateDoc): number {
	const byDate = (b.entry_date ?? "").localeCompare(a.entry_date ?? "");
	if (byDate !== 0) return byDate;
	return (b.creation ?? "").localeCompare(a.creation ?? "");
}

/** Flatten the touch rate masters into one lookup keyed by skin type, grade and size. */
export function buildRateIndex(
	rateDocs: readonly TouchRateDoc[],
	sizeDetails: readonly TouchSizeDetail[]
): RateIndex {
	const latestForPair = new Map<string, string>();
	for (const doc of [...rateDocs].sort(newestFirst)) {
		const pair = pairKey(doc.skin_type, doc.grade);
		if (!latestForPair.has(pair)) latestForPair.set(pair, doc.name);
	}

	const pairForDoc = new Map<string, { skin_type: string; grade: string }>();
	for (const doc of rateDocs) {
		if (latestForPair.get(pairKey(doc.skin_type, doc.grade)) === doc.name) {
			pairForDoc.set(doc.name, { skin_type: doc.skin_type, grade: doc.grade });
		}
	}

	const index: RateIndex = new Map();
	for (const detail of sizeDetails) {
		const pair = pairForDoc.get(detail.parent);
		if (!pair) continue; // a superseded Tounch Rate: deliberately ignored
		index.set(rateKey(pair.skin_type, pair.grade, detail.size), flt(detail.tounch_rate));
	}

	return index;
}

/** Rate for a row, or 0 when the masters do not price this combination. */
export function matchRate(
	index: RateIndex,
	skinType: string | null | undefined,
	grade: string | null | undefined,
	size: string | null | undefined
): number {
	if (!skinType || !grade || !size) return 0;
	return flt(index.get(rateKey(skinType.trim(), grade.trim(), size.trim())));
}
