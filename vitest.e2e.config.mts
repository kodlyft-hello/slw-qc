import { defineConfig } from "vitest/config";

// End-to-end against a running bench. Opt-in: `SLWQC_E2E=1 npm run test:e2e`.
export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/e2e/**/*.test.ts"],
		pool: "forks",
		// One live document flows through several tests in order, so they must not be
		// reordered or run concurrently.
		sequence: { shuffle: false, concurrent: false },
		testTimeout: 180_000,
		hookTimeout: 120_000,
	},
});
