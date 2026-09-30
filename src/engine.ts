import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import { type Config, configuration } from "./config.js";
import { hash, type Inventory, inventory, workspacePath } from "./files.js";
import { analysisIdentity } from "./identity.js";
import { Languages } from "./language.js";
import { logEvent } from "./log.js";
import { Metadata } from "./metadata.js";
import { timings } from "./metrics.js";
import { type FileResult, mergeFindings, message, record, render, text, WriteFailure } from "./results.js";
import { formatWithRunner, lint, preflightRunner } from "./runners.js";
import { codeLanguage, languageFor, withToolResolution } from "./tool-resolution.js";

type Checker = (path: string, signal: AbortSignal, lspOnly: boolean) => Promise<FileResult>;
interface Cached {
	identity: string;
	version: string;
	content: string;
	result: FileResult;
}
interface Session {
	turn: string;
	touched: Set<string>;
	current: Set<string>;
}
export class Engine {
	private readonly identities = new Map<string, string>();
	private readonly cache = new Map<string, Cached>();
	private readonly sessions = new Map<string, Session>();
	private language: Languages | undefined;
	private configVersion = "";
	private previousSnapshot: Inventory | undefined;
	private queue: Promise<unknown> = Promise.resolve();
	private readonly checker: Checker;
	private requestConfig: Config | undefined;
	private source = "both";
	private lastResults: FileResult[] = [];
	private generation = 0;
	private pages = new Map<
		string,
		{
			version: string;
			results: FileResult[];
			index: number;
			args: Record<string, unknown>;
			identity: string;
			generation: number;
		}
	>();
	constructor(
		readonly root: string,
		checker?: Checker,
	) {
		this.checker =
			checker ??
			(async (path, signal, lspOnly) => {
				this.language ??= new Languages(root, this.requestConfig ?? (await configuration(root)));
				const lsp: FileResult =
					this.source === "lint"
						? { path, state: "skipped", findings: [] }
						: await this.language.check(path, signal);
				if (lspOnly) return lsp;
				if (lsp.state === "skipped" || lsp.state === "failed") {
					if (this.source !== "lint") return lsp;
				}
				const runner = await lint(root, path, signal, this.requestConfig, true);
				if (this.source === "lint")
					return runner ?? { path, state: "skipped", findings: [], note: "lint requires workspace trust" };
				if (!runner)
					return {
						...lsp,
						channels: { lsp: lsp.state, lint: "skipped" },
						note: [lsp.note, "lint requires workspace trust"].filter(Boolean).join("; "),
					};
				return {
					path,
					state: lsp.state === "complete" ? (runner.state === "skipped" ? "complete" : runner.state) : lsp.state,
					channels: { lsp: lsp.state, lint: runner.state },
					findings: mergeFindings([...lsp.findings, ...runner.findings]),
					...(lsp.note || runner.note ? { note: [lsp.note, runner.note].filter(Boolean).join("; ") } : {}),
				};
			});
	}
	private session(id: string, turn?: string): Session {
		let session = this.sessions.get(id);
		if (!session) {
			session = {
				turn: turn ?? "",
				touched: new Set(),
				current: new Set(),
			};
			this.sessions.set(id, session);
		}
		if (turn && session.turn !== turn) {
			session.turn = turn;
			session.current.clear();
		}
		return session;
	}
	private id(value: unknown): string {
		if (typeof value === "string" && value) return value;
		if (this.sessions.size === 1) return this.sessions.keys().next().value ?? "manual";
		if (this.sessions.size > 1)
			throw new Error(
				"Multiple sessions: provide session from Hook feedback, or a new unique session for manual checks",
			);
		return "manual";
	}
	private async synchronize(snapshot: Inventory): Promise<void> {
		if (!snapshot.complete) await this.close();
		const previous = this.previousSnapshot;
		if (previous?.version !== snapshot.version && this.language) {
			const configChanged = [...new Set([...snapshot.files.keys(), ...(previous?.files.keys() ?? [])])].some(
				(path) =>
					/(?:config|lock|manifest|Cargo\.toml|package\.json|go\.mod|pyproject|ty\.toml|ruff\.toml|\.clangd|compile_commands\.json|compile_flags\.txt|\.clang-format|rust-toolchain|rustfmt)/i.test(
						path,
					) && previous?.files.get(path) !== snapshot.files.get(path),
			);
			if (configChanged) {
				await this.language.close();
				this.language = undefined;
			} else await this.language.sync(snapshot.files);
		}
		this.previousSnapshot = snapshot;
	}

