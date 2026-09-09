/**
 * Main process: opens the station database, restores the saved session, wires IPC and
 * starts the sync loop.
 */
import path from "node:path";

import { app, BrowserWindow } from "electron";

import schemaSql from "./db/schema.sql?raw";
import { closeDatabase, openDatabase, type Db } from "./db/connection";
import { clearConfig, electronEncryptor, loadConfig, saveConfig, type StationConfig } from "./config/secureConfig";
import { hasQcRole, loginOffline, rememberOperator, type Session } from "./auth/localAuth";
import { ErpNetworkError, ErpnextClient, loginForKeys } from "./sync/erpnext";
import { SyncEngine } from "./sync/engine";
import { registerIpc } from "./ipc";

let window: BrowserWindow | null = null;
let db: Db | null = null;
let client: ErpnextClient | null = null;
let engine: SyncEngine | null = null;
let session: Session | null = null;

const configPath = () => path.join(app.getPath("userData"), "station.json");
const databasePath = () => path.join(app.getPath("userData"), "qc.db");

function ensureClient(config: StationConfig): ErpnextClient {
	if (client) client.setConfig(config);
	else client = new ErpnextClient(config);
	return client;
}

function startEngine(): void {
	if (!db || !client) return;
	engine?.stop();
	engine = new SyncEngine({
		db,
		client,
		onAuthError: () => {
			// The stored key pair no longer works. Drop it so the operator is asked to sign
			// in again rather than watching every tick fail for reasons nobody can see.
			signOut();
			window?.webContents.send("session:expired");
		},
	});
	engine.start();
}

/**
 * Sign in, preferring the server and falling back to the cached hash.
 *
 * Offline is a first-class path, not an error case: measuring hides does not need the
 * network, only pushing does, so a station must keep working through an outage.
 */
async function signIn(baseUrl: string, username: string, password: string): Promise<Session> {
	if (!db) throw new Error("Station database is not open.");

	try {
		const bootstrap = await loginForKeys(baseUrl, username, password);

		if (!hasQcRole(bootstrap.roles)) {
			throw new Error(`${bootstrap.user} holds no role permitted to use QC Check List.`);
		}

		const config: StationConfig = {
			baseUrl,
			user: bootstrap.user,
			fullName: bootstrap.full_name,
			apiKey: bootstrap.api_key,
			apiSecret: bootstrap.api_secret,
			roles: bootstrap.roles,
		};
		saveConfig(configPath(), config, electronEncryptor());
		await rememberOperator(db, bootstrap.user, password, bootstrap.full_name, bootstrap.roles);

		ensureClient(config);
		startEngine();

		session = { user: bootstrap.user, fullName: bootstrap.full_name, roles: bootstrap.roles, offline: false };
		return session;
	} catch (error) {
		// Only a transport failure justifies the offline path. A rejected password must
		// stay rejected, or a wrong password would "work" whenever the network is down.
		if (!(error instanceof ErpNetworkError)) throw error;

		session = await loginOffline(db, username, password);

		const stored = loadConfig(configPath(), electronEncryptor());
		if (stored && stored.user === session.user) {
			ensureClient(stored);
			startEngine();
		}
		return session;
	}
}

function signOut(): void {
	engine?.stop();
	engine = null;
	session = null;
	clearConfig(configPath());
}

function createWindow(): void {
	window = new BrowserWindow({
		width: 1400,
		height: 900,
		show: false,
		backgroundColor: "#0f172a",
		// Taskbar and window icon. The .exe icon comes from electron-builder; this is what
		// the running app shows, including in development.
		icon: path.join(__dirname, "../build/icon.png"),
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			spellcheck: false,
		},
	});

	window.once("ready-to-show", () => window?.show());

	const devServer = process.env.VITE_DEV_SERVER_URL;
	if (devServer) void window.loadURL(devServer);
	else void window.loadFile(path.join(__dirname, "../dist/index.html"));

	window.on("closed", () => {
		window = null;
	});
}

app.whenReady().then(() => {
	db = openDatabase(databasePath(), schemaSql);

	// A station that was signed in stays signed in across restarts: the key pair is in
	// the OS keychain, so a shift can resume without the operator finding a password.
	const stored = loadConfig(configPath(), electronEncryptor());
	if (stored) {
		ensureClient(stored);
		session = { user: stored.user, fullName: stored.fullName, roles: stored.roles, offline: true };
		startEngine();
	}

	registerIpc({
		db: () => {
			if (!db) throw new Error("Station database is not open.");
			return db;
		},
		client: () => {
			if (!client) throw new Error("Not signed in.");
			return client;
		},
		engine: () => {
			if (!engine) throw new Error("Sync is not running. Sign in first.");
			return engine;
		},
		session: () => session,
		signIn,
		signOut,
		baseUrl: () => loadConfig(configPath(), electronEncryptor())?.baseUrl ?? null,
	});

	createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
	engine?.stop();
	closeDatabase();
});
