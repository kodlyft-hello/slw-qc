import { fileURLToPath, URL } from "node:url";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import electron from "vite-plugin-electron/simple";

// Native and Electron-only modules must stay external: bundling them breaks the
// binary resolution better-sqlite3 does at require time.
const nodeExternals = ["electron", "better-sqlite3", "bcryptjs"];

export default defineConfig({
	root: "frontend",
	publicDir: "public",
	resolve: {
		alias: { "@": fileURLToPath(new URL("./frontend/src", import.meta.url)) },
	},
	build: {
		outDir: "../dist",
		emptyOutDir: true,
	},
	plugins: [
		vue(),
		electron({
			main: {
				entry: fileURLToPath(new URL("./electron/main.ts", import.meta.url)),
				vite: {
					build: {
						outDir: "../dist-electron",
						rollupOptions: {
							external: nodeExternals,
							output: { format: "cjs", entryFileNames: "main.js" },
						},
					},
				},
			},
			preload: {
				input: fileURLToPath(new URL("./electron/preload.ts", import.meta.url)),
				vite: {
					build: {
						outDir: "../dist-electron",
						// The preload runs sandboxed, where only CommonJS loads.
						rollupOptions: {
							external: nodeExternals,
							// A sandboxed preload is loaded as CommonJS; an .mjs name would make
							// Electron try to parse it as ESM and fail.
							output: { format: "cjs", entryFileNames: "preload.js" },
						},
					},
				},
			},
		}),
	],
});
