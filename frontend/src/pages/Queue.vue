<script setup lang="ts">
import { onMounted, ref } from "vue";

import type { OutboxRow } from "../../../electron/preload";

const rows = ref<OutboxRow[]>([]);
const error = ref<string | null>(null);

async function load(): Promise<void> {
	rows.value = await window.qc.queue.list();
}

async function retry(offlineUuid: string): Promise<void> {
	error.value = null;
	await window.qc.queue.retry(offlineUuid);
	try {
		await window.qc.sync.push();
	} catch (caught) {
		error.value = (caught as Error).message;
	}
	await load();
}

async function pushAll(): Promise<void> {
	error.value = null;
	try {
		await window.qc.sync.push();
	} catch (caught) {
		error.value = (caught as Error).message;
	}
	await load();
}

onMounted(load);
</script>

<template>
	<section>
		<header class="head">
			<h1>Sync queue</h1>
			<button @click="pushAll">Push now</button>
		</header>

		<p v-if="error" class="error">{{ error }}</p>
		<p v-if="!rows.length" class="muted">Nothing waiting. Every confirmed checklist has reached ERPNext.</p>

		<table v-else>
			<thead>
				<tr>
					<th>Checklist</th>
					<th>State</th>
					<th>Attempts</th>
					<th>ERPNext</th>
					<th>Last error</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				<tr v-for="row in rows" :key="row.offline_uuid">
					<td>{{ row.local_name }}</td>
					<td><span class="state" :class="`state--${row.state}`">{{ row.state }}</span></td>
					<td>{{ row.attempts }}</td>
					<td>{{ row.erp_name ?? "-" }}</td>
					<td class="err">{{ row.last_error ?? "" }}</td>
					<td class="right">
						<button v-if="row.state !== 'confirmed'" @click="retry(row.offline_uuid)">Retry</button>
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

.state {
	padding: 0.05rem 0.45rem;
	border: 1px solid var(--line);
	border-radius: 999px;
	font-size: 0.72rem;
}

.state--confirmed {
	border-color: var(--good);
	color: var(--good);
}

.state--failed {
	border-color: var(--bad);
	color: var(--bad);
}

.err {
	max-width: 24rem;
	color: var(--bad);
	font-size: 0.8rem;
}

.right {
	text-align: right;
}

.muted {
	color: var(--muted);
}

.error {
	color: var(--bad);
}
</style>
