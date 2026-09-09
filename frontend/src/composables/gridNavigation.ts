/**
 * Where the caret goes next. Pure, so the rules can be tested without a DOM.
 *
 * The movement model is shaped around what the operator physically does: pick up a
 * hide, measure it, type the feetage, put it down, pick up the next one. That is a
 * column of numbers, so Enter and Down move down the same column rather than across
 * the row, and the value is selected on arrival so the next keystroke replaces it.
 *
 * Nothing here ever moves the caret on its own. The desk form re-focuses a cell 300ms
 * after an error, which lands keystrokes typed in that window in the wrong cell; every
 * move in this module is the direct result of a key the operator pressed.
 */

export interface GridPosition {
	row: number;
	column: string;
}

export type NavigationResult =
	| { kind: "move"; to: GridPosition }
	| { kind: "append" }
	| { kind: "exit"; direction: -1 | 1 }
	| { kind: "none" };

export interface NavigationContext {
	columns: readonly string[];
	rowCount: number;
	/** True when the caret sits at the start/end of the text, so a sideways key may leave. */
	atStart: boolean;
	atEnd: boolean;
	/** Enter on the last row adds a row instead of leaving the grid. */
	appendOnEnter?: boolean;
}

function clampColumn(columns: readonly string[], index: number): string | null {
	return columns[index] ?? null;
}

export function nextPosition(
	key: string,
	current: GridPosition,
	context: NavigationContext
): NavigationResult {
	const columnIndex = context.columns.indexOf(current.column);
	if (columnIndex === -1) return { kind: "none" };

	const down = (): NavigationResult => {
		if (current.row + 1 < context.rowCount) {
			return { kind: "move", to: { row: current.row + 1, column: current.column } };
		}
		if (context.appendOnEnter) return { kind: "append" };
		return { kind: "exit", direction: 1 };
	};

	switch (key) {
		case "Enter":
		case "ArrowDown":
			return down();

		case "ArrowUp":
			if (current.row > 0) return { kind: "move", to: { row: current.row - 1, column: current.column } };
			return { kind: "exit", direction: -1 };

		case "ArrowLeft": {
			// Only leave the field once the caret has reached its left edge, so arrowing
			// through a mistyped number does not jump columns mid-correction.
			if (!context.atStart) return { kind: "none" };
			const previous = clampColumn(context.columns, columnIndex - 1);
			if (previous) return { kind: "move", to: { row: current.row, column: previous } };
			return { kind: "none" };
		}

		case "ArrowRight": {
			if (!context.atEnd) return { kind: "none" };
			const next = clampColumn(context.columns, columnIndex + 1);
			if (next) return { kind: "move", to: { row: current.row, column: next } };
			return { kind: "none" };
		}

		case "Tab": {
			const next = clampColumn(context.columns, columnIndex + 1);
			if (next) return { kind: "move", to: { row: current.row, column: next } };
			// Past the last column, wrap to the first column of the next row.
			if (current.row + 1 < context.rowCount) {
				return { kind: "move", to: { row: current.row + 1, column: context.columns[0]! } };
			}
			return { kind: "exit", direction: 1 };
		}

		default:
			return { kind: "none" };
	}
}

/**
 * The first row that still needs measuring, so reopening a half-done checklist puts the
 * operator back where they stopped rather than at the top of a thousand rows.
 */
export function firstUnmeasuredRow(rows: readonly { feetage?: unknown }[]): number {
	const index = rows.findIndex((row) => !Number(row.feetage));
	return index === -1 ? Math.max(0, rows.length - 1) : index;
}
