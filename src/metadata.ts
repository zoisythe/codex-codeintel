import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { directoryLock, renameWithRetry } from "./directory-lock.js";
import { executionEnvironment } from "./environment.js";
import { hash } from "./files.js";
import { rootSession } from "./hook-events.js";
import type { Finding } from "./results.js";
import { record } from "./results.js";
import { workspaceIdentity } from "./service-identity.js";

export interface SessionState {
	id: string;
	epoch: string;
	outbox: Record<string, string>;
	version: number;
	generation: number;
	configuration: string;
	pendingChannels: { lsp: string[]; lint: string[] };
	automaticScope: "delta" | "full";
	turn: string;
	baseline: string | null;
	diagnosticBaseline: string | null;
	edited: boolean;
	unresolved: Record<string, Finding[]>;
	touched: string[];
	current: string[];
	pending: string[];
	delivery: string[];
	shown: Record<string, string>;
	blocked: string[];
	hookEvents: Record<
		string,
		{ turn: string; state: "queued" | "running" | "complete" | "superseded" | "cancelled" | "failed" }
	>;
	feedback: Record<string, { bytes: number; signatures: string[] }>;
	baselineAttempted: boolean;
	waitEpoch: number;
	interrupts: Record<string, number>;
}
const empty = (id: string): SessionState => ({
	id,
	epoch: hash(`initial:${id}`),
	outbox: {},
	version: 0,
	generation: 0,
	configuration: "",
	pendingChannels: { lsp: [], lint: [] },
	automaticScope: "delta",
	turn: "",
	baseline: null,
	diagnosticBaseline: null,
	edited: false,
	unresolved: {},
	touched: [],
	current: [],
	pending: [],
	delivery: [],
	shown: {},
	blocked: [],
	hookEvents: {},
	feedback: {},
	baselineAttempted: false,
	waitEpoch: 0,
	interrupts: {},
});
export class Metadata {
	constructor(private readonly root: string) {}
	private async dir(): Promise<string> {
		const user = process.getuid?.() ?? hash(homedir()).slice(0, 10);
		const base = join(
			executionEnvironment()["CODEX_LSP_CACHE"] ?? join(tmpdir(), `codex-lsp-${user}`),
			`metadata-v8-${user}`,
		);
		await mkdir(base, { recursive: true, mode: 0o700 });
		const info = await lstat(base);
		if (
			info.isSymbolicLink() ||
			(process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
		)
			throw new Error("Unsafe metadata permissions");
		const dir = join(base, await workspaceIdentity(await realpath(this.root)));
		await mkdir(dir, { recursive: true, mode: 0o700 });
		if ((await lstat(dir)).isSymbolicLink()) throw new Error("Unsafe metadata directory");
		return dir;
	}
	private async load(path: string, id: string): Promise<SessionState> {
		try {
			const data: unknown = JSON.parse(await readFile(path, "utf8"));
			if (
				!record(data) ||
				data["id"] !== id ||
				typeof data["version"] !== "number" ||
				typeof data["turn"] !== "string" ||
				typeof data["generation"] !== "number" ||
				typeof data["configuration"] !== "string" ||
				!record(data["pendingChannels"]) ||
				typeof data["edited"] !== "boolean" ||
				!["delta", "full"].includes(String(data["automaticScope"]))
			)
				throw new Error("Invalid metadata");
			for (const key of ["touched", "current", "pending", "delivery", "blocked"])
				if (!Array.isArray(data[key]) || !data[key].every((item: unknown) => typeof item === "string"))
					throw new Error("Invalid metadata");
			for (const key of ["baseline", "diagnosticBaseline"])
				if (data[key] !== null && (typeof data[key] !== "string" || !/^[a-f0-9]{64}$/.test(String(data[key]))))
					throw new Error("Invalid baseline reference");
			if (
				!record(data["unresolved"]) ||
				!Object.values(data["unresolved"]).every(
					(items) =>
						Array.isArray(items) &&
						items.every(
							(item: unknown) =>
								record(item) &&
								typeof item["path"] === "string" &&
								typeof item["source"] === "string" &&
								typeof item["message"] === "string" &&
								typeof item["line"] === "number" &&
								typeof item["column"] === "number" &&
								["error", "warning", "information", "hint"].includes(String(item["severity"])),
						),
				)
			)
				throw new Error("Invalid unresolved diagnostics");
			for (const key of ["shown"])
				if (
					!(key === "baseline" && data[key] === null) &&
					(!record(data[key]) || !Object.values(data[key]).every((item) => typeof item === "string"))
				)
					throw new Error("Invalid metadata");
			const channels = data["pendingChannels"];
			if (
				!record(channels) ||
				![channels["lsp"], channels["lint"]].every(
					(paths) => Array.isArray(paths) && paths.every((path: unknown) => typeof path === "string"),
				)
			)
				throw new Error("Invalid channel metadata");
			if (
				typeof data["epoch"] !== "string" ||
				!record(data["outbox"]) ||
				!Object.values(data["outbox"]).every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
			)
				throw new Error("Invalid delivery metadata");
			if (!record(data["hookEvents"]) || !record(data["feedback"]) || typeof data["baselineAttempted"] !== "boolean")
				throw new Error("Invalid hook metadata");
			if (
				!Number.isSafeInteger(data["waitEpoch"]) ||
				!record(data["interrupts"]) ||
				!Object.values(data["interrupts"]).every(
					(value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
				)
			)
				throw new Error("Invalid interrupt metadata");
			for (const entry of Object.values(data["hookEvents"]))
				if (
					!record(entry) ||
					typeof entry["turn"] !== "string" ||
					!["queued", "running", "complete", "superseded", "cancelled", "failed"].includes(String(entry["state"]))
				)
					throw new Error("Invalid hook registration state");
			for (const entry of Object.values(data["feedback"]))
				if (
					!record(entry) ||
					typeof entry["bytes"] !== "number" ||
					!Number.isFinite(entry["bytes"]) ||
					entry["bytes"] < 0 ||
					entry["bytes"] > 8192 ||
					!Array.isArray(entry["signatures"]) ||
					!entry["signatures"].every((item: unknown) => typeof item === "string" && /^[a-f0-9]{64}$/.test(item))
				)
					throw new Error("Invalid feedback budget");
			return data as unknown as SessionState;
		} catch (error) {
			if (record(error) && error["code"] === "ENOENT") return empty(id);
			throw error;
		}
	}
	async read(id: string): Promise<SessionState> {
		return this.load(join(await this.dir(), `${hash(id)}.json`), id);
	}
	async ids(): Promise<string[]> {
		const dir = await this.dir();
		const ids: string[] = [];
		for (const file of await readdir(dir))
			if (file.endsWith(".json")) {
				try {
					const value: unknown = JSON.parse(await readFile(join(dir, file), "utf8"));
					if (record(value) && typeof value["id"] === "string" && value["turn"] !== "__ended__")
						ids.push(value["id"]);
				} catch {
					/* Concurrent SessionEnd. */
				}
			}
		return ids.sort();
	}
	async shared(value: unknown): Promise<string> {
		const content = JSON.stringify(value);
		const reference = hash(content);
		const dir = join(await this.dir(), "shared");
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const path = join(dir, `${reference}.json`);
		await writeFile(path, content, { mode: 0o600, flag: "wx" }).catch((error: unknown) => {
			if (!record(error) || error["code"] !== "EEXIST") throw error;
		});
		return reference;
	}
	async readShared(reference: string): Promise<unknown> {
		if (!/^[a-f0-9]{64}$/.test(reference)) throw new Error("Invalid shared reference");
		const content = await readFile(join(await this.dir(), "shared", `${reference}.json`), "utf8");
		if (hash(content) !== reference) throw new Error("Shared snapshot integrity mismatch");
		return JSON.parse(content) as unknown;
	}
	async update(id: string, signal: AbortSignal, change: (state: SessionState) => unknown): Promise<SessionState> {
		signal.throwIfAborted();
		const dir = await this.dir();
		const path = join(dir, `${hash(id)}.json`);
		const lock = `${path}.lock`;
		const nonce = randomUUID();
		const temp = `${path}.${nonce}.tmp`;
		const release = await directoryLock(lock, signal);
		try {
			const state = await this.load(path, id);
			signal.throwIfAborted();
			if ((await change(state)) === false) return state;
			state.version++;
			for (const key of ["touched", "current", "pending", "delivery", "blocked"] as const)
				state[key] = [...new Set(state[key])];
			await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
			await renameWithRetry(temp, path, signal);
			return state;
		} finally {
			try {
				await rm(temp, { force: true });
			} finally {
				await release();
			}
		}
	}
	async end(id: string, signal: AbortSignal): Promise<void> {
		// Retain a versioned tombstone until after competing old requests have failed their CAS.
		await this.update(id, signal, (state) => {
			Object.assign(state, { ...empty(id), version: state.version, generation: state.generation + 1 });
			state.epoch = randomUUID();
			state.turn = "__ended__";
		});
	}
	async start(id: string, signal: AbortSignal): Promise<SessionState> {
		return this.update(id, signal, (state) => {
			Object.assign(state, { ...empty(id), version: state.version, epoch: randomUUID() });
		});
	}
	async actor(id: string, signal: AbortSignal): Promise<SessionState> {
		const parent = await this.read(rootSession(id));
		if (rootSession(id) === id) return parent;
		return this.update(id, signal, (state) => {
			if (state.epoch === parent.epoch) return false;
			Object.assign(state, {
				...empty(id),
				version: state.version,
				epoch: parent.epoch,
				baseline: parent.baseline,
				diagnosticBaseline: parent.diagnosticBaseline,
				baselineAttempted: parent.baselineAttempted,
				edited: parent.edited,
				configuration: parent.configuration,
				shown: parent.shown["baselineJob"] ? { baselineJob: parent.shown["baselineJob"] } : {},
			});
			return true;
		});
	}
}
