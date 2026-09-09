<script setup lang="ts">
/**
 * The measuring grid.
 *
 * This is the component the whole application exists for, so the three rules that fix
 * the original complaint are worth stating plainly:
 *
 *   1. Nothing here awaits. A committed feetage resolves its size and rate from
 *      in-memory indexes held by the main process and repaints one row. There is no
 *      per-keystroke round trip, so typing speed is bounded by the operator, not the
 *      network.
 *   2. A value the operator typed is never rewritten. An out-of-range feetage is marked
 *      in red and reported at confirm time; it is never reset to zero, which is what the
 *      desk form does and what makes measurements appear to vanish.
 *   3. Focus is never moved except by a key the operator pressed. There are no deferred
 *      re-focus timers, so a keystroke can never land in a cell they did not choose.
 *
 * Only the visible slice of rows is rendered, so a GRN of 2,000 hides costs what 40 do.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { nextPosition, type GridPosition } from "../composables/gridNavigation";
import { computeWindow, scrollToRow } from "../composables/virtualRows";
import type { DetailRow } from "../../../electron/preload";

const props = defineProps<{
	rows: DetailRow[];
	grades: string[];
	ratesVisible: boolean;
	readonly: boolean;
	problemRows: Set<number>;
}>();

const emit = defineEmits<{
	(event: "commit", payload: { id: number; field: "grade" | "feetage" | "status"; value: string }): void;
	(event: "fill-down", payload: { fromIndex: number; field: "grade"; value: string }): void;
}>();

const ROW_HEIGHT = 34;

const viewport = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(600);
const active = ref<GridPosition>({ row: 0, column: "feetage" });
/** The raw string being typed. Committed on blur, Enter or navigation. */
const editing = ref<{ id: number; field: string; text: string } | null>(null);

const columns = computed(() => (props.readonly ? [] : ["grade", "feetage"]));

const window_ = computed(() =>
	computeWindow({
		scrollTop: scrollTop.value,
		viewportHeight: viewportHeight.value,
		rowHeight: ROW_HEIGHT,
		rowCount: props.rows.length,
	})
);

const visible = computed(() =>
	props.rows.slice(window_.value.start, window_.value.end).map((row, offset) => ({
		row,
		index: window_.value.start + offset,
	}))
);

const measured = computed(() => props.rows.filter((row) => Number(row.feetage) > 0).length);

function onScroll(event: Event): void {
	scrollTop.value = (event.target as HTMLElement).scrollTop;
}

function cellValue(row: DetailRow, field: string): string {
	if (editing.value && editing.value.id === row.id && editing.value.field === field) {
		return editing.value.text;
	}
	if (field === "feetage") return row.feetage ? String(row.feetage) : "";
	if (field === "grade") return row.grade ?? "";
	return "";
}

function beginEdit(row: DetailRow, field: string, initial?: string): void {
	editing.value = { id: row.id, field, text: initial ?? cellValue(row, field) };
}

/** Push the typed value down to the parent. Never rewrites what was typed. */
function commit(): void {
	const pending = editing.value;
	editing.value = null;
	if (!pending) return;

	const row = props.rows.find((candidate) => candidate.id === pending.id);
	if (!row) return;

	const current = pending.field === "feetage" ? (row.feetage ? String(row.feetage) : "") : (row.grade ?? "");
	if (pending.text === current) return;

	emit("commit", { id: pending.id, field: pending.field as "grade" | "feetage", value: pending.text });
}

async function focusCell(position: GridPosition): Promise<void> {
	active.value = position;

	const offset = scrollToRow(position.row, {
		scrollTop: scrollTop.value,
		viewportHeight: viewportHeight.value,
		rowHeight: ROW_HEIGHT,
	});
	if (offset !== null && viewport.value) viewport.value.scrollTop = offset;

	await nextTick();
	const selector = `[data-row="${position.row}"] [data-cell="${position.column}"] input`;
	const input = viewport.value?.querySelector<HTMLInputElement>(selector);
	input?.focus();
	input?.select();
}

function onKeydown(event: KeyboardEvent, rowIndex: number, column: string): void {
	const input = event.target as HTMLInputElement;

	const result = nextPosition(event.key, { row: rowIndex, column }, {
		columns: columns.value,
		rowCount: props.rows.length,
		atStart: input.selectionStart === 0 && input.selectionEnd === 0,
		atEnd: input.selectionStart === input.value.length && input.selectionEnd === input.value.length,
	});

	if (result.kind === "none") return;

	event.preventDefault();
	commit();

	if (result.kind === "move") void focusCell(result.to);
}

function onFocus(rowIndex: number, column: string, row: DetailRow): void {
	active.value = { row: rowIndex, column };
	beginEdit(row, column);
}

/**
 * Fill a grade down every row below, matching the desk form so muscle memory carries
 * over. Unlike the desk form it is announced and undoable, because silently rewriting
 * hundreds of rows is not something to do without telling anyone.
 */
function fillDown(rowIndex: number, value: string): void {
	if (!value) return;
	emit("fill-down", { fromIndex: rowIndex, field: "grade", value });
}

// The window size depends on how tall the viewport actually is, so measure it rather
// than assuming: a wrong height either renders too few rows (blank gaps on scroll) or
// far too many (the cost this component exists to avoid).
let observer: ResizeObserver | null = null;

onMounted(() => {
	if (!viewport.value) return;
	viewportHeight.value = viewport.value.clientHeight;
	observer = new ResizeObserver(([entry]) => {
		if (entry) viewportHeight.value = entry.contentRect.height;
	});
	observer.observe(viewport.value);
});

onBeforeUnmount(() => observer?.disconnect());

watch(
	() => props.rows.length,
	() => {
		if (active.value.row >= props.rows.length) {
			active.value = { row: Math.max(0, props.rows.length - 1), column: active.value.column };
		}
	}
);

