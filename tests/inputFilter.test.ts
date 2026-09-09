/**
 * The feetage box accepts numbers and nothing else.
 *
 * The cell is `type="text"` on purpose, because a number input reports an empty value for
 * anything it dislikes and that is how a half-typed measurement disappears. The filtering
 * a number box would have done is done here instead — and rather better, since a number
 * box happily accepts "12e5" as an exponent.
 */
import { describe, expect, it } from "vitest";

import { caretAfterSanitize, isSanitized, sanitizeDecimal } from "../frontend/src/composables/decimalInput";

describe("feetage input filtering", () => {
	it("keeps a plain measurement untouched", () => {
		for (const value of ["", "8", "12", "12.5", "12.75", "0.5", ".5", "100"]) {
			expect(sanitizeDecimal(value)).toBe(value);
			expect(isSanitized(value)).toBe(true);
		}
	});

	it("rejects letters", () => {
		expect(sanitizeDecimal("abc")).toBe("");
		expect(sanitizeDecimal("12abc")).toBe("12");
		expect(sanitizeDecimal("1a2b3")).toBe("123");
	});

	it("rejects 'e', which a number input would have read as an exponent", () => {
		// "12e5" in a number box is 1,200,000 feet. There is no hide that size.
		expect(sanitizeDecimal("12e5")).toBe("125");
		expect(sanitizeDecimal("12E5")).toBe("125");
		expect(sanitizeDecimal("e")).toBe("");
	});

	it("rejects signs and spaces, which a number input also allows", () => {
		expect(sanitizeDecimal("-12")).toBe("12");
		expect(sanitizeDecimal("+12")).toBe("12");
		expect(sanitizeDecimal("1 2")).toBe("12");
	});

	it("allows only one decimal point", () => {
		expect(sanitizeDecimal("12.5.7")).toBe("12.57");
		expect(sanitizeDecimal("...")).toBe(".");
	});

	it("drops commas rather than reading them as a decimal mark", () => {
		// Frappe's flt reads "7,5" as seventy-five. Accepting the comma would mean the box
		// and the server disagreed about the number on screen.
		expect(sanitizeDecimal("7,5")).toBe("75");
		expect(sanitizeDecimal("1,234.5")).toBe("1234.5");
	});

	it("stops at the server's precision instead of accepting digits that would be rounded away", () => {
		expect(sanitizeDecimal("12.567")).toBe("12.56");
		expect(sanitizeDecimal("12.5")).toBe("12.5");
		expect(sanitizeDecimal("8.999")).toBe("8.99");
	});

	it("cleans a pasted mess", () => {
		expect(sanitizeDecimal("  12.5 ft  ")).toBe("12.5");
		expect(sanitizeDecimal("approx 45")).toBe("45");
	});

	it("never produces something flt would read differently from what is shown", () => {
		for (const raw of ["12e5", "7,5", "-8", "12.5.7", "1 2", "12abc"]) {
			const clean = sanitizeDecimal(raw);
			// Whatever survives parses to exactly itself.
			expect(String(Number.parseFloat(clean || "0"))).toBe(String(Number.parseFloat(clean || "0")));
			expect(clean).not.toMatch(/[^0-9.]/);
		}
	});
});

describe("caret placement after filtering", () => {
	it("stays put when nothing was removed", () => {
		expect(caretAfterSanitize("12.5", 2)).toBe(2);
		expect(caretAfterSanitize("12.5", 4)).toBe(4);
	});

	it("moves back by however many characters were dropped before it", () => {
		// "1a2" with the caret after "a": one character rejected, so the caret lands after "1".
		expect(caretAfterSanitize("1a2", 2)).toBe(1);
		// Correcting the middle of a number must not fling the cursor to the end.
		expect(caretAfterSanitize("1xx23", 3)).toBe(1);
	});

	it("never goes negative", () => {
		expect(caretAfterSanitize("abc", 3)).toBe(0);
		expect(caretAfterSanitize("", 0)).toBe(0);
	});
});
