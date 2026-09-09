import { defineStore } from "pinia";
import { ref } from "vue";

import type { ReferenceData, Session, SyncStatus } from "../../../electron/preload";

export const useSession = defineStore("session", () => {
	const session = ref<Session | null>(null);
	const reference = ref<ReferenceData | null>(null);
	const status = ref<SyncStatus | null>(null);
	const error = ref<string | null>(null);

	async function restore(): Promise<void> {
		session.value = await window.qc.auth.session();
		if (session.value) await loadReference();
	}

	async function signIn(baseUrl: string, username: string, password: string): Promise<void> {
		error.value = null;
		session.value = await window.qc.auth.signIn(baseUrl, username, password);
		await loadReference();
	}

	async function signOut(): Promise<void> {
		await window.qc.auth.signOut();
		session.value = null;
		reference.value = null;
	}

	async function loadReference(): Promise<void> {
		reference.value = await window.qc.masters.reference();
	}

	async function refreshStatus(): Promise<void> {
		// Sync only runs once signed in; asking before then throws, and a failed status
		// poll is not worth surfacing to the operator.
		if (!session.value) return;
		try {
			status.value = await window.qc.sync.status();
		} catch {
			status.value = null;
		}
	}

	return { session, reference, status, error, restore, signIn, signOut, loadReference, refreshStatus };
});
