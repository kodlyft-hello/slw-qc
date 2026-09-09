<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";

import { countByStatus, filterInwards, type GrnStatusFilter } from "../composables/grnFilter";
import type { InwardOption } from "../../../electron/preload";

const router = useRouter();

const inwards = ref<InwardOption[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const search = ref("");
const status = ref<GrnStatusFilter>("all");

const counts = computed(() => countByStatus(inwards.value));
const shown = computed(() => filterInwards(inwards.value, { text: search.value, status: status.value }));

async function load(): Promise<void> {
	loading.value = true;
	try {
		inwards.value = await window.qc.masters.inwards();
	} catch (caught) {
		error.value = (caught as Error).message;
	} finally {
		loading.value = false;
	}
}

async function pull(): Promise<void> {
	error.value = null;
	try {
		await window.qc.sync.pull();
		await load();
	} catch (caught) {
		error.value = `Could not reach the server: ${(caught as Error).message}`;
	}
}

async function open(option: InwardOption): Promise<void> {
	error.value = null;

	// Resume rather than explode the GRN twice. The repository refuses a duplicate as
	// well; this just means the operator never has to see that refusal.
	if (option.local_checklist) {
		await router.push({ name: "checklist", params: { localName: option.local_checklist } });
		return;
	}

	try {
		const created = await window.qc.checklist.create(option.name);
		await router.push({ name: "checklist", params: { localName: created.local_name } });
	} catch (caught) {
		error.value = (caught as Error).message;
		// Another station may have finished it since the last pull, so show the truth.
		await load();
	}
}
</script>

<template>
	<section class="page">
		<header class="head">
			<h1>Goods Received</h1>
			<button @click="pull">Pull now</button>
		</header>

		<div class="filters">
			<input
				v-model="search"
				class="search"
				type="search"
				placeholder="Search GRN, vendor, reference or date"
				autocomplete="off"
				v-focus
			/>

			<div class="tabs">
				<button :class="{ on: status === 'all' }" @click="status = 'all'">
					All <span class="count">{{ counts.all }}</span>
				</button>
				<button :class="{ on: status === 'available' }" @click="status = 'available'">
					Not started <span class="count">{{ counts.available }}</span>
				</button>
				<button :class="{ on: status === 'started' }" @click="status = 'started'">
					In progress <span class="count">{{ counts.started }}</span>
				</button>
			</div>
		</div>

		<p v-if="error" class="error">{{ error }}</p>
		<p v-if="loading">Loading...</p>

		<p v-else-if="!inwards.length" class="muted">
			No open GRNs on this station. Pull to fetch the latest from ERPNext.
		</p>

		<p v-else-if="!shown.length" class="muted">
			Nothing matches that search. <button class="link" @click="search = ''; status = 'all'">Clear</button>
		</p>

		<table v-else>
			<thead>
				<tr>
					<th>GRN</th>
					<th>Vendor</th>
					<th>Reference</th>
					<th>Date</th>
					<th class="num">Pieces</th>
					<th>Status</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				<tr v-for="option in shown" :key="option.name">
					<td>{{ option.name }}</td>
					<td>{{ option.vendor_name ?? option.vendor }}</td>
					<td class="muted-cell">{{ option.reference_no }}</td>
					<td>{{ option.date }}</td>
					<td class="num">{{ option.total_qty }}</td>
					<td>
						<span v-if="option.local_checklist" class="tag" :class="`tag--${option.local_state}`">
							{{ option.local_checklist }} &middot; {{ option.local_state }}
						</span>
						<span v-else class="muted-cell">{{ option.status }}</span>
					</td>
					<td class="right">
						<button :class="{ primary: !option.local_checklist }" @click="open(option)">
							{{ option.local_checklist ? "Open" : "Start QC" }}
						</button>
					</td>
				</tr>
			</tbody>
		</table>
	</section>
</template>

<style scoped>
.page {
	display: flex;
	flex-direction: column;
	min-height: 0;
	gap: 0.6rem;
}

.head {
	display: flex;
	align-items: center;
	justify-content: space-between;
}

h1 {
	margin: 0;
	font-size: 1.1rem;
}

.filters {
	display: flex;
	gap: 0.6rem;
	align-items: center;
	flex-wrap: wrap;
}

.search {
	flex: 1;
	min-width: 16rem;
}

.tabs {
	display: flex;
	gap: 0.25rem;
}

.tabs button {
	padding: 0.35rem 0.7rem;
	color: var(--muted);
}

.tabs button.on {
	background: var(--surface-2);
	border-color: var(--accent);
	color: var(--text);
}

.count {
	display: inline-block;
	margin-left: 0.25rem;
	padding: 0 0.35rem;
	border-radius: 999px;
	background: var(--surface-2);
	font-size: 0.72rem;
}

.tabs button.on .count {
	background: var(--bg);
}

.num {
	text-align: right;
}

.right {
	text-align: right;
}

.tag {
	padding: 0.1rem 0.45rem;
	border: 1px solid var(--line);
	border-radius: 999px;
	font-size: 0.75rem;
	color: var(--muted);
	white-space: nowrap;
}

.tag--confirmed {
	border-color: var(--good);
	color: var(--good);
}

.tag--queued,
.tag--sent {
	border-color: var(--accent);
	color: var(--accent);
}

.muted,
.muted-cell {
	color: var(--muted);
}

.error {
	margin: 0;
	padding: 0.4rem 0.6rem;
	border: 1px solid var(--bad);
	border-radius: 5px;
	color: var(--bad);
}

.link {
	padding: 0;
	border: none;
	background: none;
	color: var(--accent);
	text-decoration: underline;
}
</style>
