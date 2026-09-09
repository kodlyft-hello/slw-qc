"""Generate parity fixtures from the real slw Python, for the TypeScript ports to match.

The QC Check List controller re-derives size, rate and the summary on every push, so any
divergence between this app's TypeScript and that Python shows up as a number changing
under the operator after they sync. The controller's own docstring records that this
grouping once existed as three client-side implementations that disagreed; the desktop
adds a fourth, and this file is the reason that is safe.

Run against a seeded site:

    cd /home/erp/frappe-bench/sites
    ../env/bin/python ../apps/slw-qc/scripts/generate_parity_fixtures.py

Writes tests/fixtures/parity.json. Regenerate whenever the controller's rules change.
"""

import json
import os
import sys

import frappe

OUT = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures", "parity.json")


def build_size_cases(qc):
	"""Feetage values chosen to sit exactly on the band edges, where an off-by-one in a
	comparison hides. The Python uses inclusive bounds on both sides."""
	ranges = frappe.get_all(
		"Skin Type Range",
		filters={"status": "Active"},
		fields=["skin_type", "range_name", "min_range", "max_range", "status"],
	)

	feetages = []
	for row in ranges:
		lo, hi = float(row.min_range), float(row.max_range)
		feetages += [lo, hi, lo - 0.01, hi + 0.01, (lo + hi) / 2, round((lo + hi) / 3, 2)]
	feetages += [0, 0.5, 4.99, 5, 100, 100.01, 250, -3]

	skin_types = sorted({r.skin_type for r in ranges}) + ["Unknown", "", None, " Cow "]

	index = qc._size_ranges(r.skin_type for r in ranges)
	cases = []
	for skin_type in skin_types:
		for feetage in sorted(set(feetages)):
			cases.append(
				{
					"skin_type": skin_type,
					"feetage": feetage,
					"expected": qc._match_size(index, skin_type, feetage),
				}
			)

	return {"ranges": [dict(r) for r in ranges], "cases": cases}


def build_rate_cases(qc):
	"""Includes a superseded Tounch Rate, so "latest entry_date wins" is actually
	exercised rather than assumed. Inserted inside the transaction this script rolls
	back, so the site is left exactly as it was found."""
	frappe.get_doc(
		{
			"doctype": "Tounch Rate",
			"entry_date": "2020-01-01",
			"skin_type": "Cow",
			"grade": "A",
			"tounch_size_rate": [
				{"size": "Cow Small", "tounch_rate": 1},
				{"size": "Cow Medium", "tounch_rate": 2},
				# priced ONLY on the old sheet: the newer doc must still win, giving 0
				{"size": "Cow Large", "tounch_rate": 3},
			],
		}
	).insert(ignore_permissions=True)

	rate_docs = frappe.get_all(
		"Tounch Rate", fields=["name", "skin_type", "grade", "entry_date", "creation"]
	)
	size_details = frappe.get_all(
		"Tounch Size Details", fields=["parent", "size", "tounch_rate"], limit_page_length=0
	)

	grades = frappe.get_all("Grade", pluck="name") + ["Z", ""]
	skin_types = frappe.get_all("Skin Type", pluck="name") + ["Unknown", ""]
	sizes = frappe.get_all("Skin Type Range", pluck="name") + ["No Such Size", ""]

	combos = [
		{"skin_type": st, "grade": g, "size": sz} for st in skin_types for g in grades for sz in sizes
	]
	expected = qc._touch_rate_map(combos)

	return {
		"rate_docs": [
			{
				"name": d.name,
				"skin_type": d.skin_type,
				"grade": d.grade,
				"entry_date": str(d.entry_date) if d.entry_date else None,
				"creation": str(d.creation) if d.creation else None,
			}
			for d in rate_docs
		],
		"size_details": [dict(d) for d in size_details],
		"cases": [
			{**combo, "expected": float(expected.get(qc.rate_key(combo["skin_type"], combo["grade"], combo["size"]), 0))}
			for combo in combos
		],
	}


