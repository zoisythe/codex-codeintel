import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import type { AutomaticResult } from "./automatic.js";
import { BUDGET } from "./budgets.js";
import { type Config, configuration } from "./config.js";
import { configurationImpact, configurationLanguages } from "./config-files.js";
import { automaticExecution, executionEnvironment } from "./environment.js";
import { hash, type Inventory, indexStatistics, inventory, latestInventory, workspacePath } from "./files.js";
import type { HookOutput } from "./hook-engine.js";
import { analysisIdentity } from "./identity.js";
import { Languages } from "./language.js";
import { Metadata } from "./metadata.js";
import { timings } from "./metrics.js";
import { ProjectChecks } from "./project-checks.js";
import type { ProjectResult } from "./project-types.js";
import {
	type FileResult,
	type FormatResult,
	mergeFindings,
	message,
	type NavigationResult,
	text,
	WriteFailure,
} from "./results.js";
import { formatWithRunner, lintBatch, preflightRunner } from "./runners.js";
import { codeLanguage, withToolResolution } from "./tool-resolution.js";

export interface EngineDependencies {
	checkBatch(
		paths: string[],
		config: Config,
		source: string,
		signal: AbortSignal,
	): Promise<{ result: FileResult; lsp: FileResult; lint: FileResult }[]>;
}
export type ToolOutput = Record<string, unknown> &
	(
		| { operation: "release" | "session_end" | "hook_ack" }
		| { operation: "handshake"; protocol: number; identity: string; pid: number }
		| { operation: "hook"; output: HookOutput }
		| ({ operation: "automatic" } & AutomaticResult)
		| { operation: "automatic_batch"; results: FileResult[] }
		| { operation: "lsp_status"; workspace: string; trusted: boolean; configuration: Config }
		| { operation: "check_diagnostics"; results: FileResult[]; partial: boolean; errors: number; warnings: number }
		| ({ operation: "lsp_navigation" | "lsp_rename" } & NavigationResult)
		| { operation: "lsp_format"; results: FormatResult[]; modifiedPaths: string[] }
		| ProjectResult
	);

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
	private generation = 0;
	async warmup(signal: AbortSignal): Promise<void> {
		const config = await configuration(this.root);
		if (
			!config.trusted ||
			(config.automaticDiagnostics.postToolUse === "off" && config.automaticDiagnostics.stop === "off")
		)
			return;
		const snapshot = latestInventory(this.root);
		if (!snapshot?.complete) return;
		const representatives = new Map<string, { path: string; count: number }>();
		for (const path of snapshot.files.keys()) {
			const language = codeLanguage(config, path);
			if (!language || configurationImpact(path).length || ["json", "yaml", "css", "html"].includes(language))
				continue;
			const entry = representatives.get(language);
			if (entry) entry.count++;
			else representatives.set(language, { path, count: 1 });
		}
		this.language ??= new Languages(this.root, config);
		await this.language.update(config);
		for (const entry of [...representatives.values()].sort((a, b) => b.count - a.count).slice(0, 2)) {
			signal.throwIfAborted();
			await this.language.preflight(entry.path, signal).catch(() => undefined);
		}
	}
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
		private readonly dependencies: EngineDependencies = {
			checkBatch: async (paths, config, source, signal) => {
				this.language ??= new Languages(root, config);
				const runners =
					source === "lsp"
						? new Map<string, FileResult>()
						: await lintBatch(root, paths, signal, config, !automaticExecution());
				const results = [];
				for (const path of paths) {
					const lsp: FileResult =
						source === "lint"
							? { path, state: "skipped", findings: [] }
							: await this.language.check(path, signal);
					const runner: FileResult = runners.get(path) ?? {
						path,
						state: "skipped",
						findings: [],
						note: "lint off or unavailable",
					};
					const selected =
						source === "lsp"
							? lsp
							: source === "lint"
								? runner
								: {
										path,
										state:
											lsp.state === "complete"
												? runner.state === "skipped"
													? ("complete" as const)
													: runner.state
												: lsp.state,
										findings: mergeFindings([...lsp.findings, ...runner.findings]),
										note: [lsp.note, runner.note].filter(Boolean).join("; "),
									};
					results.push({
						result: { ...selected, channels: { lsp: lsp.state, lint: runner.state } },
						lsp,
						lint: runner,
					});
				}
				return results;
			},
		},
		private readonly projects = new ProjectChecks(root),
	) {}
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
		const previous = this.previousSnapshot;
		if (previous?.version !== snapshot.version && this.language) {
			const changed = [...new Set([...snapshot.files.keys(), ...(previous?.files.keys() ?? [])])].filter(
				(path) => previous?.files.get(path) !== snapshot.files.get(path),
			);
			for (const path of changed)
				if (
					configurationImpact(path).includes("types") &&
					!/(?:\.lock|(?:^|\/)package(?:-lock)?\.json|(?:^|\/)pnpm-lock\.yaml)$/.test(path)
				)
					await this.language.invalidate(path);
			await this.language.sync(snapshot.files);
		}

		for (const key of this.cache.keys()) {
			const path = key.replace(/^(?:lsp|lint):/, "");
			if (previous?.files.has(path) && !snapshot.files.has(path)) this.cache.delete(key);
		}
		this.previousSnapshot = snapshot;
	}

	async check(
		paths: string[],
		id: string,
		turn: string,
		lspOnly = false,
		signal: AbortSignal = new AbortController().signal,
		_offset = 0,
		baseline?: Inventory,
		provided?: Config,
		source = lspOnly ? "lsp" : "both",
	): Promise<FileResult[]> {
		const config = provided ?? (await configuration(this.root));
		const snapshot =
			baseline ?? latestInventory(this.root) ?? (await inventory(this.root, BUDGET.files, signal, config.exclude));
		await this.synchronize(snapshot);
		const session = this.session(id, turn);
		const results = new Map<string, FileResult>();
		const pending: { path: string; identity: string; content: string; key: string }[] = [];
		for (const requested of [...new Set(paths)].slice(0, 200)) {
			signal.throwIfAborted();
			try {
				const absolute = await workspacePath(this.root, requested);
				const path = relative(this.root, absolute);
				session.touched.add(path);
				session.current.add(path);
				if ((await stat(absolute)).size > BUDGET.fileBytes) {
					results.set(path, { path, state: "skipped", findings: [], note: "File exceeds 1 MiB" });
					continue;
				}
				const identity = await analysisIdentity(this.root, [path], config, signal);
				this.identities.set(path, identity);
				const content = hash(await readFile(absolute, { encoding: "utf8", signal }));
				const key = `${source === "both" ? "" : `${source}:`}${path}`;
				const cached = this.cache.get(key);
				if (
					snapshot.complete &&
					cached?.version === this.projectVersion(snapshot, path, config) &&
					cached.identity === identity &&
					cached.content === content &&
					cached.result.state === "complete"
				)
					results.set(path, cached.result);
				else pending.push({ path, identity, content, key });
			} catch (error) {
				signal.throwIfAborted();
				results.set(requested, { path: requested, state: "skipped", findings: [], note: message(error) });
			}
		}
		const checked = await this.dependencies.checkBatch(
			pending.map((entry) => entry.path),
			config,
			source,
			signal,
		);
		for (const entry of pending) {
			signal.throwIfAborted();
			const channels = checked.find((item) => item.result.path === entry.path);
			const result = channels?.result ?? {
				path: entry.path,
				state: "pending" as const,
				findings: [],
				note: "Checker returned no result",
			};
			try {
				if (
					hash(await readFile(await workspacePath(this.root, entry.path), { encoding: "utf8", signal })) !==
						entry.content ||
					(await analysisIdentity(this.root, [entry.path], await configuration(this.root), signal)) !==
						entry.identity ||
					this.projectVersion(latestInventory(this.root) ?? snapshot, entry.path, config) !==
						this.projectVersion(snapshot, entry.path, config)
				) {
					result.state = "stale";
					result.note = "File/tool/configuration changed during diagnostics; retry";
				}
			} catch {
				signal.throwIfAborted();
				result.state = "stale";
				result.note = "File disappeared during diagnostics";
			}
			if (JSON.stringify(this.cache.get(entry.key)?.result) !== JSON.stringify(result)) this.generation++;
			this.cache.set(entry.key, {
				version: this.projectVersion(snapshot, entry.path, config),
				identity: entry.identity,
				content: entry.content,
				result,
			});
			if (channels)
				for (const channel of ["lsp", "lint"] as const) {
					if ((source === "lsp" && channel === "lint") || (source === "lint" && channel === "lsp")) continue;
					this.cache.set(`${channel}:${entry.path}`, {
						version: this.projectVersion(snapshot, entry.path, config),
						identity: entry.identity,
						content: entry.content,
						result: result.state === "stale" ? { ...channels[channel], state: "stale" } : channels[channel],
					});
				}
			results.set(entry.path, result);
		}
		return [...results.values()];
	}

	dispatch(operation: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutput> {
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
				const scoped = await inventory(this.root, BUDGET.files, signal, config.exclude, absolute);
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

	private async execute(operation: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutput> {
		if (operation === "release") {
			await this.close();
			this.cache.clear();
			return { operation };
		}
		const config = await configuration(this.root);
		if (this.configVersion !== config.version || args["refresh"] === true) {
			if (args["refresh"] === true) await this.close();
			else await this.language?.update(config);
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
		if (operation === "lsp_status") {
			this.language ??= new Languages(this.root, config);
			const targets = args["path"]
				? [text(args["path"])]
				: Object.values(config.servers)
						.filter((server) => !!server)
						.map((server) => (server ? `status${server.extensions[0]}` : ""));
			return {
				operation,
				workspace: this.root,
				trusted: config.trusted,
				configuration: config,
				tools: await Promise.all(
					targets.map((path) => this.language?.status(path).catch((error) => ({ path, reason: message(error) }))),
				),
				timings: timings(),
				cache: this.cache.size,
				clients: this.language.statistics(),
				index: indexStatistics(),
				sessions: [...this.sessions.keys()],
			};
		}
		if (operation === "automatic_batch") {
			if (!config.trusted)
				throw new Error("Automatic LSP/lint requires workspace trust; lint requires workspace trust");
			const paths = Array.isArray(args["paths"])
				? args["paths"].filter((path): path is string => typeof path === "string")
				: [];
			return {
				operation,
				results: await this.check(
					paths.slice(0, BUDGET.batch),
					text(args["session"]),
					text(args["turn"]),
					false,
					signal,
					0,
					undefined,
					config,
				),
			};
		}
		const id =
			args["scope"] === "paths" || args["scope"] === undefined
				? text(args["session"], "manual")
				: this.id(args["session"]);
		if (operation === "check_diagnostics") return this.diagnostics(args, id, signal, config, store);
		if (
			(operation === "lsp_rename" || operation === "lsp_format") &&
			(config.automaticDiagnostics.postToolUse !== "off" || config.automaticDiagnostics.stop !== "off")
		) {
			const paths = operation === "lsp_rename" ? undefined : (await this.paths(args, signal)).paths;
			const baseline = await this.projects.baseline(id, paths, executionEnvironment(), signal, BUDGET.stopWait);
			if (baseline.pending.length || baseline.failures.length)
				throw new Error(`Pre-edit baseline unavailable: ${[...baseline.pending, ...baseline.failures].join("; ")}`);
		}

		if (operation === "lsp_rename") args = { ...args, operation: "rename" };

		if (operation === "lsp_navigation" || operation === "lsp_rename") {
			const path = relative(this.root, await workspacePath(this.root, text(args["path"])));
			const identity = await analysisIdentity(this.root, [path], config, signal);
			if (this.identities.has(path) && this.identities.get(path) !== identity) {
				for (const key of this.cache.keys()) if (key.replace(/^(?:lsp|lint):/, "") === path) this.cache.delete(key);
			}
			this.identities.set(path, identity);
			const snapshot = await inventory(this.root, BUDGET.files, signal, config.exclude, this.root, true);
			snapshot.version = hash(snapshot.version + config.version);
			await this.synchronize(snapshot);
			this.language ??= new Languages(this.root, config);
			const before = args["operation"] === "rename" ? await inventory(this.root, BUDGET.files, signal) : undefined;
			let output: NavigationResult;
			try {
				output = await this.language.navigate(args, signal);
			} finally {
				if (before) this.cache.clear();
			}
			if (before) {
				const modifiedPaths = "modifiedPaths" in output ? output.modifiedPaths : [];
				this.cache.clear();
				const after = await inventory(this.root, BUDGET.files, signal).catch((error: unknown) => {
					throw new WriteFailure(`${message(error)}; ${JSON.stringify(output)}`, modifiedPaths);
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
					throw new WriteFailure(`${message(error)}; ${JSON.stringify(output)}`, modifiedPaths);
				}
			}
			return { ...output, operation };
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
			const writes: FormatResult[] = [];
			const modifiedPaths: string[] = [];
			try {
				for (const path of paths) {
					signal.throwIfAborted();
					writes.push(
						(await formatWithRunner(this.root, path, signal, config)) ??
							(await this.language.format(path, signal)),
					);
					if (writes.at(-1)?.status === "formatted") modifiedPaths.push(path);
				}
				await this.check(paths, id, "manual", false, signal);
			} catch (error) {
				throw new WriteFailure(`${message(error)}; completed writes: ${JSON.stringify(writes)}`, modifiedPaths);
			} finally {
				this.cache.clear();
			}
			return { operation, modifiedPaths, results: writes };
		}
		throw new Error("Unknown tool");
	}

	private async diagnostics(
		args: Record<string, unknown>,
		id: string,
		signal: AbortSignal,
		config: Config,
		store: Metadata,
	): Promise<ToolOutput> {
		for (const key of ["mode", "start", "offset", "revision"])
			if (args[key] !== undefined)
				throw new Error("Migration required: use scope/source/run/cursor; see docs/usage.md#upgrade");
		const scope = text(args["scope"], "paths");
		if (
			scope === "paths" &&
			((!args["path"] && !args["paths"]) ||
				args["path"] === "." ||
				(Array.isArray(args["paths"]) && args["paths"].includes(".")))
		)
			throw new Error(
				"Migration required: use check_project for workspace checks; check_diagnostics requires specific paths or turn/session scope",
			);
		const source = text(args["source"], "both");
		const run = text(args["run"], "active");
		if (
			!["paths", "turn", "session"].includes(scope) ||
			!["both", "lsp", "lint"].includes(source) ||
			!["active", "cached"].includes(run)
		)
			throw new Error("Invalid scope/source/run");
		const snapshot = await inventory(this.root, BUDGET.files, signal, config.exclude, this.root, true);
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
				const pending = results.slice(index, index + BUDGET.batch);
				if (pending.some((result) => result.analysisRequired)) {
					const checked = await this.check(
						pending.map((result) => result.path),
						id,
						this.session(id).turn,
						source === "lsp",
						signal,
						0,
						snapshot,
						config,
						source,
					);
					results.splice(index, pending.length, ...checked);
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
						if (!codeLanguage(config, path)) throw new Error(`Language disabled or unsupported: ${path}`);
						selected.add(path);
					} else
						for (const candidate of (snapshot.complete
							? snapshot
							: await inventory(this.root, BUDGET.files, signal, config.exclude, absolute)
						).files.keys())
							if ((!path || candidate.startsWith(`${path}${sep}`)) && codeLanguage(config, candidate))
								selected.add(candidate);
				}
				paths = [...selected].sort();
			} else
				paths = [...(scope === "turn" ? this.session(id).current : this.session(id).touched)]
					.filter((path) => snapshot.files.has(path))
					.sort();
			identity = await this.pageIdentity(paths, config, snapshot, signal);
			if (run === "cached") {
				results = [];
				for (const path of paths) {
					const entry = this.cache.get((source === "lsp" ? "lsp:" : source === "lint" ? "lint:" : "") + path);
					results.push(
						!entry
							? { path, state: "pending", findings: [] }
							: entry.version === this.projectVersion(snapshot, path, config) &&
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
				const checked = await this.check(
					paths.slice(0, BUDGET.batch),
					id,
					this.session(id).turn,
					source === "lsp",
					signal,
					0,
					snapshot,
					config,
					source,
				);
				results = [
					...checked,
					...paths.slice(BUDGET.batch).map((path) => ({
						path,
						state: "pending" as const,
						findings: [],
						analysisRequired: true,
						note: "Continue cursor for active analysis",
					})),
				];
			}
		}
		const selected: FileResult[] = [];
		let size = 0;
		for (const result of results.slice(index)) {
			const bytes = JSON.stringify(result).length;
			if (selected.length && (size + bytes > 24000 || selected.length >= BUDGET.batch)) break;
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
		return {
			operation: "check_diagnostics",
			inventoryComplete: snapshot.complete,
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
		};
	}

	private projectVersion(snapshot: Inventory, path: string, config: Config): string {
		const language = codeLanguage(config, path);
		let owner = dirname(path);
		while (
			owner !== "." &&
			![...snapshot.files.keys()].some(
				(candidate) => dirname(candidate) === owner && configurationLanguages(candidate).includes(language ?? ""),
			)
		)
			owner = dirname(owner);
		const prefix = owner === "." ? "" : `${owner}/`;
		return hash(
			JSON.stringify(
				[...snapshot.files].filter(
					([candidate]) =>
						candidate.startsWith(prefix) &&
						(codeLanguage(config, candidate) === language ||
							(configurationImpact(candidate).some((impact) => impact === "types" || impact === "lint") &&
								configurationLanguages(candidate).includes(language ?? ""))),
				),
			),
		);
	}

	private async contentIdentity(path: string, snapshot: Inventory, signal: AbortSignal): Promise<string> {
		const existing = snapshot.files.get(path);
		if (existing) return existing;
		try {
			const absolute = await workspacePath(this.root, path);
			const info = await stat(absolute);
			if (info.size > BUDGET.fileBytes) return "oversized";
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
