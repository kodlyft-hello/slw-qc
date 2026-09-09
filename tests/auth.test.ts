/**
 * Offline sign-in and credential storage.
 *
 * A QC station sits on a factory floor and is physically reachable, so the two things
 * worth proving are that a cached hash cannot be guessed at unlimited speed and that
 * the API secret is never written to disk in readable form.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { sql, type Db } from "../electron/db/connection";
import { closeTestDb, openTestDb, resetTestDb } from "./helpers/testDb";
import { AuthError, hasQcRole, listKnownOperators, loginOffline, rememberOperator } from "../electron/auth/localAuth";
import {
	clearConfig,
	loadConfig,
	saveConfig,
	type Encryptor,
	type StationConfig,
} from "../electron/config/secureConfig";

let db: Db;
let dir: string;

/** Stand-in for Electron safeStorage: reversible, but not readable at a glance. */
function fakeEncryptor(available = true): Encryptor {
	return {
		available: () => available,
		encrypt: (value) => Buffer.from(value.split("").reverse().join(""), "utf8"),
		decrypt: (value) => value.toString("utf8").split("").reverse().join(""),
	};
}

beforeAll(() => {
	db = openTestDb("auth");
});

afterAll(() => {
	closeTestDb();
});

beforeEach(() => {
	resetTestDb(db);
	// The config tests write real files, so they get their own scratch directory.
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "slwqc-cfg-"));
});

describe("offline sign-in", () => {
	it("lets a remembered operator back in with the right password", async () => {
		await rememberOperator(db, "qc@slw.test", "hunter2", "QC Operator", ["Stock Manager"]);
		const session = await loginOffline(db, "qc@slw.test", "hunter2");
		expect(session).toMatchObject({ user: "qc@slw.test", fullName: "QC Operator", offline: true });
	});

	it("refuses an operator this station has never seen", async () => {
		await expect(loginOffline(db, "stranger@slw.test", "x")).rejects.toThrow(AuthError);
	});

	it("does not reveal whether the username exists", async () => {
		await rememberOperator(db, "qc@slw.test", "hunter2", "QC", ["Stock Manager"]);
		const wrongPassword = await loginOffline(db, "qc@slw.test", "nope").catch((e: Error) => e.message);
		expect(wrongPassword).toBe("Unknown operator or wrong password.");
	});

	it("locks the account after five wrong passwords", async () => {
		await rememberOperator(db, "qc@slw.test", "hunter2", "QC", ["Stock Manager"]);
		for (let attempt = 0; attempt < 5; attempt++) {
			await expect(loginOffline(db, "qc@slw.test", "wrong")).rejects.toThrow();
		}
		// Even the correct password is refused while the lock stands.
		await expect(loginOffline(db, "qc@slw.test", "hunter2")).rejects.toThrow(/Locked after too many attempts/);
	});

	it("clears the failure count on a good password", async () => {
		await rememberOperator(db, "qc@slw.test", "hunter2", "QC", ["Stock Manager"]);
		await expect(loginOffline(db, "qc@slw.test", "wrong")).rejects.toThrow();
		await loginOffline(db, "qc@slw.test", "hunter2");
		const row = sql(db, "SELECT failed_attempts FROM operators WHERE username = ?").get("qc@slw.test") as {
			failed_attempts: number;
		};
		expect(row.failed_attempts).toBe(0);
	});

	it("refuses an operator whose roles no longer permit QC", async () => {
		await rememberOperator(db, "ex@slw.test", "pw", "Ex Operator", ["Sales User"]);
		await expect(loginOffline(db, "ex@slw.test", "pw")).rejects.toThrow(/no role permitted/);
	});

	it("stores the password only as a hash", async () => {
		await rememberOperator(db, "qc@slw.test", "hunter2", "QC", ["Stock Manager"]);
		const row = sql(db, "SELECT password_hash FROM operators WHERE username = ?").get("qc@slw.test") as {
			password_hash: string;
		};
		expect(row.password_hash).not.toContain("hunter2");
		expect(row.password_hash.startsWith("$2")).toBe(true);
	});

	it("updates roles on a later sign-in without losing the account", async () => {
		await rememberOperator(db, "qc@slw.test", "pw", "QC", ["Stock Manager"]);
		await rememberOperator(db, "qc@slw.test", "pw", "QC Renamed", ["Purchase Manager"]);
		expect(listKnownOperators(db)).toHaveLength(1);
		expect((await loginOffline(db, "qc@slw.test", "pw")).roles).toEqual(["Purchase Manager"]);
	});

	it("recognises every role the server permits", () => {
		expect(hasQcRole(["Stock Manager"])).toBe(true);
		expect(hasQcRole(["Sales User"])).toBe(false);
	});
});

describe("credential storage", () => {
	const config: StationConfig = {
		baseUrl: "https://slw.com",
		user: "qc@slw.test",
		fullName: "QC Operator",
		apiKey: "abc123",
		apiSecret: "s3cr3t-value",
		roles: ["Stock Manager"],
	};

	it("never writes the secret in readable form", () => {
		const file = path.join(dir, "station.json");
		saveConfig(file, config, fakeEncryptor());

		const raw = fs.readFileSync(file, "utf8");
		expect(raw).not.toContain("s3cr3t-value");
		expect(raw).toContain("enc:v1:");
		// The API key is an identifier, not a secret, and stays readable for support.
		expect(raw).toContain("abc123");
	});

	it("round-trips the secret", () => {
		const file = path.join(dir, "station.json");
		saveConfig(file, config, fakeEncryptor());
		expect(loadConfig(file, fakeEncryptor())).toEqual(config);
	});

	it("writes the file readable only by its owner", () => {
		const file = path.join(dir, "station.json");
		saveConfig(file, config, fakeEncryptor());
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	});

	it("refuses to write rather than storing a secret in the clear", () => {
		// A station that quietly downgrades is worse than one that will not start:
		// nobody finds out until the credential has already leaked.
		expect(() => saveConfig(path.join(dir, "station.json"), config, fakeEncryptor(false))).toThrow(
			/Refusing to write it in the clear/
		);
	});

	it("treats an undecryptable secret as not signed in", () => {
		const file = path.join(dir, "station.json");
		saveConfig(file, config, fakeEncryptor());
		// What a config copied to another machine or user account looks like.
		const broken: Encryptor = {
			available: () => true,
			encrypt: () => Buffer.from(""),
			decrypt: () => {
				throw new Error("decryption failed");
			},
		};
		expect(loadConfig(file, broken)).toBeNull();
	});

	it("reports no config before first sign-in, and after sign-out", () => {
		const file = path.join(dir, "station.json");
		expect(loadConfig(file, fakeEncryptor())).toBeNull();
		saveConfig(file, config, fakeEncryptor());
		clearConfig(file);
		expect(loadConfig(file, fakeEncryptor())).toBeNull();
	});
});
