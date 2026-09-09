/**
 * Row windowing.
 *
 * A GRN of a few hundred hides becomes a row per hide, and the desk form renders them
 * all into a paginated DOM grid that repaints on every summary rebuild. Rendering only
 * the visible slice makes 2,000 rows cost what 40 rows cost, and removes the pagination
 * that made the operator lose their place.
 */

export interface Window {
	start: number;
	end: number;
	paddingTop: number;
	paddingBottom: number;
}

export interface WindowInput {
	scrollTop: number;
	viewportHeight: number;
	rowHeight: number;
	rowCount: number;
	/** Rows rendered beyond each edge, so a fast scroll does not show blank space. */
	overscan?: number;
}

export function computeWindow({
	scrollTop,
	viewportHeight,
	rowHeight,
	rowCount,
	overscan = 8,
}: WindowInput): Window {
	if (rowHeight <= 0 || rowCount <= 0) {
		return { start: 0, end: 0, paddingTop: 0, paddingBottom: 0 };
	}

	const firstVisible = Math.floor(scrollTop / rowHeight);
	const visibleCount = Math.ceil(viewportHeight / rowHeight);

	const start = Math.max(0, firstVisible - overscan);
	const end = Math.min(rowCount, firstVisible + visibleCount + overscan);

	return {
		start,
		end,
		// Spacers rather than absolute positioning, so the scrollbar reflects the real
		// row count and a native scroll-to still lands in the right place.
		paddingTop: start * rowHeight,
		paddingBottom: Math.max(0, (rowCount - end) * rowHeight),
	};
}

/** Scroll offset that brings a row fully into view, or null when it already is. */
export function scrollToRow(
	index: number,
	{ scrollTop, viewportHeight, rowHeight }: Omit<WindowInput, "rowCount" | "overscan">
): number | null {
	const rowTop = index * rowHeight;
	const rowBottom = rowTop + rowHeight;

	if (rowTop < scrollTop) return rowTop;
	if (rowBottom > scrollTop + viewportHeight) return rowBottom - viewportHeight;
	return null;
}
