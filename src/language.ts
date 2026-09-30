import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LspClient } from "../packages/lsp-tools-mcp/dist/lsp/client.js";
import { getLanguageId } from "../packages/lsp-tools-mcp/dist/lsp/language-mappings.js";
import { LspManager } from "../packages/lsp-tools-mcp/dist/lsp/manager.js";
import type { Diagnostic, TextEdit, WorkspaceEdit } from "../packages/lsp-tools-mcp/dist/lsp/types.js";
import { findWorkspaceRoot } from "../packages/lsp-tools-mcp/dist/lsp/workspace-root.js";
import type { Config } from "./config.js";
import { executionEnvironment } from "./environment.js";
import { applyTextChanges, hash, inside, inventory, workspacePath } from "./files.js";
import { logEvent } from "./log.js";
import { measured } from "./metrics.js";
import { type FileResult, message, number, record, text, WriteFailure } from "./results.js";
import { select } from "./runners.js";
import { resolveServer } from "./tool-resolution.js";

function diagnosticUriKey(uri: string): string {
	try {
		const path = fileURLToPath(uri);
		// Servers may publish file:///c%3A/... for a document opened as file:///C:/....
		// Normalize URL escaping and Windows drive letters, preserving path case.
		return pathToFileURL(
			process.platform === "win32" ? path.replace(/^[A-Z]:/, (drive) => drive.toLowerCase()) : path,
		).href;
	} catch {
		return uri;
	}
}

