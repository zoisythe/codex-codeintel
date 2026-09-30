import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { directoryLock } from "./directory-lock.js";
import { executionEnvironment } from "./environment.js";
import { hash } from "./files.js";
import type { Finding } from "./results.js";
import { record } from "./results.js";
import { workspaceIdentity } from "./service-identity.js";

export interface SessionState {
	id: string;
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
}
const empty = (id: string): SessionState => ({
	id,
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
});
export class Metadata {
	constructor(private readonly root: string) {}
	private async dir(): Promise<string> {
		const user = process.getuid?.() ?? hash(homedir()).slice(0, 10);
		const base = join(
			executionEnvironment()["CODEX_LSP_CACHE"] ?? join(tmpdir(), `codex-lsp-${user}`),
			`metadata-v7-${user}`,
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
			if (change(state) === false) return state;
			state.version++;
			for (const key of ["touched", "current", "pending", "delivery", "blocked"] as const)
				state[key] = [...new Set(state[key])];
			await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
			await rename(temp, path);
			return state;
		} finally {
			await rm(temp, { force: true });
			await release();
		}
	}
	async end(id: string, signal: AbortSignal): Promise<void> {
		// Retain a versioned tombstone until after competing old requests have failed their CAS.
		await this.update(id, signal, (state) => {
			Object.assign(state, { ...empty(id), version: state.version, generation: state.generation + 1 });
			state.turn = "__ended__";
		});
	}
}
