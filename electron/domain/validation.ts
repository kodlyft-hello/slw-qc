/**
 * Feetage bounds, matching MIN_FEETAGE / MAX_FEETAGE in the controller.
 *
 * The desk form treats an out-of-range value as a hard error: it resets the cell to 0
 * and throws a modal. Typing fast, the "1" on the way to "12" can commit on its own, so
 * the operator watches a measurement disappear and blames the screen. That is the
 * complaint this whole application exists to answer.
 *
 * Here an out-of-range value is kept, flagged, and reported at confirm time. Nothing is
 * ever silently rewritten, because a wrong number the operator can see beats a zero
 * they cannot.
 */
import { flt } from "./frappeValues";

export const MIN_FEETAGE = 5;
export const MAX_FEETAGE = 100;

export type ProblemField = "feetage" | "grade" | "size" | "skin_type";

export interface RowProblem {
	idx: number;
	field: ProblemField;
	message: string;
}

/**
 * Whether a value should be flagged in the grid as you type.
 *
 * A blank or zero feetage is "not measured yet", not "out of range", so it is not
 * flagged here. Confirm still rejects it, via `validateForConfirm`.
 */
export function feetageOutOfRange(feetage: unknown): boolean {
	const feet = flt(feetage);
	if (!feet) return false;
	return feet < MIN_FEETAGE || feet > MAX_FEETAGE;
}

export interface ValidatableRow {
	idx: number;
	feetage?: unknown;
	grade?: string | null;
	size?: string | null;
	skin_type?: string | null;
}

/**
 * Everything blocking a draft from being confirmed, worded exactly as the server words
 * it in `validate_feetage` and `validate_mandatory_details`.
 *
 * Matching the wording is the point: the operator should never fix what this screen
 * complains about only to be told something different by the server on push.
 */
export function validateForConfirm(rows: readonly ValidatableRow[]): RowProblem[] {
	if (!rows.length) {
		return [
			{ idx: 0, field: "feetage", message: "At least one QC Checklist Detail row is required" },
		];
	}

	const problems: RowProblem[] = [];

	for (const row of rows) {
		const feet = flt(row.feetage);

		if (feet && (feet < MIN_FEETAGE || feet > MAX_FEETAGE)) {
			problems.push({
				idx: row.idx,
				field: "feetage",
				message: `Row ${row.idx}: Feetage ${feet} must be between ${MIN_FEETAGE} and ${MAX_FEETAGE}`,
			});
		}

		if (!row.grade) {
			problems.push({ idx: row.idx, field: "grade", message: `Row ${row.idx}: Grade is required` });
		}

		if (!feet) {
			problems.push({ idx: row.idx, field: "feetage", message: `Row ${row.idx}: Feetage is required` });
		}

		if (!row.size) {
			if (!row.skin_type) {
				problems.push({
					idx: row.idx,
					field: "skin_type",
					message: `Row ${row.idx}: Skin Type is required to resolve the Size`,
				});
			} else if (feet) {
				problems.push({
					idx: row.idx,
					field: "size",
					message: `Row ${row.idx}: No active Skin Type Range for ${row.skin_type} covers a feetage of ${feet}`,
				});
			} else {
				problems.push({ idx: row.idx, field: "size", message: `Row ${row.idx}: Size is required` });
			}
		}
	}

	return problems;
}

/** Rows that cannot be confirmed, so the grid can mark them without re-running checks. */
export function problemRowIndexes(problems: readonly RowProblem[]): Set<number> {
	return new Set(problems.map((problem) => problem.idx));
}