class Client extends LspClient {
	serverIdentity(): string {
		return this.server.id;
	}
	private stopping = false;
	private stopTask: Promise<void> | undefined;
	override stop(): Promise<void> {
		if (this.stopTask) return this.stopTask;
		this.stopping = true;
		const proc = this.proc;
		const timer = setTimeout(() => {
			proc?.kill("SIGKILL");
			this.connection?.dispose();
		}, 500);
		this.stopTask = super.stop().finally(() => clearTimeout(timer));
		return this.stopTask;
	}
	private published = new Map<string, { version?: number; items: Diagnostic[]; time: number }>();
	private capabilities: Record<string, unknown> = {};
	private progress = new Set<string>();
	private progressAt = 0;
	supports(operation: string): boolean {
		if (operation === "prepare_rename") {
			const provider = this.capabilities["renameProvider"];
			return record(provider) && provider["prepareProvider"] === true;
		}
		const names: Record<string, string> = {
			definition: "definitionProvider",
			references: "referencesProvider",
			symbols: "documentSymbolProvider",
			prepare_rename: "renameProvider",
			rename: "renameProvider",
			format: "documentFormattingProvider",
		};
		return Boolean(this.capabilities[names[operation] ?? operation]);
	}
	private pulls = new Map<string, { resultId: string; items: Diagnostic[] }>();
	protected override async sendNotification(method: string, params?: unknown): Promise<void> {
		// InitializedParams is an object. Native TypeScript rejects an omitted params
		// field and otherwise leaves subsequent language requests uninitialized.
		await super.sendNotification(method, method === "initialized" ? (params ?? {}) : params);
	}
	protected override async sendRequest<T>(method: string, params?: unknown): Promise<T> {
		if (method === "initialize" && record(params) && record(params["capabilities"])) {
			const capabilities = params["capabilities"];
			capabilities["window"] = { workDoneProgress: true };
			if (record(capabilities["textDocument"])) {
				capabilities["textDocument"]["publishDiagnostics"] = { versionSupport: true };
				capabilities["textDocument"]["diagnostic"] = { dynamicRegistration: false };
			}
		}
		let result: T;
		if (method === "initialize" && this.connection) {
			let timer: NodeJS.Timeout | undefined;
			try {
				result = await Promise.race([
					this.connection.sendRequest<T>(method, params),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() =>
								reject(
									new Error(`LSP initialization/download timeout: ${this.stderrBuffer.slice(-5).join("\n")}`),
								),
							35000,
						);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		} else result = await super.sendRequest<T>(method, params);
		if (method === "initialize" && record(result) && record(result["capabilities"]))
			this.capabilities = result["capabilities"];
		return result;
	}
	async navigation(method: string, path: string, line: number, character: number): Promise<unknown> {
		const capability: Record<string, string> = {
			hover: "hoverProvider",
			typeDefinition: "typeDefinitionProvider",
			implementation: "implementationProvider",
			signatureHelp: "signatureHelpProvider",
		};
		if (!this.capabilities[capability[method] ?? ""]) return { status: "unsupported", operation: method };
		await this.openFile(path);
		return this.sendRequest(`textDocument/${method}`, {
			textDocument: { uri: pathToFileURL(path).href },
			position: { line: line - 1, character },
		});
	}
	private proven = new Set<string>();
	private versions = new Map<string, { version: number; content: string }>();
	override async start(): Promise<void> {
		try {
			const inherited = process.env;
			let starting: Promise<void>;
			try {
				// The pinned transport spawns synchronously before its first await. Restore
				// immediately, so concurrent IPC contexts never observe another request's env.
				process.env = { ...executionEnvironment() };
				starting = super.start();
			} finally {
				process.env = inherited;
			}
			await starting;
		} catch (error) {
			await logEvent("startup-failure");
			throw error;
		}
		void this.proc?.exited.then(() => {
			if (!this.stopping) return logEvent("abnormal-exit");
			return undefined;
		});
		this.connection?.onNotification("$/progress", (value) => {
			if (!record(value) || !record(value["value"])) return;
			const token = String(value["token"]);
			if (value["value"]["kind"] === "end") this.progress.delete(token);
			else this.progress.add(token);
			this.progressAt = Date.now();
		});
		this.connection?.onNotification("textDocument/publishDiagnostics", (value) => {
			if (!record(value) || typeof value["uri"] !== "string" || !Array.isArray(value["diagnostics"])) return;
			const items = value["diagnostics"] as Diagnostic[];
			const version = value["version"];
			this.published.set(
				diagnosticUriKey(value["uri"]),
				typeof version === "number" ? { version, items, time: Date.now() } : { items, time: Date.now() },
			);
		});
	}
	override async openFile(path: string): Promise<void> {
		const uri = pathToFileURL(path).href;
		const content = await readFile(path, "utf8");
		const previous = this.versions.get(uri);
		if (previous?.content === content) return;
		this.published.delete(diagnosticUriKey(uri));
		const version = (previous?.version ?? 0) + 1;
		this.versions.set(uri, { content, version });
		if (previous) {
			await this.sendNotification("textDocument/didChange", {
				textDocument: { uri, version },
				contentChanges: [{ text: content }],
			});
		} else {
			await this.sendNotification("textDocument/didOpen", {
				textDocument: { uri, version, languageId: getLanguageId(extname(path)), text: content },
			});
		}
	}
	async refresh(changes: { path: string; type: number }[]): Promise<void> {
		// Invalidating push results alone leaves unchanged open documents permanently pending
		// on servers that publish only after didOpen/didChange. Close them so the next request
		// synchronizes the final disk contents, including deleted/moved dependencies.
		for (const uri of this.versions.keys())
			await this.sendNotification("textDocument/didClose", { textDocument: { uri } });
		this.versions.clear();
		this.published.clear();
		this.pulls.clear();
		await this.sendNotification("workspace/didChangeWatchedFiles", {
			changes: changes.map(({ path, type }) => ({ uri: pathToFileURL(path).href, type })),
		});
	}
	async collect(
		path: string,
		signal: AbortSignal,
	): Promise<{ items: Diagnostic[]; ready: boolean; evidence?: string }> {
		const uri = pathToFileURL(path).href;
		const cold = !this.versions.has(uri);
		await this.openFile(path);
		await this.sendNotification("textDocument/didSave", { textDocument: { uri } });
		const settling = Date.now() + (cold ? 5000 : 2000);
		while ((this.progress.size || Date.now() - this.progressAt < 200) && Date.now() < settling) {
			signal.throwIfAborted();
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		if (this.progress.size) return { items: [], ready: false };
		if (this.capabilities["diagnosticProvider"]) {
			const previous = this.pulls.get(uri);
			const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, settling - Date.now()))]);
			const result = await new Promise<{ kind: string; items?: Diagnostic[]; resultId?: string }>(
				(resolve, reject) => {
					const abort = () => {
						void this.stop();
						reject(new Error(signal.aborted ? "Diagnostics cancelled" : "Diagnostic request timeout"));
					};
					requestSignal.addEventListener("abort", abort, { once: true });
					if (requestSignal.aborted) {
						abort();
						return;
					}
					void this.sendRequest<{ kind: string; items?: Diagnostic[]; resultId?: string }>(
						"textDocument/diagnostic",
						{ textDocument: { uri }, ...(previous ? { previousResultId: previous.resultId } : {}) },
					)
						.then(resolve, reject)
						.finally(() => requestSignal.removeEventListener("abort", abort));
				},
			);
			if (result.kind === "unchanged" && previous)
				return { items: previous.items, ready: true, evidence: "pull-unchanged" };
			if (Array.isArray(result.items)) {
				if (result.resultId) this.pulls.set(uri, { resultId: result.resultId, items: result.items });
				return { items: result.items, ready: true, evidence: "pull-full" };
			}
			return { items: [], ready: false };
		}
		const deadline = settling;
		while (Date.now() < deadline) {
			signal.throwIfAborted();
			const result = this.published.get(diagnosticUriKey(uri));
			if (
				result &&
				Date.now() - result.time >= 200 &&
				!this.progress.size &&
				Date.now() - this.progressAt >= 200 &&
				(result.version === undefined || result.version === this.versions.get(uri)?.version)
			) {
				if (!(result.version === undefined && result.items.length === 0 && !this.proven.has(uri))) {
					this.proven.add(uri);
					return {
						items: result.items,
						ready: true,
						evidence:
							result.version === undefined ? "push-unversioned (weak freshness evidence)" : "push-versioned",
					};
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		return { items: [], ready: false };
	}
	async formatting(path: string, options: Config["formatting"]): Promise<TextEdit[]> {
		if (!this.supports("format")) throw new Error("unsupported: document formatting");
		await this.openFile(path);
		return (
			(await this.sendRequest<TextEdit[] | null>("textDocument/formatting", {
				textDocument: { uri: pathToFileURL(path).href },
				options,
			})) ?? []
		);
	}
}

export class Languages {
	private manager: LspManager;
	private readonly clients = new Set<Client>();
	private processStarts = 0;
	statistics(): { processStarts: number; running: number } {
		return {
			processStarts: this.processStarts,
			running: [...this.clients].filter((client) => client.isAlive()).length,
		};
	}
	private snapshot = new Map<string, string>();
	async sync(files: Map<string, string>): Promise<void> {
		const changed = [...new Set([...files.keys(), ...this.snapshot.keys()])].filter(
			(path) => files.get(path) !== this.snapshot.get(path),
		);
		const events = changed.map((path) => ({
			path: resolve(this.root, path),
			type: !files.has(path) ? 3 : !this.snapshot.has(path) ? 1 : 2,
		}));
		this.snapshot = new Map(files);
		for (const client of this.clients) {
			if (!client.isAlive()) {
				this.clients.delete(client);
				continue;
			}
			await client.refresh(events);
		}
	}
	constructor(
		private readonly root: string,
		private readonly config: Config,
	) {
		this.manager = new LspManager({
			idleTimeoutMs: 120000,
			clientFactory: (root, server) => {
				if (!inside(this.root, root))
					throw new Error("LSP root outside workspace; choose the enclosing project as workspace");
				this.processStarts++;
				const client = new Client(root, server);
				this.clients.add(client);
				return client;
			},
		});
	}
	private failures = new Map<string, { identity: string; at: number; reason: string }>();
	async status(path: string): Promise<unknown> {
		const resolved = await resolveServer(this.root, path, this.config);
		const failure = this.failures.get(`${resolved.language}:${resolved.tool.identity}`);
		return {
			...resolved,
			lint: this.config.trusted
				? ((await select(this.root, resolve(this.root, path), false, this.config).catch((error) => ({
						unavailable: message(error),
					}))) ?? { unavailable: "No configured lint runner" })
				: { unavailable: "Workspace trust required" },
			running: [...this.clients].some(
				(client) =>
					client.isAlive() &&
					client.serverIdentity() ===
						`${resolved.server.id}:${hash(JSON.stringify([resolved.server, resolved.tool.identity])).slice(0, 16)}`,
			),
			failure:
				failure && failure.identity === resolved.tool.identity && Date.now() - failure.at < 30000
					? failure.reason
					: undefined,
			recovery:
				"Install or repair the selected local tool, then lsp_status refresh=true; failures retry after 30 seconds",
		};
	}
	async preflight(path: string, signal: AbortSignal, operation?: string): Promise<void> {
		await this.withLspClient(
			await workspacePath(this.root, path),
			async (client) => {
				if (operation && client instanceof Client && !client.supports(operation))
					throw new Error(`unsupported: ${operation}`);
			},
			"preflight",
			{
				manager: this.manager,
				signal,
			},
		);
	}
	private async withLspClient<T>(
		path: string,
		fn: (client: LspClient) => Promise<T>,
		_tool: string,
		options: { manager: LspManager; signal: AbortSignal },
	): Promise<T> {
		const resolved = await resolveServer(this.root, path, this.config);
		if (resolved.tool.source === "missing") throw new Error(resolved.tool.note);
		if (resolved.tool.source === "temporary" && !this.config.trusted)
			throw new Error("Temporary tool execution requires workspace trust in Codex user config.toml");
		const failureKey = `${resolved.language}:${resolved.tool.identity}`;
		const failed = this.failures.get(failureKey);
		if (failed && failed.identity === resolved.tool.identity && Date.now() - failed.at < 30000)
			throw new Error(failed.reason);
		let root = await findWorkspaceRoot(path, resolved.server, { signal: options.signal });
		if (!inside(this.root, root)) root = this.root;
		if (
			resolved.language === "python" &&
			resolved.tool.source === "project" &&
			resolved.tool.command[0]?.includes(".venv")
		)
			root = dirname(dirname(dirname(resolved.tool.command[0])));
		resolved.server.id += `:${hash(JSON.stringify([resolved.server, resolved.tool.identity])).slice(0, 16)}`;
		let client: LspClient;
		try {
			client = await measured("startup/acquire", () =>
				options.manager.getClient(root, resolved.server, options.signal),
			);
		} catch (error) {
			for (const [key, failure] of this.failures) if (Date.now() - failure.at >= 30000) this.failures.delete(key);
			this.failures.set(failureKey, {
				identity: resolved.tool.identity,
				at: Date.now(),
				reason:
					(resolved.tool.source === "temporary"
						? "Temporary launch/download or initialization failed: "
						: "Local initialization failed (no fallback): ") + message(error),
			});
			const reason = this.failures.get(failureKey)?.reason;
			while (this.failures.size > 64) this.failures.delete(this.failures.keys().next().value ?? "");
			throw new Error(reason);
		}
		this.failures.delete(failureKey);
		try {
			return await fn(client);
		} finally {
			options.manager.releaseClient(root, resolved.server.id);
		}
	}

	async check(path: string, signal: AbortSignal): Promise<FileResult> {
		try {
			return await this.withLspClient(
				await workspacePath(this.root, path),
				async (client) => {
					if (!(client instanceof Client)) throw new Error("Unexpected LSP client");
					const absolute = await workspacePath(this.root, path);
					const result = await measured("diagnostics/wait", () => client.collect(absolute, signal));
					return {
						path,
						state: result.ready ? "complete" : "pending",
						findings: result.items
							.filter((item) => item.severity === 1 || item.severity === 2)
							.map((item) => ({
								path,
								line: item.range.start.line + 1,
								column: item.range.start.character + 1,
								severity: item.severity === 1 ? ("error" as const) : ("warning" as const),
								source: `${item.source ?? "lsp"}${item.code === undefined ? "" : `/${item.code}`}`,
								message: item.message,
							})),
						note: result.ready ? (result.evidence ?? "fresh diagnostics") : "No fresh diagnostics published yet",
					};
				},
				"diagnostics",
				{ manager: this.manager, signal },
			);
		} catch (error) {
			const note = message(error);
			if (
				/server cancelled|content modified/i.test(note) ||
				(record(error) && [-32801, -32802].includes(Number(error["code"])))
			)
				return { path, state: "pending", findings: [], note: "Server is updating its analysis; retry" };
			if (!/No LSP server|NOT INSTALLED/.test(note))
				await logEvent(/timeout/i.test(note) ? "timeout" : "startup-failure");
			return {
				path,
				state: /disabled or unsupported|Tool missing|Explicit command missing/.test(note) ? "skipped" : "failed",
				findings: [],
				note,
			};
		}
	}
	async navigate(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
		const path = await workspacePath(this.root, text(args["path"]));
		const operation = text(args["operation"]);
		const line = number(args["line"], 1, 1, 10000000);
		const column = number(args["column"], 1, 1, 1000000) - 1;
		const before = operation === "rename" ? await inventory(this.root, 10000, signal) : undefined;
		return this.withLspClient(
			path,
			async (client) => {
				if (
					client instanceof Client &&
					["definition", "references", "symbols", "prepare_rename"].includes(operation) &&
					!client.supports(operation === "symbols" && args["query"] ? "workspaceSymbolProvider" : operation)
				)
					return JSON.stringify({ status: "unsupported", operation });
				let result: unknown;
				switch (operation) {
					case "hover":
					case "typeDefinition":
					case "implementation":
					case "signatureHelp":
						if (!(client instanceof Client)) throw new Error("Unexpected client");
						result = await client.navigation(operation, path, line, column);
						break;
					case "definition":
						result = await client.definition(path, line, column);
						break;
					case "references":
						result = await client.references(path, line, column);
						break;
					case "symbols":
						result = args["query"]
							? await client.workspaceSymbols(text(args["query"]))
							: await client.documentSymbols(path);
						break;
					case "prepare_rename":
						result = await client.prepareRename(path, line, column);
						break;
					case "rename": {
						if (!before?.complete) throw new Error("Cannot safely snapshot workspace for rename");
						const name = text(args["newName"]);
						if (!name) throw new Error("newName required");
						const edit = await client.rename(path, line, column, name);
						return this.applyRename(edit, before.version, signal);
					}
					default:
						throw new Error("Unknown navigation operation");
				}
				const output = JSON.stringify(result ?? []);
				if (output.length <= 8000) return output;
				if (!Array.isArray(result)) return JSON.stringify({ status: "too_large", note: "Narrow query/path" });
				const items: unknown[] = [];
				for (const item of result) {
					if (JSON.stringify([...items, item]).length > 7600) break;
					items.push(item);
				}
				return JSON.stringify({ items, omitted: result.length - items.length, note: "Narrow query/path" });
			},
			operation,
			{ manager: this.manager, signal },
		);
	}
	private async applyRename(edit: WorkspaceEdit | null, version: string, signal: AbortSignal): Promise<string> {
		if (!edit) return "No rename edits";
		const changes = new Map<string, TextEdit[]>();
		for (const [uri, edits] of Object.entries(edit.changes ?? {})) changes.set(uri, edits);
		for (const change of edit.documentChanges ?? []) {
			if ("kind" in change) throw new Error("Resource operations are not permitted by rename");
			if (changes.has(change.textDocument.uri)) throw new Error("Duplicate rename target");
			changes.set(change.textDocument.uri, change.edits);
		}
		const pending = [];
		for (const [uri, edits] of changes) {
			const path = await workspacePath(this.root, fileURLToPath(uri));
			await this.preflight(path, signal);
			const before = await readFile(path, "utf8");
			pending.push({ path, before, after: applyTextChanges(before, edits) });
		}
		if ((await inventory(this.root, 10000, signal)).version !== version)
			throw new Error("Workspace changed during rename; retry");
		for (const item of pending)
			if ((await readFile(item.path, "utf8")) !== item.before) throw new Error("Rename conflict");
		signal.throwIfAborted();
		const modified: string[] = [];
		try {
			for (const item of pending) {
				signal.throwIfAborted();
				await writeFile(item.path, item.after);
				modified.push(relative(this.root, item.path));
			}
		} catch (error) {
			throw new WriteFailure(`${message(error)}; modified paths: ${JSON.stringify(modified)}`, modified);
		}
		return JSON.stringify({
			text: `Renamed: ${modified.join(", ")}`.slice(0, 8000),
			modifiedPaths: modified,
		});
	}
	async format(path: string, signal: AbortSignal): Promise<string> {
		const absolute = await workspacePath(this.root, path);
		const before = await readFile(absolute, "utf8");
		const edits = await this.withLspClient(
			absolute,
			async (client) => {
				if (!(client instanceof Client)) throw new Error("Unexpected LSP client");
				return client.formatting(absolute, this.config.formatting);
			},
			"format",
			{ manager: this.manager, signal },
		);
		const after = applyTextChanges(before, edits);
		if ((await readFile(absolute, "utf8")) !== before) throw new Error("File changed during formatting; retry");
		if (after === before) return `Unchanged: ${path}`;
		signal.throwIfAborted();
		await writeFile(absolute, after);
		return `Formatted: ${path}`;
	}
	async close(): Promise<void> {
		await this.manager.stopAll();
	}
}
