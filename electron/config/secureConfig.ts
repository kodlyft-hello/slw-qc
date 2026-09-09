/**
 * Station configuration, with the API secret encrypted at rest.
 *
 * The station holds a Frappe API key pair that can create and submit QC Check Lists as
 * a real user. Writing that to disk in the clear would make every backup, sync folder
 * and support screenshot a credential leak, so it goes through Electron `safeStorage`,
 * which is backed by the OS keychain (DPAPI on Windows).
 *
 * If the OS cannot encrypt, this refuses to write rather than silently downgrading. A
 * station that quietly stores secrets in plain text is worse than one that will not
 * start, because nobody finds out until it matters.
 */
import fs from "node:fs";
import path from "node:path";

const ENC_PREFIX = "enc:v1:";

export interface StationConfig {
	baseUrl: string;
	user: string;
	fullName: string;
	apiKey: string;
	apiSecret: string;
	roles: string[];
}

/** Injected so the config layer can be tested without an Electron runtime. */
export interface Encryptor {
	available(): boolean;
	encrypt(value: string): Buffer;
	decrypt(value: Buffer): string;
}

export function electronEncryptor(): Encryptor {
	// Required lazily: importing electron at module load breaks plain-Node test runs.
	const { safeStorage } = require("electron") as typeof import("electron");
	return {
		available: () => safeStorage.isEncryptionAvailable(),
		encrypt: (value) => safeStorage.encryptString(value),
		decrypt: (value) => safeStorage.decryptString(value),
	};
}

function encrypt(encryptor: Encryptor, value: string): string {
	if (!value) return value;
	if (!encryptor.available()) {
		throw new Error(
			"OS credential storage is unavailable, so the API secret cannot be stored safely. " +
				"Refusing to write it in the clear."
		);
	}
	return ENC_PREFIX + encryptor.encrypt(value).toString("base64");
}

function decrypt(encryptor: Encryptor, value: string): string {
	if (!value?.startsWith(ENC_PREFIX)) return value ?? "";
	return encryptor.decrypt(Buffer.from(value.slice(ENC_PREFIX.length), "base64"));
}

export function saveConfig(filePath: string, config: StationConfig, encryptor: Encryptor): void {
	const onDisk = { ...config, apiSecret: encrypt(encryptor, config.apiSecret) };
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	// 0600: readable only by the account running the station.
	fs.writeFileSync(filePath, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
}

export function loadConfig(filePath: string, encryptor: Encryptor): StationConfig | null {
	if (!fs.existsSync(filePath)) return null;

	const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as StationConfig;
	try {
		return { ...raw, apiSecret: decrypt(encryptor, raw.apiSecret) };
	} catch {
		// A secret encrypted under a different OS user or machine cannot be recovered.
		// Treat it as "not signed in" so the operator is asked again, rather than looping
		// on 401s nobody can explain.
		return null;
	}
}

export function clearConfig(filePath: string): void {
	if (fs.existsSync(filePath)) fs.rmSync(filePath);
}