	async check(
		paths: string[],
		id: string,
		turn: string,
		lspOnly = false,
		signal: AbortSignal = new AbortController().signal,
		offset = 0,
		baseline?: Inventory,
	): Promise<string> {
		const config = this.requestConfig ?? (await configuration(this.root));
		const snapshot = baseline ?? (await inventory(this.root, 10000, signal, config.exclude, this.root, true));
		if (!baseline) snapshot.version = hash(snapshot.version + config.version);
		await this.synchronize(snapshot);
		const session = this.session(id, turn);
		const results: FileResult[] = [];
		const deadline = Date.now() + 45000;
		for (const requested of [...new Set(paths)]) {
			signal.throwIfAborted();
			let path = requested;
			try {
				path = relative(this.root, await workspacePath(this.root, requested));
			} catch (error) {
				results.push({ path, state: "skipped", findings: [], note: message(error) });
				this.cache.delete(path);
				session.touched.delete(path);
				continue;
			}
			session.touched.add(path);
			session.current.add(path);
			if (Date.now() >= deadline || results.length >= 200) {
				this.cache.delete(path);
				this.cache.delete(`lsp:${path}`);
				results.push({ path, state: "pending", findings: [], note: "Scan time budget reached" });
				continue;
			}
			const key = `${lspOnly ? "lsp:" : this.source === "lint" ? "lint:" : ""}${path}`;
			const cached = this.cache.get(key);
			const identity = await analysisIdentity(this.root, [path], config, signal);
			if (this.identities.has(path) && this.identities.get(path) !== identity) {
				await this.close();
				this.cache.clear();
			}
			this.identities.set(path, identity);
			const absolute = await workspacePath(this.root, path);
			if ((await stat(absolute)).size > 1024 * 1024) {
				results.push({ path, state: "skipped", findings: [], note: "File exceeds 1 MiB" });
				continue;
			}
			const content = hash(await readFile(absolute, { encoding: "utf8", signal }));
			if (
				snapshot.complete &&
				cached?.version === snapshot.version &&
				cached.identity === identity &&
				cached.content === content &&
				cached.result.state === "complete"
			) {
				results.push(cached.result);
				continue;
			}
			const result = await this.checker(path, signal, lspOnly);
			signal.throwIfAborted();
			if (
				hash(await readFile(await workspacePath(this.root, path), { encoding: "utf8", signal })) !== content ||
				(await analysisIdentity(this.root, [path], await configuration(this.root), signal)) !== identity
			) {
				result.state = "stale";
				result.note = "File changed during diagnostics; retry";
			}
			if (JSON.stringify(this.cache.get(key)?.result) !== JSON.stringify(result)) this.generation++;
			this.cache.set(key, { version: snapshot.version, identity, content, result });
			results.push(result);
		}
		const after = await inventory(this.root, 10000, signal, config.exclude, this.root, true);
		after.version = hash(after.version + (await configuration(this.root)).version);
		if (after.version !== snapshot.version) {
			for (const result of results) {
				result.state = "stale";
				result.note = "Workspace changed or snapshot incomplete; retry";
			}
		}
		if (paths.length > 200)
			results.push({
				path: ".",
				state: "pending",
				findings: [],
				note: "File/snapshot budget exceeded; narrow paths",
			});
		this.lastResults = results;
		return (
			render(results, 50, 8192, offset) +
			(!snapshot.complete ? "\nDependency inventory incomplete; workspace dependency freshness unverified" : "")
		);
	}