def build_summary_cases(qc):
	"""Grouping is pure Python, so the inputs are free to be nastier than real data:
	mixed case and accents prove the ordering is code-point (Python `sorted`) and not
	`localeCompare`, which is where the desk script and the server already disagree."""
	scenarios = {
		"empty": [],
		"blank_status_is_kept": [
			{"grade": "A", "skin_type": "Cow", "size": "Cow Small", "no_pieces": 1, "feetage": 8},
			{"grade": "A", "skin_type": "Cow", "size": "Cow Small", "status": None, "no_pieces": 1, "feetage": 9},
		],
		"only_rejected_is_dropped": [
			{"grade": "A", "skin_type": "Cow", "size": "Cow Small", "status": "Accepted", "no_pieces": 1, "feetage": 8},
			{"grade": "A", "skin_type": "Cow", "size": "Cow Small", "status": "Rejected", "no_pieces": 1, "feetage": 9},
			{"grade": "A", "skin_type": "Cow", "size": "Cow Small", "status": "", "no_pieces": 1, "feetage": 7},
		],
		"case_sensitive_ordering": [
			{"grade": "a", "skin_type": "Cow", "size": "S", "no_pieces": 1, "feetage": 5},
			{"grade": "B", "skin_type": "Cow", "size": "S", "no_pieces": 1, "feetage": 6},
			{"grade": "A", "skin_type": "Cow", "size": "S", "no_pieces": 1, "feetage": 7},
			{"grade": "b", "skin_type": "Cow", "size": "S", "no_pieces": 1, "feetage": 8},
		],
		"separator_collision": [
			# "A" / "Cow Small" / "X" and "A" / "Cow" / "Small X" must stay two groups
			{"grade": "A", "skin_type": "Cow Small", "size": "X", "no_pieces": 3, "feetage": 10},
			{"grade": "A", "skin_type": "Cow", "size": "Small X", "no_pieces": 5, "feetage": 20},
		],
		"missing_fields_become_blank": [
			{"no_pieces": 2, "feetage": 11},
			{"grade": None, "skin_type": None, "size": None, "no_pieces": 1, "feetage": 3},
		],
		"string_numbers_are_coerced": [
			{"grade": "A", "skin_type": "Cow", "size": "S", "no_pieces": "3", "feetage": "12.5"},
			{"grade": "A", "skin_type": "Cow", "size": "S", "no_pieces": "2.9", "feetage": "7,5"},
			{"grade": "A", "skin_type": "Cow", "size": "S", "no_pieces": None, "feetage": None},
		],
		"unicode_ordering": [
			{"grade": "Z", "skin_type": "Cow", "size": "S", "no_pieces": 1, "feetage": 5},
			{"grade": "Ä", "skin_type": "Cow", "size": "S", "no_pieces": 1, "feetage": 6},
			{"grade": "A", "skin_type": "Cow", "size": "S", "no_pieces": 1, "feetage": 7},
		],
	}

	out = {}
	for label, rows in scenarios.items():
		docs = [frappe._dict(r) for r in rows]
		out[label] = {"rows": rows, "expected": qc.group_checklist_rows(docs)}
	return out


def main():
	frappe.init(site="slw.com")
	frappe.connect()
	frappe.set_user("Administrator")

	from slw.slw.doctype.qc_check_list import qc_check_list as qc

	try:
		fixtures = {
			"generated_from": "slw.slw.doctype.qc_check_list.qc_check_list",
			"sizing": build_size_cases(qc),
			"rates": build_rate_cases(qc),
			"summary": build_summary_cases(qc),
		}
	finally:
		# Never leave the extra Tounch Rate behind.
		frappe.db.rollback()

	os.makedirs(os.path.dirname(OUT), exist_ok=True)
	with open(OUT, "w") as fh:
		json.dump(fixtures, fh, indent=1, sort_keys=True, default=str)

	print(f"wrote {os.path.relpath(OUT)}")
	print(f"  sizing cases : {len(fixtures['sizing']['cases'])}")
	print(f"  rate cases   : {len(fixtures['rates']['cases'])}")
	print(f"  summary cases: {len(fixtures['summary'])}")
	frappe.destroy()


if __name__ == "__main__":
	sys.exit(main())
