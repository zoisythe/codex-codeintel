import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BUDGET } from "./budgets.js";
import type { Config } from "./config.js";
import { configurationImpact, configurationLanguages } from "./config-files.js";
import { executionEnvironment } from "./environment.js";
import { applyTextChanges, hash, inside, inventory, workspacePath } from "./files.js";
import { logEvent } from "./log.js";
import { LspClient } from "./lsp/client.js";
import { getLanguageId } from "./lsp/language-mappings.js";
import { LspManager } from "./lsp/manager.js";
import type { Diagnostic, TextEdit, WorkspaceEdit } from "./lsp/types.js";
import { findWorkspaceRoot } from "./lsp/workspace-root.js";
import { measured } from "./metrics.js";
import {
	type FileResult,
	type FormatResult,
	message,
	type NavigationResult,
	number,
	record,
	text,
	WriteFailure,
} from "./results.js";
import { lintAvailability, select } from "./runners.js";
import { codeLanguage, resolveServer } from "./tool-resolution.js";

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
	diagnosticsVerified = false;
	workspaceRoot(): string {
		return this.root;
	}
	serverIdentity(): string {
		return this.server.id;
	}
	private stopping = false;
	requestSignal: AbortSignal | undefined;
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
	private serverBusy = false;
	private readonly savedVersions = new Map<string, number>();
	private isRustAnalyzer(): boolean {
		return this.server.command.some((argument) => /rust-analyzer/.test(argument));
	}
	private async settle(deadline: number, signal?: AbortSignal): Promise<boolean> {
		const busy = () => this.serverBusy || this.progress.size > 0 || Date.now() - this.progressAt < BUDGET.lspQuiet;
		while (busy() && Date.now() < deadline) {
			signal?.throwIfAborted();
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		signal?.throwIfAborted();
		return !busy();
	}
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
			capabilities["experimental"] = { serverStatusNotification: true };
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
							BUDGET.lspRequest,
						);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		} else {
			if (!this.connection) throw new Error("LSP client not started");
			const signal = this.requestSignal
				? AbortSignal.any([this.requestSignal, AbortSignal.timeout(BUDGET.lspRequest)])
				: AbortSignal.timeout(BUDGET.lspRequest);
			if (
				this.isRustAnalyzer() &&
				(method.startsWith("textDocument/") || method === "workspace/symbol") &&
				!(await this.settle(Date.now() + BUDGET.lspRequest, signal))
			)
				throw new Error("LSP analysis pending: rust-analyzer is still indexing");
			result = await this.connection.sendRequest<T>(method, params, signal);
		}
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
		this.serverBusy = this.isRustAnalyzer();
		try {
			await super.start();
		} catch (error) {
			await logEvent("startup-failure");
			throw error;
		}
		void this.proc?.exited.then(() => {
			if (!this.stopping) return logEvent("abnormal-exit");
			return undefined;
		});
		this.connection?.onNotification("experimental/serverStatus", (value) => {
			if (!record(value) || typeof value["quiescent"] !== "boolean") return;
			this.serverBusy = !value["quiescent"] || value["health"] === "error";
			this.progressAt = Date.now();
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
	private readonly dirty = new Set<string>();
	override async openFile(path: string): Promise<void> {
		const uri = pathToFileURL(path).href;
		const content = await readFile(path, "utf8");
		const previous = this.versions.get(uri);
		if (previous?.content === content && !this.dirty.has(uri)) return;
		this.dirty.delete(uri);
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
		if (this.isRustAnalyzer()) this.progressAt = Date.now();
	}
	async refresh(changes: { path: string; type: number }[]): Promise<void> {
		changes = changes.filter(
			({ path }) =>
				inside(this.root, path) &&
				(!configurationImpact(path).length || configurationImpact(path).includes("types")) &&
				(this.server.extensions.includes(extname(path)) ||
					configurationLanguages(path).some((language) =>
						this.server.extensions.some(
							(extension) =>
								getLanguageId(extension) === language ||
								(language === "cpp" && ["c", "cpp"].includes(getLanguageId(extension))),
						),
					)),
		);
		if (!changes.length) return;
		// A dependency change invalidates diagnostics for the client's open documents.
		// Re-send their current version on next collection so push-only servers re-analyze.
		for (const uri of this.versions.keys()) {
			this.dirty.add(uri);
			this.published.delete(diagnosticUriKey(uri));
			this.pulls.delete(uri);
		}
		for (const { path, type } of changes) {
			const uri = pathToFileURL(path).href;
			if (type === 3) {
				if (this.versions.has(uri)) await this.sendNotification("textDocument/didClose", { textDocument: { uri } });
				this.versions.delete(uri);
				this.published.delete(diagnosticUriKey(uri));
				this.pulls.delete(uri);
				this.savedVersions.delete(uri);
			} else if (this.versions.has(uri)) await this.openFile(path);
		}

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
		const settling = Date.now() + (cold ? BUDGET.lspCold : BUDGET.lspWarm);
		if (!(await this.settle(settling, signal))) return { items: [], ready: false };
		const version = this.versions.get(uri)?.version;
		if (version !== undefined && this.savedVersions.get(uri) !== version) {
			await this.sendNotification("textDocument/didSave", { textDocument: { uri } });
			this.savedVersions.set(uri, version);
			if (this.isRustAnalyzer()) {
				this.progressAt = Date.now();
				if (!(await this.settle(settling, signal))) return { items: [], ready: false };
			}
		}
		if (this.capabilities["diagnosticProvider"]) {
			const previous = this.pulls.get(uri);
			const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, settling - Date.now()))]);
			if (!this.connection) return { items: [], ready: false };
			const result = await this.connection.sendRequest<{ kind: string; items?: Diagnostic[]; resultId?: string }>(
				"textDocument/diagnostic",
				{ textDocument: { uri }, ...(previous ? { previousResultId: previous.resultId } : {}) },
				requestSignal,
			);
			signal.throwIfAborted();
			if (requestSignal.aborted || Date.now() > settling) return { items: [], ready: false };

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
	async update(config: Config): Promise<void> {
		for (const managed of this.manager.getSnapshot()) {
			if (
				Object.keys(this.config.servers).some((language) => {
					const previous = this.config.servers[language];
					return (
						previous &&
						managed.serverId.startsWith(`${previous.id}:`) &&
						JSON.stringify(previous) !== JSON.stringify(config.servers[language])
					);
				})
			)
				this.manager.invalidateClient(managed.root, managed.serverId);
		}
		this.config = config;
	}
	async invalidate(path: string): Promise<void> {
		const directory = dirname(resolve(this.root, path));
		const language = configurationImpact(path).length
			? undefined
			: (await resolveServer(this.root, path, this.config).catch(() => undefined))?.language;
		const languages = language ? [language] : configurationLanguages(path);
		for (const managed of this.manager.getSnapshot()) {
			if (
				(inside(directory, managed.root) || inside(managed.root, directory)) &&
				languages.some((language) => {
					const server = this.config.servers[language];
					return server && managed.serverId.startsWith(`${server.id}:`);
				})
			)
				this.manager.invalidateClient(managed.root, managed.serverId);
		}
	}

	constructor(
		private readonly root: string,
		private config: Config,
	) {
		this.manager = new LspManager({
			idleTimeoutMs: BUDGET.idle,
			clientFactory: (root, server) => {
				if (!inside(this.root, root))
					throw new Error("LSP root outside workspace; choose the enclosing project as workspace");
				this.processStarts++;
				const client = new Client(root, server, executionEnvironment());
				this.clients.add(client);
				return client;
			},
		});
	}
	private failures = new Map<
		string,
		{ identity: string; root: string; attempts: number; retryAt: number; reason: string }
	>();
	async status(path: string): Promise<unknown> {
		let resolved: Awaited<ReturnType<typeof resolveServer>> | undefined;
		let reason = "";
		try {
			resolved = await resolveServer(this.root, path, this.config);
		} catch (error) {
			reason = message(error);
		}
		const failure = resolved
			? [...this.failures.values()]
					.filter(
						(entry) => entry.identity === resolved?.tool.identity && inside(entry.root, resolve(this.root, path)),
					)
					.sort((a, b) => b.root.length - a.root.length)[0]
			: undefined;
		const identity = resolved
			? `${resolved.server.id}:${hash(JSON.stringify([resolved.server, resolved.tool.identity])).slice(0, 16)}`
			: "";
		const client = [...this.clients].find(
			(client) =>
				client.isAlive() &&
				client.serverIdentity() === identity &&
				inside(client.workspaceRoot(), resolve(this.root, path)),
		);
		let lint: unknown;
		try {
			lint = (await select(this.root, resolve(this.root, path), false, this.config)) ?? {
				unavailable: "Lint disabled or no matching runner",
			};
		} catch (error) {
			lint = { unavailable: message(error) };
		}
		const lintHealth = await lintAvailability(this.root, path, this.config);
		const formatter = await select(this.root, resolve(this.root, path), true, this.config).catch(() => undefined);
		const unavailable = !this.config.valid || !resolved || resolved.tool.source === "missing" || !!failure;
		const status = (operation: string) =>
			unavailable
				? "unavailable"
				: !client
					? "unverified"
					: client.supports(operation)
						? "available"
						: "unsupported";
		return {
			path,
			...resolved,
			language: resolved?.language ?? codeLanguage(this.config, path),
			lint: record(lint) ? { ...lint, verification: lintHealth } : lint,
			capabilities: {
				diagnostics: unavailable ? "unavailable" : client?.diagnosticsVerified ? "available" : "unverified",
				navigation: status("definition"),
				rename: status("rename"),
				formatting: !this.config.valid
					? "unavailable"
					: !this.config.formattingEnabled
						? "disabled"
						: formatter && formatter.name !== "eslint"
							? "unverified"
							: status("format"),
				lint: !this.config.valid || (record(lint) && lint["unavailable"]) ? "unavailable" : lintHealth.state,
			},
			running: !!client,
			verified: !!client,
			failure: !this.config.valid
				? "Configuration error; execution disabled"
				: (failure?.reason ?? (resolved?.tool.source === "missing" ? resolved.tool.note : reason || undefined)),
			retryAt: failure?.retryAt,
			recovery:
				"Use $setup-lsp to configure, install or repair tools; then lsp_status refresh=true. Status does not start or download tools. Existing commands that fail never fall back.",
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
		let root = await findWorkspaceRoot(path, resolved.server, { signal: options.signal });
		if (!inside(this.root, root)) root = this.root;
		if (
			resolved.language === "python" &&
			resolved.tool.source === "project" &&
			resolved.tool.command[0]?.includes(".venv")
		)
			root = dirname(dirname(dirname(resolved.tool.command[0])));
		const failureKey = hash(JSON.stringify([root, resolved.server, resolved.tool.identity]));
		const failed = this.failures.get(failureKey);
		if (failed && Date.now() < failed.retryAt) throw new Error(failed.reason);
		resolved.server.id += `:${hash(JSON.stringify([resolved.server, resolved.tool.identity])).slice(0, 16)}`;
		for (const managed of options.manager.getSnapshot())
			if (
				managed.root === root &&
				managed.serverId.startsWith(`${resolved.server.id.split(":")[0]}:`) &&
				managed.serverId !== resolved.server.id
			)
				options.manager.invalidateClient(managed.root, managed.serverId);
		let client: LspClient;
		try {
			client = await measured("startup/acquire", () =>
				options.manager.getClient(root, resolved.server, options.signal),
			);
		} catch (error) {
			if (options.signal.aborted) throw error;
			const attempts = (failed?.attempts ?? 0) + 1;
			this.failures.set(failureKey, {
				identity: resolved.tool.identity,
				root,
				attempts,
				retryAt: Date.now() + Math.min(300000, 30000 * 2 ** Math.min(attempts - 1, 4)),
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
			if (client instanceof Client) client.requestSignal = options.signal;
			return await fn(client);
		} finally {
			if (client instanceof Client) client.requestSignal = undefined;
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
					client.diagnosticsVerified = result.ready;
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
				/server cancelled|content modified|cancelled|timeout|timed out/i.test(note) ||
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
	async navigate(args: Record<string, unknown>, signal: AbortSignal): Promise<NavigationResult> {
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
					return { status: "unsupported", operation };
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
				if (output.length <= 8000) return { status: "complete", result: result ?? [] };
				if (!Array.isArray(result)) return { status: "too_large", note: "Narrow query/path" };
				const items: unknown[] = [];
				for (const item of result) {
					if (JSON.stringify([...items, item]).length > 7600) break;
					items.push(item);
				}
				return { status: "partial", items, omitted: result.length - items.length };
			},
			operation,
			{ manager: this.manager, signal },
		);
	}
	private async applyRename(
		edit: WorkspaceEdit | null,
		version: string,
		signal: AbortSignal,
	): Promise<NavigationResult> {
		if (!edit) return { status: "unchanged", modifiedPaths: [] };
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
		return { status: "renamed", modifiedPaths: modified };
	}
	async format(path: string, signal: AbortSignal): Promise<FormatResult> {
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
		if (after === before) return { status: "unchanged", path, modifiedPaths: [] };
		signal.throwIfAborted();
		await writeFile(absolute, after);
		return { status: "formatted", path, modifiedPaths: [path] };
	}
	async close(): Promise<void> {
		await this.manager.stopAll();
	}
}