	dispatch(operation: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
		const writes = operation === "lsp_format" || operation === "lsp_rename";
		let started = false;
		const task = this.queue.then(() => {
			started = true;
			signal.throwIfAborted();
			return withToolResolution(() => this.execute(operation, args, signal));
		});
		this.queue = task.catch(() => undefined);
		return new Promise((resolve, reject) => {
			const abort = () => {
				if (!started || !writes) reject(new Error("Request cancelled while queued or executing"));
				if (started) void this.close().catch(() => logEvent("cancel-cleanup-failure"));
			};
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			void task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
		});
	}
	private async paths(
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<{ paths: string[]; complete: boolean }> {
		const config = await configuration(this.root);
		const values = Array.isArray(args["paths"]) ? args["paths"] : [text(args["path"], ".")];
		if (values.length > 200 || !values.every((value) => typeof value === "string"))
			throw new Error("paths must contain at most 200 strings");
		const paths = new Set<string>();
		let complete = true;
		for (const value of values) {
			if (typeof value !== "string") continue;
			signal.throwIfAborted();
			const absolute = await workspacePath(this.root, value);
			if ((await stat(absolute)).isFile()) paths.add(relative(this.root, absolute));
			else {
				const scoped = await inventory(this.root, 10000, signal, config.exclude, absolute);
				complete &&= scoped.complete;
				for (const path of scoped.files.keys()) {
					paths.add(path);
					if (paths.size > 10000) {
						complete = false;
						break;
					}
				}
			}
			if (paths.size > 10000) break;
		}
		return { paths: [...paths].sort().slice(0, 10000), complete };
	}

	private async execute(operation: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
		if (operation === "release") {
			await this.close();
			this.cache.clear();
			return "";
		}
		const config = await configuration(this.root);
		if (this.configVersion !== config.version || args["refresh"] === true) {
			await this.close();
			this.cache.clear();
			this.pages.clear();
			this.configVersion = config.version;
		}
		const store = new Metadata(this.root);
		const ids = await store.ids();
		for (const id of this.sessions.keys())
			if (!ids.includes(id) && (await store.read(id)).turn === "__ended__") this.sessions.delete(id);
		for (const id of ids) {
			const state = await store.read(id);
			if (state.turn === "__ended__") {
				this.sessions.delete(id);
				continue;
			}
			const session = this.session(id, state.turn);
			session.touched = new Set(state.touched);
			session.current = new Set(state.current);
		}
		this.requestConfig = config;
		if (operation === "lsp_status") {
			this.language ??= new Languages(this.root, config);
			const targets = args["path"]
				? [text(args["path"])]
				: Object.values(config.servers)
						.filter((server) => !!server)
						.map((server) => (server ? `status${server.extensions[0]}` : ""));
			return JSON.stringify({
				workspace: this.root,
				trusted: config.trusted,
				configuration: config,
				tools: await Promise.all(
					targets.map((path) => this.language?.status(path).catch((error) => ({ path, reason: message(error) }))),
				),
				timings: timings(),
				cache: this.cache.size,
				sessions: [...this.sessions.keys()],
			});
		}
		const id =
			args["scope"] === "paths" || args["scope"] === undefined
				? text(args["session"], "manual")
				: this.id(args["session"]);
		if (operation === "check_diagnostics") return this.diagnostics(args, id, signal, config, store);
		if (operation === "lsp_rename") args = { ...args, operation: "rename" };

		if (operation === "lsp_navigation" || operation === "lsp_rename") {
			const path = relative(this.root, await workspacePath(this.root, text(args["path"])));
			const identity = await analysisIdentity(this.root, [path], config, signal);
			if (this.identities.has(path) && this.identities.get(path) !== identity) {
				await this.close();
				this.cache.clear();
			}
			this.identities.set(path, identity);
			const snapshot = await inventory(this.root, 10000, signal, config.exclude, this.root, true);
			snapshot.version = hash(snapshot.version + config.version);
			await this.synchronize(snapshot);
			this.language ??= new Languages(this.root, config);
			const before = args["operation"] === "rename" ? await inventory(this.root, 10000, signal) : undefined;
			let output: string;
			try {
				output = await this.language.navigate(args, signal);
			} finally {
				if (before) this.cache.clear();
			}
			if (before) {
				let modifiedPaths: string[] = [];
				try {
					const result: unknown = JSON.parse(output);
					if (record(result) && Array.isArray(result["modifiedPaths"]))
						modifiedPaths = result["modifiedPaths"].filter((path): path is string => typeof path === "string");
				} catch {
					/* No rename edits. */
				}
				this.cache.clear();
				const after = await inventory(this.root, 10000, signal).catch((error: unknown) => {
					throw new WriteFailure(`${message(error)}; ${output}`, modifiedPaths);
				});
				const changed = [...after.files]
					.filter(([path, version]) => before.files.get(path) !== version)
					.map(([path]) => path);
				try {
					await this.check(
						[...new Set([text(args["path"]), ...changed])],
						id,
						this.session(id).turn,
						false,
						signal,
					);
				} catch (error) {
					throw new WriteFailure(`${message(error)}; ${output}`, modifiedPaths);
				}
			}
			return output;
		}
		const scope = await this.paths(args, signal);
		const paths = scope.paths;
		if (operation === "lsp_format") {
			if (!args["paths"] && !args["path"]) throw new Error("Explicit formatting paths required");
			if (paths.length > 200) throw new Error("Format at most 200 explicitly scoped files");
			this.language ??= new Languages(this.root, config);
			for (const path of paths) {
				const runner = await preflightRunner(this.root, path, config, signal);
				await this.language.preflight(path, signal, runner ? undefined : "format");
			}
			const lines: string[] = [];
			const modifiedPaths: string[] = [];
			try {
				for (const path of paths) {
					signal.throwIfAborted();
					lines.push(
						(await formatWithRunner(this.root, path, signal, config)) ??
							(await this.language.format(path, signal)),
					);
					if (lines.at(-1)?.startsWith("Formatted:")) modifiedPaths.push(path);
				}
				await this.check(paths, id, "manual", false, signal);
			} catch (error) {
				throw new WriteFailure(`${message(error)}; completed writes: ${JSON.stringify(lines)}`, modifiedPaths);
			} finally {
				this.cache.clear();
			}
			return JSON.stringify({ text: lines.join("\n").slice(0, 8000) || "No files", modifiedPaths, results: lines });
		}
		throw new Error("Unknown tool");
	}

	private async diagnostics(
		args: Record<string, unknown>,
		id: string,
		signal: AbortSignal,
		config: Config,
		store: Metadata,
	): Promise<string> {
		for (const key of ["mode", "start", "offset", "revision"])
			if (args[key] !== undefined)
				throw new Error("Migration required: use scope/source/run/cursor; see docs/migration-0.5.md");
		const scope = text(args["scope"], "paths");
		const source = text(args["source"], "both");
		const run = text(args["run"], "active");
		if (
			!["paths", "turn", "session"].includes(scope) ||
			!["both", "lsp", "lint"].includes(source) ||
			!["active", "cached"].includes(run)
		)
			throw new Error("Invalid scope/source/run");
		this.source = source;
		const snapshot = await inventory(this.root, 10000, signal, config.exclude, this.root, true);
		snapshot.version = hash(snapshot.version + config.version);
		const token = text(args["cursor"]);
		let results: FileResult[];
		let index = 0;
		let identity: string;
		if (token) {
			const page = this.pages.get(token);
			if (
				!page ||
				page.generation !== this.generation ||
				page.version !== snapshot.version ||
				hash(
					JSON.stringify(
						Object.entries(args)
							.filter(([key]) => key !== "cursor" && key !== "workspace" && key !== "refresh")
							.sort(),
					),
				) !==
					hash(
						JSON.stringify(
							Object.entries(page.args)
								.filter(([key]) => key !== "cursor" && key !== "workspace" && key !== "refresh")
								.sort(),
						),
					)
			)
				throw new Error("Cursor invalid or stale; restart without cursor");
			identity = await this.pageIdentity(
				page.results.map((result) => result.path),
				config,
				snapshot,
				signal,
			);
			if (identity !== page.identity) throw new Error("Cursor invalid: tool/configuration changed");
			results = [...page.results];
			index = page.index;
			if (run === "active") {
				const pending = results.slice(index, index + 50);
				if (pending.some((result) => result.note === "Continue cursor for active analysis")) {
					await this.check(
						pending.map((result) => result.path),
						id,
						this.session(id).turn,
						source === "lsp",
						signal,
						0,
						snapshot,
					);
					results.splice(index, pending.length, ...this.lastResults);
				}
			}
		} else {
			let paths: string[];
			if (scope === "paths") {
				const values = Array.isArray(args["paths"]) ? args["paths"] : [text(args["path"], ".")];
				const selected = new Set<string>();
				for (const value of values) {
					if (typeof value !== "string") throw new Error("paths requires strings");
					const absolute = await workspacePath(this.root, value);
					const path = relative(this.root, absolute);
					if ((await stat(absolute)).isFile()) {
						if (!languageFor(config, path)) throw new Error(`Language disabled or unsupported: ${path}`);
						selected.add(path);
					} else
						for (const candidate of (snapshot.complete
							? snapshot
							: await inventory(this.root, 10000, signal, config.exclude, absolute)
						).files.keys())
							if ((!path || candidate.startsWith(`${path}/`)) && codeLanguage(config, candidate))
								selected.add(candidate);
				}
				paths = [...selected].sort();
			} else paths = [...(scope === "turn" ? this.session(id).current : this.session(id).touched)].sort();
			identity = await this.pageIdentity(paths, config, snapshot, signal);
			if (run === "cached") {
				results = [];
				for (const path of paths) {
					const entry = this.cache.get((source === "lsp" ? "lsp:" : source === "lint" ? "lint:" : "") + path);
					results.push(
						!entry
							? { path, state: "pending", findings: [] }
							: entry.version === snapshot.version &&
									entry.content === (await this.contentIdentity(path, snapshot, signal)) &&
									snapshot.complete &&
									entry.identity === (await analysisIdentity(this.root, [path], config, signal))
								? entry.result
								: { ...entry.result, state: "stale", note: "Run active diagnostics" },
					);
				}
			} else {
				await store.update(id, signal, (state) => {
					state.touched.push(...paths);
					state.current.push(...paths);
				});
				await this.check(paths.slice(0, 50), id, this.session(id).turn, source === "lsp", signal, 0, snapshot);
				results = [
					...this.lastResults,
					...paths.slice(50).map((path) => ({
						path,
						state: "pending" as const,
						findings: [],
						note: "Continue cursor for active analysis",
					})),
				];
			}
		}
		const selected: FileResult[] = [];
		let size = 0;
		for (const result of results.slice(index)) {
			const bytes = JSON.stringify(result).length;
			if (selected.length && (size + bytes > 24000 || selected.length >= 50)) break;
			selected.push(result);
			size += bytes;
		}
		let next: Record<string, unknown> | undefined;
		if (index + selected.length < results.length) {
			const cursor = randomUUID();
			this.pages.set(cursor, {
				version: snapshot.version,
				results,
				index: index + selected.length,
				args,
				identity,
				generation: this.generation,
			});
			while (this.pages.size > 32) this.pages.delete(this.pages.keys().next().value ?? "");
			next = { ...args, refresh: undefined, workspace: this.root, cursor };
		}
		const partial = !snapshot.complete || results.some((result) => result.state !== "complete");
		return JSON.stringify({
			text: (
				(partial ? render(selected).replace(/^complete;/, "partial;") : render(selected)) +
				(next ? "\nMore results: follow the structured next arguments." : "") +
				(!snapshot.complete ? "\nDependency inventory incomplete; workspace dependency freshness unverified" : "")
			).replace(/\n.*omitted; next offset=.*$/, ""),
			scope,
			source,
			run,
			partial,
			errors: results.flatMap((result) => result.findings).filter((item) => item.severity === "error").length,
			warnings: results.flatMap((result) => result.findings).filter((item) => item.severity === "warning").length,
			results: selected,
			unavailable: Object.fromEntries(
				[
					...new Set(
						results
							.filter((result) => result.state === "failed" || result.state === "skipped")
							.map((result) => codeLanguage(config, result.path) ?? "unsupported"),
					),
				].map((language) => [
					language,
					[
						...new Set(
							results
								.filter(
									(result) =>
										(codeLanguage(config, result.path) ?? "unsupported") === language &&
										result.note &&
										(result.state === "failed" || result.state === "skipped"),
								)
								.map((result) => result.note),
						),
					],
				]),
			),
			...(next ? { next } : {}),
			isError:
				run === "active" &&
				results.length > 0 &&
				results.every(
					(result) =>
						(result.state === "failed" || result.state === "skipped") &&
						result.channels?.lsp !== "complete" &&
						result.channels?.lint !== "complete",
				),
		});
	}

	private async contentIdentity(path: string, snapshot: Inventory, signal: AbortSignal): Promise<string> {
		const existing = snapshot.files.get(path);
		if (existing) return existing;
		try {
			const absolute = await workspacePath(this.root, path);
			const info = await stat(absolute);
			if (info.size > 1024 * 1024) return "oversized";
			return hash(await readFile(absolute, { encoding: "utf8", signal }));
		} catch {
			signal.throwIfAborted();
			return "unavailable";
		}
	}
	private async pageIdentity(
		paths: string[],
		config: Config,
		snapshot: Inventory,
		signal: AbortSignal,
	): Promise<string> {
		const contents: string[][] = [];
		for (const path of paths) contents.push([path, await this.contentIdentity(path, snapshot, signal)]);
		return hash(JSON.stringify([await analysisIdentity(this.root, paths, config, signal), contents]));
	}

	async dispose(): Promise<void> {
		await this.close();
		await this.queue;
		await this.close();
	}
	async close(): Promise<void> {
		const language = this.language;
		this.language = undefined;
		await language?.close();
	}
}
