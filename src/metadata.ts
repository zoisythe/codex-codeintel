import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { executionEnvironment } from "./environment.js";
import { hash } from "./files.js";
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
	baseline: Record<string, string> | null;
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
			`metadata-v6-${user}`,
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
				!["delta", "full"].includes(String(data["automaticScope"]))
			)
				throw new Error("Invalid metadata");
			for (const key of ["touched", "current", "pending", "delivery", "blocked"])
				if (!Array.isArray(data[key]) || !data[key].every((item: unknown) => typeof item === "string"))
					throw new Error("Invalid metadata");
			for (const key of ["shown", "baseline"])
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
	private async reclaim(lock: string): Promise<void> {
		let owner: unknown;
		try {
			owner = JSON.parse(await readFile(join(lock, "owner"), "utf8"));
		} catch {
			return;
		}
		if (!record(owner) || typeof owner["pid"] !== "number" || typeof owner["nonce"] !== "string") return;
		try {
			process.kill(owner["pid"], 0);
			return;
		} catch (error) {
			if (!record(error) || error["code"] !== "ESRCH") return;
		}
		// The former owner may have released the lock normally just before exiting.
		// Re-read after observing its death so we cannot move a successor's lock.
		try {
			const current: unknown = JSON.parse(await readFile(join(lock, "owner"), "utf8"));
			if (!record(current) || current["nonce"] !== owner["nonce"]) return;
		} catch {
			return;
		}
		// Keep this nonempty tombstone. A second reclaimer with the old nonce then
		// cannot rename a new writer's lock over the same destination.
		await rename(lock, `${lock}.abandoned-${hash(owner["nonce"])}`).catch((error: unknown) => {
			if (!record(error) || !["ENOENT", "EEXIST", "ENOTEMPTY", "EPERM"].includes(String(error["code"]))) throw error;
		});
	}
	async update(id: string, signal: AbortSignal, change: (state: SessionState) => unknown): Promise<SessionState> {
		signal.throwIfAborted();
		const dir = await this.dir();
		const path = join(dir, `${hash(id)}.json`);
		const lock = `${path}.lock`;
		const nonce = randomUUID();
		const candidate = `${lock}.claim-${nonce}`;
		const released = `${lock}.released-${nonce}`;
		const temp = `${path}.${nonce}.tmp`;
		const deadline = Date.now() + 1000;
		let acquired = false;
		try {
			await mkdir(candidate, { mode: 0o700 });
			await writeFile(join(candidate, "owner"), JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600 });
			// Publish a nonempty directory atomically; there is no ownerless-lock window.
			while (!acquired) {
				signal.throwIfAborted();
				try {
					await rename(candidate, lock);
					acquired = true;
				} catch (error) {
					if (!record(error) || !["EEXIST", "ENOTEMPTY", "EPERM"].includes(String(error["code"]))) throw error;
					await this.reclaim(lock);
					if (Date.now() >= deadline) throw new Error("Metadata update busy; retry");
					await delay(10, undefined, { signal });
				}
			}
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
			await rm(candidate, { recursive: true, force: true });
			if (acquired) {
				// Move away before deleting children, so an empty directory cannot be
				// replaced by a new owner while this writer is still removing it.
				await rename(lock, released);
				await rm(released, { recursive: true, force: true });
			}
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
