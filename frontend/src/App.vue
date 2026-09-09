<script setup lang="ts">
import { onMounted, onBeforeUnmount } from "vue";
import { RouterLink, RouterView, useRouter } from "vue-router";

import { useSession } from "./stores/session";

const store = useSession();
const router = useRouter();

let poll: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
	await store.restore();
	await store.refreshStatus();
	poll = setInterval(() => void store.refreshStatus(), 5000);
});

onBeforeUnmount(() => {
	if (poll) clearInterval(poll);
});

async function signOut(): Promise<void> {
	await store.signOut();
	await router.push({ name: "login" });
}
</script>

<template>
	<header v-if="store.session" class="bar">
		<strong>SLW QC</strong>
		<nav>
			<RouterLink :to="{ name: 'grns' }">GRNs</RouterLink>
			<RouterLink :to="{ name: 'queue' }">
				Queue
				<span v-if="store.status?.queue.failed" class="pill pill--bad">{{ store.status.queue.failed }}</span>
				<span v-else-if="store.status?.queue.queued" class="pill">{{ store.status.queue.queued }}</span>
			</RouterLink>
		</nav>
		<span class="spacer" />
		<span class="who">{{ store.session.fullName }}</span>
		<span class="dot" :class="store.status?.online ? 'dot--on' : 'dot--off'" />
		<span class="net">{{ store.status?.online ? "Online" : "Offline" }}</span>
		<button @click="signOut">Sign out</button>
	</header>

	<main>
		<RouterView />
	</main>
</template>

<style scoped>
.bar {
	display: flex;
	align-items: center;
	gap: 0.75rem;
	padding: 0.5rem 0.9rem;
	border-bottom: 1px solid var(--line);
	background: var(--surface-2);
}

nav {
	display: flex;
	gap: 0.5rem;
}

nav a {
	padding: 0.25rem 0.6rem;
	border-radius: 5px;
	color: var(--muted);
	text-decoration: none;
}

nav a.router-link-active {
	background: var(--surface);
	color: var(--text);
}

.spacer {
	flex: 1;
}

.who {
	color: var(--muted);
}

.dot {
	width: 8px;
	height: 8px;
	border-radius: 50%;
}

.dot--on {
	background: var(--good);
}

.dot--off {
	background: var(--bad);
}

.net {
	font-size: 0.8rem;
	color: var(--muted);
}

.pill {
	display: inline-block;
	min-width: 1.2rem;
	padding: 0 0.3rem;
	border-radius: 999px;
	background: var(--accent);
	color: #04212f;
	font-size: 0.7rem;
	text-align: center;
}

.pill--bad {
	background: var(--bad);
	color: #2b0d0d;
}

main {
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
	padding: 0.9rem;
}
</style>
