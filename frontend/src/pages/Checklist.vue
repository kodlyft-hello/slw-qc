<script setup lang="ts">
/**
 * The measuring screen.
 *
 * Every commit follows the same path: write locally, get the re-resolved rows back,
 * repaint. The main process resolves size and rate from in-memory indexes, so the round
 * trip is an IPC call to the same machine and never touches the network. What the
 * operator sees is therefore never waiting on ERPNext.
 */
import { computed, onMounted, ref } from "vue";

import QcGrid from "../components/QcGrid.vue";
import { useSession } from "../stores/session";
import type { Checklist, RowProblem, SummaryRow } from "../../../electron/preload";

const props = defineProps<{ localName: string }>();

const store = useSession();

const doc = ref<Checklist | null>(null);
const summary = ref<SummaryRow[]>([]);
const problems = ref<RowProblem[]>([]);
const notice = ref<string | null>(null);
const error = ref<string | null>(null);
const confirming = ref(false);
/** Set aside so a fill-down can be undone; the desk form offers no way back. */
const undo = ref<{ label: string; patches: { id: number; grade: string | null }[] } | null>(null);

const readonly = computed(() => !!doc.value && doc.value.state !== "draft" && doc.value.state !== "failed");
const problemRows = computed(() => new Set(problems.value.map((problem) => problem.idx)));
const total = computed(() => doc.value?.grand_total ?? 0);

async function load(): Promise<void> {
	doc.value = await window.qc.checklist.load(props.localName);
	await refreshDerived();
}

async function refreshDerived(): Promise<void> {
	summary.value = await window.qc.checklist.summary(props.localName);
	problems.value = await window.qc.checklist.validate(props.localName);
}

async function apply(patches: { id: number; grade?: string | null; feetage?: number }[]): Promise<void> {
	if (!patches.length) return;
	error.value = null;
	try {
		await window.qc.checklist.saveRows(props.localName, patches);
		await load();
	} catch (caught) {
		error.value = (caught as Error).message;
	}
}

function onCommit(payload: { id: number; field: string; value: string }): void {
	if (payload.field === "feetage") {
		// Parsed, but never corrected: an out-of-range number is kept and flagged, so a
		// measurement the operator typed cannot silently become zero.
		const parsed = Number.parseFloat(payload.value.replace(/,/g, "").trim());
		void apply([{ id: payload.id, feetage: Number.isFinite(parsed) ? parsed : 0 }]);
	} else if (payload.field === "grade") {
		void apply([{ id: payload.id, grade: payload.value || null }]);
	}
}

/**
 * Fill a grade down, matching the desk form's behaviour so the habit carries over, but
 * announced and reversible rather than silent and permanent.
 */
async function onFillDown(payload: { fromIndex: number; value: string }): Promise<void> {
	if (!doc.value) return;

	const below = doc.value.rows.slice(payload.fromIndex + 1).filter((row) => row.grade !== payload.value);
	if (!below.length) return;

	undo.value = {
		label: `Grade ${payload.value} applied to ${below.length} row(s) below`,
		patches: below.map((row) => ({ id: row.id, grade: row.grade })),
	};
	notice.value = undo.value.label;

	await apply(below.map((row) => ({ id: row.id, grade: payload.value })));
}

async function undoFillDown(): Promise<void> {
	if (!undo.value) return;
	const patches = undo.value.patches;
	undo.value = null;
	notice.value = null;
	await apply(patches);
}

async function setReturnPieces(event: Event): Promise<void> {
	const count = Number((event.target as HTMLInputElement).value || 0);
	error.value = null;
	try {
		await window.qc.checklist.returnPieces(props.localName, count);
		await load();
	} catch (caught) {
		error.value = (caught as Error).message;
	}
}

async function confirmChecklist(): Promise<void> {
	confirming.value = true;
	error.value = null;
	try {
		const result = await window.qc.checklist.confirm(props.localName);
		problems.value = result.problems;
		if (result.ok) notice.value = "Confirmed. Queued for ERPNext.";
		else error.value = `${result.problems.length} row(s) need attention before this can be confirmed.`;
		await load();
	} catch (caught) {
		error.value = (caught as Error).message;
	} finally {
		confirming.value = false;
	}
}

async function updateInwardQty(): Promise<void> {
	if (!doc.value?.inward_no) return;
	error.value = null;
	try {
		const result = await window.qc.inward.updateQty(doc.value.inward_no, doc.value.addless);
		notice.value = `Inward pieces updated to ${result.no_pieces}; total is now ${result.total_qty}.`;
	} catch (caught) {
		// This writes to a submitted document, so it is the one action that genuinely
		// cannot be done offline.
		error.value = `Could not update the GRN: ${(caught as Error).message}`;
	}
}

onMounted(load);
</script>

