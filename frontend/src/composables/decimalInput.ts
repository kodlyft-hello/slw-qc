/**
 * Keeping a feetage box numeric.
 *
 * The cell is `type="text"`, not `type="number"`, and deliberately so: a number input
 * reports an empty value for anything it considers invalid, which is precisely how a
 * half-typed measurement goes missing. The cost of that choice is that the box would
 * otherwise accept anything at all, so the filtering it loses is done here instead.
 *
 * `e` is the one worth calling out. A number input accepts it as an exponent, so "12e5"
 * is a legal 1,200,000 feet, and an operator who fumbles the key next to `w` gets a hide
 * the size of a county. There is no exponent notation in a feetage, so it is dropped like
 * any other letter.
 */

/** Feetage is a Float with precision 2 on the server; more digits would be rounded away. */
export const FEETAGE_DECIMALS = 2;

/**
 * Strip everything that cannot appear in a measurement.
 *
 * Digits and a single decimal point survive. Letters (`e` included), signs, spaces and
 * separators do not. Commas are dropped rather than treated as a decimal mark, matching
 * Frappe's `flt`, which reads "7,5" as seventy-five - so letting one through would mean
 * the station and the server disagreed about the number on screen.
 */
export function sanitizeDecimal(text: string, maxDecimals = FEETAGE_DECIMALS): string {
	let out = "";
	let decimals = -1; // -1 until a point is seen

	for (const character of text) {
		if (character >= "0" && character <= "9") {
			// Silently ignore digits past the server's precision rather than accepting a
			// number that would change under the operator on save.
			if (decimals >= 0) {
				if (decimals >= maxDecimals) continue;
				decimals += 1;
			}
			out += character;
			continue;
		}

		if (character === "." && decimals === -1) {
			out += character;
			decimals = 0;
		}
	}

	return out;
}

/**
 * Where the caret belongs after sanitising.
 *
 * Without this the caret jumps to the end whenever a character is rejected, so correcting
 * the middle of a number becomes impossible: every stray keystroke would fling the cursor
 * to the far end of the box.
 */
export function caretAfterSanitize(raw: string, caret: number, maxDecimals = FEETAGE_DECIMALS): number {
	const keptBeforeCaret = sanitizeDecimal(raw.slice(0, caret), maxDecimals).length;
	return Math.max(0, keptBeforeCaret);
}

/** True when the text is already clean, so an untouched input is never rewritten. */
export function isSanitized(text: string, maxDecimals = FEETAGE_DECIMALS): boolean {
	return sanitizeDecimal(text, maxDecimals) === text;
}
