# SLW QC — desktop measuring station

An offline-first Electron station for entering **QC Check List** feetage and grade at the
speed a person can measure hides.

## Why it exists

QC operators measure a hide, type its feetage, and move to the next one, hundreds of
times a shift. On the Frappe desk form that loop stalls and values go missing. Six things
in `qc_check_list.js` compound:

| # | In the desk form | Effect |
|---|---|---|
| 1 | Each feetage commit fires a debounced size lookup, which chains into a rate lookup | Two network round trips per hide |
| 2 | The summary is cleared and rebuilt row by row on every burst | Whole-table repaint while typing |
| 3 | Entering a grade rewrites every row below and refreshes the grid | Whole-grid repaint |
| 4 | A feetage under 5 is **reset to 0** and throws a modal | The `1` on the way to `12` erases the measurement |
| 5 | The error path re-focuses a cell 300 ms later | Keystrokes land in the wrong cell |
| 6 | 400 hides become 400 rows paginated at 50 | Page jumps lose the operator's place |

The station removes all six. Masters are mirrored into SQLite, so size and rate resolve
from an in-memory index rather than the network; the grid renders only the visible rows;
and **a value the operator typed is never rewritten** — an out-of-range feetage is marked
in red and reported at confirm time.

## How it fits together

```
Inward Raw Hide (submitted)
        │  pull
        ▼
   SQLite mirror ── in-memory size + rate index
        │
        ▼
   local draft ── operator measures ── autosave (synchronous, sub-ms)
        │
     confirm  ── document + outbox row written in ONE transaction
        │  push
        ▼
   QC Check List, submitted, in ERPNext
```

The push payload is deliberately thin: only `item_code`, `skin_type`, `grade`, `feetage`,
`no_pieces` and `status`. `QCCheckList.validate` recomputes size, rate, `net_amount`,
`grand_total` and the whole summary server-side, so the station cannot corrupt pricing and
ERPNext stays the only authority on money.

### Two identifiers, two jobs

| | Example | Who sees it | Purpose |
|---|---|---|---|
| `local_name` | `QC-00001` | the operator | The readable name on screen and down the phone. A plain running number, restarting at 1 on every station. Never sent to the server. |
| `offline_uuid` | `d593696b-…` | nobody | The push dedupe key. Never displayed. |
| `erp_name` | `QCCL-2026-00001` | the operator, after sync | Assigned by ERPNext on submit. |

These cannot be collapsed into one value. `offline_uuid` makes the push idempotent: a
timeout that arrives *after* the server committed is indistinguishable from one that
arrives before, so without a client-generated key every retry risks a duplicate checklist
against the same GRN. `local_name` cannot do that job, because two stations both produce
`QC-00001` for different work — the server's unique index would treat the second as a
duplicate of the first and silently discard a shift's measurements.

Equally, a UUID cannot be the name: nobody reads one out over a factory PA.

## Server side

Lives in the `slw` app, not here:

- `slw/api/qc_desktop.py` — `ping`, `session_bootstrap`, `pull`, `push`, `update_inward_qty`.
  Every endpoint runs under the caller's own permissions; there is no `ignore_permissions`
  and no service account.
- `QC Check List.offline_uuid` — hidden, unique, NULL for anything created in the browser.

Operators who cannot read `Tounch Size Details.tounch_rate` (permlevel 1, System Manager
only) receive no rates, and the Rate and Net columns are hidden. ERPNext still prices the
checklist correctly on submit.

## Running it

```bash
npm install
npm run dev            # Vite + Electron
npm run build          # typecheck, then bundle renderer + main + preload
npm run dist:win       # signed NSIS installer (CSC_LINK / CSC_KEY_PASSWORD in CI)
npm run icon           # regenerate build/icon.{ico,png}
```

`better-sqlite3` ships N-API prebuilds, which are ABI-stable across both Node and
Electron, so there is **no** per-target rebuild step. It does require Node 22 or newer,
which is why Electron is pinned to a release that bundles Node 22.

Two things the packaging step is fussy about, both of which fail the build outright:

- **Electron must be an exact version**, not a range. electron-builder downloads
  platform binaries for a specific release and cannot resolve `^43.3.0`. Pinning also
  keeps the native-module ABI reproducible across machines.
- **`build/icon.ico` must exist** and be a real multi-size Windows icon. `npm run icon`
  regenerates it; the current one is a placeholder measuring rule, so replace it with real
  branding when there is some.

## Tests

```bash
npm test               # 386 offline tests
npm run test:e2e       # opt-in, needs a running bench (see below)
```

**Parity tests are the important ones.** The `QCCheckList` controller re-derives size,
rate and the summary on every push, so anywhere this app disagrees with the Python, the
operator watches a number change after syncing. `tests/parity.test.ts` runs the
TypeScript ports against fixtures generated by the real controller:

```bash
cd /home/erp/frappe-bench/sites
../env/bin/python ../apps/slw-qc/scripts/generate_parity_fixtures.py
```

Regenerate those whenever the controller's rules change. The controller's own docstring
records that this grouping once existed as three client implementations that disagreed;
this is a fourth, and the fixtures are why that is safe.

Two divergences the fixtures pin down, where the **server's** behaviour is the one
implemented:

- Ordering is by code point (Python `sorted`), giving `A, B, a, b`. The desk script uses
  `localeCompare` and orders a mixed-case summary differently from the saved document.
- Only rows explicitly marked `Rejected` are dropped from the summary. A blank status
  means "not judged yet". The desk script drops anything not `Accepted`.

### End-to-end

Needs a bench **pinned to one site** — a shared `frappe serve` resolves by Host header and,
with `serve_default_site` set, can answer for the wrong site entirely:

```bash
cd /home/erp/frappe-bench/sites
../env/bin/python -m frappe.utils.bench_helper frappe --site slw.com serve --port 8901

cd /home/erp/frappe-bench/apps/slw-qc
SLWQC_E2E=1 npm run test:e2e
```

Override with `SLWQC_E2E_URL`, `SLWQC_E2E_USER`, `SLWQC_E2E_PASSWORD`.

## Layout

```
electron/
  domain/       pure ports of the controller's rules (sizing, rates, summary, validation)
  db/           schema.sql, connection, repositories (masters, checklists, outbox)
  sync/         ERPNext client + pull/push loop with backoff
  auth/         bcrypt offline sign-in
  config/       API secret encrypted via OS keychain
  ipc/          result-envelope handlers
frontend/src/
  components/QcGrid.vue    the virtualised measuring grid
  composables/             navigation and windowing, both pure and tested
  pages/                   Login, GrnPicker, Checklist, Queue
```

`electron/domain/` holds no I/O and no Electron imports, which is what lets the parity
suite run it directly against Python-generated fixtures.
