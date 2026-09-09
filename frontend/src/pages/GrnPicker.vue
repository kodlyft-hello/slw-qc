<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";

import type { InwardOption } from "../../../electron/preload";

const router = useRouter();

const inwards = ref<InwardOption[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

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
	// Resume the existing draft rather than exploding the GRN a second time.
	const localName =
		option.local_checklist ?? (await window.qc.checklist.create(option.name)).local_name;
	await router.push({ name: "checklist", params: { localName } });
}

onMounted(load);
</script>

<template>
	<section>
		<header class="head">
			<h1>Goods Received</h1>
			<button @click="pull">Pull now</button>
		</header>

		<p v-if="error" class="error">{{ error }}</p>
		<p v-if="loading">Loading...</p>

		<p v-else-if="!inwards.length" class="empty">
			No open GRNs on this station. Pull to fetch the latest from ERPNext.
		</p>

		<table v-else>
			<thead>
				<tr>
					<th>GRN</th>
					<th>Vendor</th>
					<th>Date</th>
					<th>Pieces</th>
					<th>Status</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				<tr v-for="option in inwards" :key="option.name">
					<td>{{ option.name }}</td>
					<td>{{ option.vendor_name ?? option.vendor }}</td>
					<td>{{ option.date }}</td>
					<td>{{ option.total_qty }}</td>
					<td>
						<span v-if="option.local_checklist" class="tag">{{ option.local_state }} locally</span>
						<span v-else>{{ option.status }}</span>
					</td>
					<td class="right">
						<button @click="open(option)">
							{{ option.local_checklist ? "Resume" : "Start QC" }}
						</button>
					</td>
				</tr>
			</tbody>
		</table>
	</section>
</template>

<style scoped>
.head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	margin-bottom: 0.6rem;
}

h1 {
	margin: 0;
	font-size: 1.1rem;
}

.right {
	text-align: right;
}

.tag {
	padding: 0.1rem 0.4rem;
	border: 1px solid var(--line);
	border-radius: 999px;
	font-size: 0.75rem;
	color: var(--muted);
}

.empty,
.error {
	color: var(--muted);
}

.error {
	color: var(--bad);
}
</style>
