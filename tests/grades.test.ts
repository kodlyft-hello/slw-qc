/**
 * Grade: picked from the master, and carried down the stack.
 *
 * Two behaviours the desk form established and the station has to keep, because operators
 * move between the two: a grade is chosen from the Grade list rather than typed freehand,
 * and setting one fills it into every row below.
 */
import { describe, expect, it } from "vitest";

import { fillDownTargets, gradeOptions, matchGrade } from "../frontend/src/composables/grades";

const GRADES = ["A", "B", "Reject", "Selected A"];

describe("grade options", () => {
	it("offers the whole list before anything is typed, so the field reads as a picker", () => {
		expect(gradeOptions(GRADES, "")).toEqual(GRADES);
		expect(gradeOptions(GRADES, "   ")).toEqual(GRADES);
	});

	it("ranks prefixes above substrings, as a Link field does", () => {
		// "A" and "Selected A" both match; the one the operator is most likely typing wins.
		expect(gradeOptions(GRADES, "a")).toEqual(["A", "Selected A"]);
	});

	it("matches case-insensitively", () => {
		expect(gradeOptions(GRADES, "REJ")).toEqual(["Reject"]);
	});

	it("returns nothing rather than everything when nothing matches", () => {
		expect(gradeOptions(GRADES, "zz")).toEqual([]);
	});
});

describe("matching a typed grade", () => {
	it("accepts a grade whatever case it arrives in", () => {
		expect(matchGrade(GRADES, "a")).toBe("A");
		expect(matchGrade(GRADES, " reject ")).toBe("Reject");
	});

	it("refuses a grade nobody has defined", () => {
		// The decisive one: an invented grade prices nothing and is refused by ERPNext on
		// submit, so the grid must not let it get that far.
		expect(matchGrade(GRADES, "AA")).toBeNull();
	});

	it("treats an empty cell as no grade rather than a bad one", () => {
		expect(matchGrade(GRADES, "")).toBeNull();
	});

	it("has nothing to offer when the Grade master has not synced", () => {
		expect(matchGrade([], "A")).toBeNull();
		expect(gradeOptions([], "A")).toEqual([]);
	});
});

describe("filling a grade down", () => {
	const rows = () => [
		{ id: 1, grade: null as string | null },
		{ id: 2, grade: null as string | null },
		{ id: 3, grade: "B" as string | null },
		{ id: 4, grade: null as string | null },
	];

	it("carries the grade to every row below the one that was set", () => {
		expect(fillDownTargets(rows(), 0, "A").map((row) => row.id)).toEqual([2, 3, 4]);
	});

	it("starts below the row itself, never above it", () => {
		// Rows already measured and graded higher up the stack are finished work.
		expect(fillDownTargets(rows(), 2, "A").map((row) => row.id)).toEqual([4]);
	});

	it("skips rows that already hold the grade, so the write is as small as the change", () => {
		// Row 3 already reads B, so only 2 and 4 are written.
		expect(fillDownTargets(rows(), 0, "B").map((row) => row.id)).toEqual([2, 4]);
	});

	it("fills nothing when the grade is cleared", () => {
		// Spreading a blank over rows already graded is nobody's intent, and the desk form
		// stops here too.
		expect(fillDownTargets(rows(), 0, null)).toEqual([]);
	});

	it("fills nothing from a row that is not in the list", () => {
		expect(fillDownTargets(rows(), -1, "A")).toEqual([]);
	});
});
