/**
 * Grid navigation and windowing.
 *
 * These rules are why the operator can keep up with their own hands, so they are worth
 * pinning down precisely: which key moves where, when a sideways key is allowed to
 * leave a half-typed number, and which rows are actually rendered.
 */
import { describe, expect, it } from "vitest";

import { firstUnmeasuredRow, nextPosition, type NavigationContext } from "../frontend/src/composables/gridNavigation";
import { computeWindow, scrollToRow } from "../frontend/src/composables/virtualRows";

const COLUMNS = ["grade", "feetage", "status"];

function context(overrides: Partial<NavigationContext> = {}): NavigationContext {
	return { columns: COLUMNS, rowCount: 5, atStart: false, atEnd: false, ...overrides };
}

describe("grid navigation", () => {
	it("moves down the same column on Enter, which is how hides are measured", () => {
		expect(nextPosition("Enter", { row: 0, column: "feetage" }, context())).toEqual({
			kind: "move",
			to: { row: 1, column: "feetage" },
		});
	});

	it("treats ArrowDown like Enter", () => {
		expect(nextPosition("ArrowDown", { row: 2, column: "feetage" }, context())).toEqual({
			kind: "move",
			to: { row: 3, column: "feetage" },
		});
	});

	it("moves up, and leaves the grid from the top row", () => {
		expect(nextPosition("ArrowUp", { row: 1, column: "grade" }, context())).toEqual({
			kind: "move",
			to: { row: 0, column: "grade" },
		});
		expect(nextPosition("ArrowUp", { row: 0, column: "grade" }, context())).toEqual({
			kind: "exit",
			direction: -1,
		});
	});

	it("will not jump columns while the caret is mid-number", () => {
		// Arrowing back through "125" to fix the 1 must not leave the cell.
		expect(nextPosition("ArrowLeft", { row: 0, column: "feetage" }, context({ atStart: false }))).toEqual({
			kind: "none",
		});
		expect(nextPosition("ArrowRight", { row: 0, column: "feetage" }, context({ atEnd: false }))).toEqual({
			kind: "none",
		});
	});

	it("jumps columns once the caret is at the edge", () => {
		expect(nextPosition("ArrowLeft", { row: 0, column: "feetage" }, context({ atStart: true }))).toEqual({
			kind: "move",
			to: { row: 0, column: "grade" },
		});
		expect(nextPosition("ArrowRight", { row: 0, column: "feetage" }, context({ atEnd: true }))).toEqual({
			kind: "move",
			to: { row: 0, column: "status" },
		});
	});

	it("stays put at the outer columns", () => {
		expect(nextPosition("ArrowLeft", { row: 0, column: "grade" }, context({ atStart: true }))).toEqual({
			kind: "none",
		});
		expect(nextPosition("ArrowRight", { row: 0, column: "status" }, context({ atEnd: true }))).toEqual({
			kind: "none",
		});
	});

	it("wraps Tab to the next row", () => {
		expect(nextPosition("Tab", { row: 0, column: "status" }, context())).toEqual({
			kind: "move",
			to: { row: 1, column: "grade" },
		});
	});

	it("leaves the grid past the last row", () => {
		expect(nextPosition("Enter", { row: 4, column: "feetage" }, context())).toEqual({
			kind: "exit",
			direction: 1,
		});
	});

	it("appends instead of leaving when the grid is set to grow", () => {
		expect(
			nextPosition("Enter", { row: 4, column: "feetage" }, context({ appendOnEnter: true }))
		).toEqual({ kind: "append" });
	});

	it("ignores keys it does not own, so typing is never intercepted", () => {
		for (const key of ["a", "5", ".", "Backspace", "Home", "PageDown"]) {
			expect(nextPosition(key, { row: 0, column: "feetage" }, context())).toEqual({ kind: "none" });
		}
	});

	it("resumes at the first unmeasured hide", () => {
		expect(firstUnmeasuredRow([{ feetage: 12 }, { feetage: 9 }, { feetage: 0 }, { feetage: 0 }])).toBe(2);
	});

	it("parks on the last row when everything is measured", () => {
		expect(firstUnmeasuredRow([{ feetage: 12 }, { feetage: 9 }])).toBe(1);
	});

	it("handles an empty checklist without going negative", () => {
		expect(firstUnmeasuredRow([])).toBe(0);
	});
});

describe("row windowing", () => {
	const base = { rowHeight: 32, viewportHeight: 640, rowCount: 2000 };

	it("renders a constant number of rows regardless of how many exist", () => {
		const small = computeWindow({ ...base, rowCount: 50, scrollTop: 0 });
		const huge = computeWindow({ ...base, rowCount: 100_000, scrollTop: 0 });
		expect(huge.end - huge.start).toBe(small.end - small.start);
	});

	it("keeps total height correct so the scrollbar does not lie", () => {
		const window = computeWindow({ ...base, scrollTop: 3200 });
		const rendered = (window.end - window.start) * base.rowHeight;
		expect(window.paddingTop + rendered + window.paddingBottom).toBe(base.rowCount * base.rowHeight);
	});

	it("overscans past both edges so a fast scroll shows no blank rows", () => {
		const window = computeWindow({ ...base, scrollTop: 3200 });
		expect(window.start).toBeLessThan(3200 / base.rowHeight);
		expect(window.end).toBeGreaterThan((3200 + base.viewportHeight) / base.rowHeight);
	});

	it("clamps at both ends", () => {
		expect(computeWindow({ ...base, scrollTop: 0 }).start).toBe(0);
		expect(computeWindow({ ...base, scrollTop: 2000 * 32 }).end).toBe(2000);
	});

	it("copes with an empty checklist", () => {
		expect(computeWindow({ ...base, rowCount: 0, scrollTop: 0 })).toEqual({
			start: 0,
			end: 0,
			paddingTop: 0,
			paddingBottom: 0,
		});
	});

	it("scrolls a row into view only when it is actually outside", () => {
		const view = { scrollTop: 320, viewportHeight: 640, rowHeight: 32 };
		expect(scrollToRow(15, view)).toBeNull(); // already visible
		expect(scrollToRow(2, view)).toBe(64); // above
		// row 40 spans 1280..1312; the viewport ends at 960, so scroll to 1312 - 640
		expect(scrollToRow(40, view)).toBe(672); // below
	});
});
