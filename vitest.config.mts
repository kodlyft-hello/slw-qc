import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		// The e2e suite needs a running bench and is opt-in via SLWQC_E2E=1.
		include: ["tests/**/*.test.ts", "electron/**/*.test.ts"],
		exclude: ["**/node_modules/**", "tests/e2e/**"],
		// Forked processes rather than worker threads: better-sqlite3 is a native addon,
		// and native finalisers and worker-thread teardown are a bad combination.
		pool: "forks",
	},
});