<template>
	<section v-if="doc" class="page">
		<header class="head">
			<div>
				<h1>{{ doc.local_name }}<span v-if="doc.erp_name"> &rarr; {{ doc.erp_name }}</span></h1>
				<p class="sub">
					{{ doc.inward_no }} &middot; {{ doc.vendor_name ?? doc.vendor }} &middot; {{ doc.date }}
					<span class="state" :class="`state--${doc.state}`">{{ doc.state }}</span>
				</p>
			</div>

			<div class="actions">
				<label class="inline">
					Return pieces
					<input
						type="number"
						min="0"
						:value="doc.return_pieces"
						:disabled="readonly"
						@change="setReturnPieces"
					/>
				</label>
				<label class="inline">
					Add &amp; Less
					<input type="number" v-model.number="doc.addless" :disabled="readonly" />
				</label>
				<button :disabled="readonly || !doc.addless" @click="updateInwardQty">Update GRN qty</button>
				<button class="primary" :disabled="readonly || confirming" @click="confirmChecklist">
					{{ confirming ? "Confirming..." : "Confirm &amp; sync" }}
				</button>
			</div>
		</header>

		<p v-if="notice" class="notice">
			{{ notice }}
			<button v-if="undo" class="link" @click="undoFillDown">Undo</button>
		</p>
		<p v-if="error" class="error">{{ error }}</p>

		<p v-if="store.reference && !store.reference.ratesVisible" class="muted">
			Touch rates are hidden because your account cannot read them. Sizes and pieces are
			unaffected, and ERPNext still prices the checklist on submit.
		</p>

		<div class="body">
			<QcGrid
				:rows="doc.rows"
				:grades="store.reference?.grades ?? []"
				:rates-visible="store.reference?.ratesVisible ?? false"
				:readonly="readonly"
				:problem-rows="problemRows"
				@commit="onCommit"
				@fill-down="onFillDown"
			/>

			<aside class="side">
                <h2>Summary</h2>
				<table>
					<thead>
						<tr>
							<th>Grade</th>
							<th>Skin</th>
							<th>Size</th>
							<th class="num">Pcs</th>
							<th class="num">Feet</th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="(group, index) in summary" :key="index">
							<td>{{ group.grade }}</td>
							<td>{{ group.skin_type }}</td>
							<td>{{ group.size }}</td>
							<td class="num">{{ group.no_pieces }}</td>
							<td class="num">{{ group.feetage.toFixed(2) }}</td>
						</tr>
					</tbody>
				</table>

				<p v-if="store.reference?.ratesVisible" class="total">
					Grand total <strong>{{ total.toFixed(2) }}</strong>
				</p>

				<template v-if="problems.length">
					<h2>Before confirming</h2>
					<ul class="problems">
						<li v-for="(problem, index) in problems.slice(0, 25)" :key="index">{{ problem.message }}</li>
					</ul>
					<p v-if="problems.length > 25" class="muted">and {{ problems.length - 25 }} more</p>
				</template>
			</aside>
		</div>
	</section>
</template>

<style scoped>
.page {
	display: flex;
	flex-direction: column;
	min-height: 0;
	flex: 1;
	gap: 0.6rem;
}

.head {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 1rem;
}

h1 {
	margin: 0;
	font-size: 1.05rem;
}

.sub {
	margin: 0.15rem 0 0;
	color: var(--muted);
	font-size: 0.85rem;
}

.state {
	margin-left: 0.5rem;
	padding: 0.05rem 0.45rem;
	border: 1px solid var(--line);
	border-radius: 999px;
	font-size: 0.72rem;
	text-transform: uppercase;
}

.state--confirmed {
	border-color: var(--good);
	color: var(--good);
}

.state--failed {
	border-color: var(--bad);
	color: var(--bad);
}

.actions {
	display: flex;
	align-items: flex-end;
	gap: 0.5rem;
}

.inline {
	display: flex;
	flex-direction: column;
	gap: 0.15rem;
	font-size: 0.75rem;
	color: var(--muted);
}

.inline input {
	width: 6rem;
}

.body {
	flex: 1;
	min-height: 0;
	display: grid;
	grid-template-columns: 1fr 22rem;
	gap: 0.6rem;
}

.side {
	overflow-y: auto;
	padding: 0.6rem 0.75rem;
	border: 1px solid var(--line);
	border-radius: 6px;
	background: var(--surface);
}

.side h2 {
	margin: 0 0 0.4rem;
	font-size: 0.8rem;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: var(--muted);
}

.num {
	text-align: right;
}

.total {
	margin: 0.6rem 0 0;
	padding-top: 0.5rem;
	border-top: 1px solid var(--line);
	display: flex;
	justify-content: space-between;
}

.problems {
	margin: 0;
	padding-left: 1rem;
	color: var(--bad);
	font-size: 0.82rem;
}

.notice {
	margin: 0;
	padding: 0.4rem 0.6rem;
	border: 1px solid var(--line);
	border-radius: 5px;
	background: var(--surface);
}

.error {
	margin: 0;
	padding: 0.4rem 0.6rem;
	border: 1px solid var(--bad);
	border-radius: 5px;
	color: var(--bad);
}

.muted {
	margin: 0;
	color: var(--muted);
	font-size: 0.82rem;
}

.link {
	margin-left: 0.5rem;
	padding: 0;
	border: none;
	background: none;
	color: var(--accent);
	text-decoration: underline;
}
</style>
