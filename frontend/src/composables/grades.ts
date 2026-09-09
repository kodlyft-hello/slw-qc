/**
 * Grade: the one field on the grid that is chosen rather than measured.
 *
 * A feetage is the operator's reading and is kept whatever it says. A grade is a master
 * value - one that is not on the Grade list prices nothing, groups into a summary line of
 * its own, and is refused by ERPNext on submit - so the grid offers the list and accepts
 * only what is on it, the way a Link field does on the desk form.
 *
 * The rules live here rather than in the component so they can be tested without a DOM,
 * and so the two callers cannot answer the same question differently.
 */

/** Grades matching what has been typed, prefixes first, as a Link field ranks them. */
export function gradeOptions(grades: readonly string[], text: string): string[] {
	const needle = text.trim().toLowerCase();
	if (!needle) return grades.slice();

	const starts = grades.filter((grade) => grade.toLowerCase().startsWith(needle));
	const contains = grades.filter(
		(grade) => !grade.toLowerCase().startsWith(needle) && grade.toLowerCase().includes(needle)
	);
	return [...starts, ...contains];
}

/**
 * The one grade this text names, or null.
 *
 * Case-insensitive, so "a" reaches "A": an operator typing at speed should not have to
 * find the shift key, and there is no ambiguity to protect - a Grade master with both "a"
 * and "A" in it would be a data problem long before it reached this grid.
 */
export function matchGrade(grades: readonly string[], text: string): string | null {
	const needle = text.trim().toLowerCase();
	if (!needle) return null;
	return grades.find((grade) => grade.toLowerCase() === needle) ?? null;
}

/**
 * The rows a grade carries down to.
 *
 * Hides are graded in runs, so setting a grade fills it into every row below - the desk
 * form's behaviour, and the thing that makes grading 2,000 rows possible at all. Two
 * limits, both taken from the desk form:
 *
 *   - rows that already hold the grade are left out, so the write stays as small as the
 *     change actually is;
 *   - clearing a grade fills nothing, because spreading a blank over work already graded
 *     is nobody's intent.
 */
export function fillDownTargets<T extends { grade: string | null }>(
	rows: readonly T[],
	fromIndex: number,
	grade: string | null
): T[] {
	if (!grade || fromIndex < 0) return [];
	return rows.slice(fromIndex + 1).filter((row) => row.grade !== grade);
}
