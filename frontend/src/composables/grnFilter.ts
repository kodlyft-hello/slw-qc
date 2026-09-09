/**
 * Narrowing the GRN list.
 *
 * A station that has been running a while mirrors every submitted GRN, and an operator
 * arriving with a docket in their hand knows one thing: a number, or a vendor's name.
 * Scrolling a list of hundreds to find it is the sort of small friction that makes people
 * stop using the tool.
 *
 * Pure and separate from the page so the matching rules can be tested without a DOM.
 */
import type { InwardOption } from "../../../electron/preload";

export type GrnStatusFilter = "available" | "started" | "all";

export interface GrnQuery {
	text: string;
	status: GrnStatusFilter;
}

function haystack(option: InwardOption): string {
	// Everything printed on the row, so whatever the operator can see, they can search.
	return [option.name, option.vendor, option.vendor_name, option.reference_no, option.date]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
}

/**
 * Every whitespace-separated term must appear somewhere in the row.
 *
 * Terms are ANDed rather than matched as one phrase, so "hide 09" finds a September GRN
 * from Hide Traders without the operator having to remember which column comes first.
 */
export function matchesText(option: InwardOption, text: string): boolean {
	const terms = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length) return true;

	const target = haystack(option);
	return terms.every((term) => target.includes(term));
}

export function matchesStatus(option: InwardOption, status: GrnStatusFilter): boolean {
	if (status === "all") return true;
	// "Started" means this station already holds a checklist for it, whatever its state.
	const started = !!option.local_checklist;
	return status === "started" ? started : !started;
}

export function filterInwards(options: readonly InwardOption[], query: GrnQuery): InwardOption[] {
	return options.filter((option) => matchesStatus(option, query.status) && matchesText(option, query.text));
}

export function countByStatus(options: readonly InwardOption[]): Record<GrnStatusFilter, number> {
	let started = 0;
	for (const option of options) if (option.local_checklist) started += 1;

	return { all: options.length, started, available: options.length - started };
}
