<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";

import { useSession } from "../stores/session";

const store = useSession();
const router = useRouter();

const baseUrl = ref(localStorage.getItem("slwqc.baseUrl") ?? "https://slw.com");
const username = ref("");
const password = ref("");
const busy = ref(false);
const error = ref<string | null>(null);

onMounted(async () => {
	// A station already holding a valid key pair goes straight to work.
	if (await window.qc.auth.session()) await router.push({ name: "grns" });
});

async function submit(): Promise<void> {
	busy.value = true;
	error.value = null;
	try {
		await store.signIn(baseUrl.value.trim(), username.value.trim(), password.value);
		// Only the site address is remembered. The password is never stored here; the
		// main process keeps a bcrypt hash for offline sign-in and nothing else.
		localStorage.setItem("slwqc.baseUrl", baseUrl.value.trim());
		await router.push({ name: "grns" });
	} catch (caught) {
		error.value = (caught as Error).message;
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<form class="login" @submit.prevent="submit">
		<h1>SLW QC Station</h1>
		<p class="lead">Sign in with your ERP account.</p>

		<label>Site<input v-model="baseUrl" required autocomplete="url" /></label>
		<label>User<input v-model="username" required autocomplete="username" v-focus /></label>
		<label>Password<input v-model="password" type="password" required autocomplete="current-password" /></label>

		<p v-if="error" class="error">{{ error }}</p>

		<button class="primary" type="submit" :disabled="busy">{{ busy ? "Signing in..." : "Sign in" }}</button>

		<p class="hint">
			After the first sign-in on this station you can sign in again without a network
			connection. Measuring never needs the server; only syncing does.
		</p>
	</form>
</template>

<style scoped>
.login {
	width: min(24rem, 100%);
	margin: auto;
	display: flex;
	flex-direction: column;
	gap: 0.7rem;
}

h1 {
	margin: 0;
	font-size: 1.3rem;
}

.lead {
	margin: 0;
	color: var(--muted);
}

label {
	display: flex;
	flex-direction: column;
	gap: 0.25rem;
	font-size: 0.8rem;
	color: var(--muted);
}

.error {
	margin: 0;
	padding: 0.5rem 0.6rem;
	border: 1px solid var(--bad);
	border-radius: 5px;
	color: var(--bad);
}

.hint {
	margin: 0;
	font-size: 0.78rem;
	color: var(--muted);
}
</style>