defineExpose({ focusCell });
</script>

<template>
	<div class="grid" :class="{ 'grid--no-rates': !ratesVisible }">
		<div class="grid__head">
			<span class="col col--idx">#</span>
			<span class="col col--item">Item</span>
			<span class="col col--skin">Skin Type</span>
			<span class="col col--grade">Grade</span>
			<span class="col col--feet">Feetage</span>
			<span class="col col--size">Size</span>
			<span v-if="ratesVisible" class="col col--rate">Rate</span>
			<span v-if="ratesVisible" class="col col--net">Net</span>
		</div>

		<div ref="viewport" class="grid__body" @scroll="onScroll">
			<div :style="{ height: `${window_.paddingTop}px` }" />

			<div
				v-for="entry in visible"
				:key="entry.row.id"
				class="row"
				:class="{ 'row--problem': problemRows.has(entry.row.idx), 'row--done': Number(entry.row.feetage) > 0 }"
				:data-row="entry.index"
				:style="{ height: `${ROW_HEIGHT}px` }"
			>
				<span class="col col--idx">{{ entry.row.idx }}</span>
				<span class="col col--item" :title="entry.row.item_code ?? ''">{{ entry.row.item_code }}</span>
				<span class="col col--skin">{{ entry.row.skin_type }}</span>

				<span class="col col--grade" data-cell="grade">
					<input
						:value="cellValue(entry.row, 'grade')"
						:disabled="readonly"
						list="grade-options"
						spellcheck="false"
						autocomplete="off"
						@focus="onFocus(entry.index, 'grade', entry.row)"
						@input="editing = { id: entry.row.id, field: 'grade', text: ($event.target as HTMLInputElement).value }"
						@blur="commit"
						@keydown="onKeydown($event, entry.index, 'grade')"
						@keydown.ctrl.d.prevent="fillDown(entry.index, cellValue(entry.row, 'grade'))"
					/>
				</span>

				<span class="col col--feet" data-cell="feetage">
					<!--
						type="text" with inputmode="decimal", never type="number": a number
						input silently discards intermediate states and reports an empty value
						for anything it considers invalid, which is exactly how a keystroke
						goes missing.
					-->
					<input
						:value="cellValue(entry.row, 'feetage')"
						:disabled="readonly"
						type="text"
						inputmode="decimal"
						spellcheck="false"
						autocomplete="off"
						:class="{ 'input--bad': problemRows.has(entry.row.idx) }"
						@focus="onFocus(entry.index, 'feetage', entry.row)"
						@input="editing = { id: entry.row.id, field: 'feetage', text: ($event.target as HTMLInputElement).value }"
						@blur="commit"
						@keydown="onKeydown($event, entry.index, 'feetage')"
					/>
				</span>

				<span class="col col--size">{{ entry.row.size }}</span>
				<span v-if="ratesVisible" class="col col--rate">{{ entry.row.rate || "" }}</span>
				<span v-if="ratesVisible" class="col col--net">{{ entry.row.net_amount || "" }}</span>
			</div>

			<div :style="{ height: `${window_.paddingBottom}px` }" />
		</div>

		<datalist id="grade-options">
			<option v-for="grade in grades" :key="grade" :value="grade" />
		</datalist>

		<footer class="grid__foot">
			<span>{{ measured }} of {{ rows.length }} measured</span>
			<span class="hint">Enter or Down moves to the next hide. Ctrl+D fills the grade down.</span>
		</footer>
	</div>
</template>

<style scoped>
.grid {
	display: flex;
	flex-direction: column;
	min-height: 0;
	flex: 1;
	border: 1px solid var(--line);
	border-radius: 6px;
	overflow: hidden;
	background: var(--surface);
}

.grid__head,
.row {
	display: grid;
	/* idx, item, skin, grade, feetage, size, rate, net */
	grid-template-columns: 3.5rem 9rem 6rem 6rem 6rem 8rem 6rem 6rem;
	align-items: center;
	gap: 0.25rem;
	padding: 0 0.5rem;
}

.grid__head {
	height: 34px;
	font-size: 0.75rem;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: var(--muted);
	background: var(--surface-2);
	border-bottom: 1px solid var(--line);
}

/* Rate and Net are withheld from operators without permlevel-1 read on Tounch Rate. */
.grid--no-rates .grid__head,
.grid--no-rates .row {
	grid-template-columns: 3.5rem 9rem 6rem 6rem 6rem 8rem;
}

.grid__body {
	flex: 1;
	overflow-y: auto;
	min-height: 0;
}

.row {
	border-bottom: 1px solid var(--line-soft);
	font-variant-numeric: tabular-nums;
}

.row--done {
	background: var(--done);
}

.row--problem {
	background: var(--bad-bg);
}

.col {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.col--idx {
	color: var(--muted);
	font-size: 0.8rem;
}

.col--feet input,
.col--grade input {
	width: 100%;
	height: 26px;
	padding: 0 0.4rem;
	border: 1px solid transparent;
	border-radius: 4px;
	background: transparent;
	color: inherit;
	font: inherit;
	font-variant-numeric: tabular-nums;
}

.col--feet input:focus,
.col--grade input:focus {
	outline: none;
	border-color: var(--accent);
	background: var(--surface);
}

/* Marked, never rewritten. */
.input--bad {
	border-color: var(--bad) !important;
	color: var(--bad);
}

.grid__foot {
	display: flex;
	justify-content: space-between;
	gap: 1rem;
	padding: 0.4rem 0.75rem;
	border-top: 1px solid var(--line);
	background: var(--surface-2);
	font-size: 0.8rem;
	color: var(--muted);
}

.hint {
	opacity: 0.8;
}
</style>
