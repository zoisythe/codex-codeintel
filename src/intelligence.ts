import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Config } from "./config.js";
import { diffLines, EditPlans, type PlannedFile, plannedFile, workspaceEdits } from "./edit-plans.js";
import { applyTextChanges, workspacePath } from "./files.js";
import type { Languages } from "./language.js";
import type { TextEdit, WorkspaceEdit } from "./lsp/types.js";
import { OutputPages } from "./output-pages.js";
import { type PlanValidation, validationResult } from "./plan-validation.js";
import { type Finding, type LintFix, message, record, text } from "./results.js";
import { formatWithRunner, lintBatch, lintDirectory, run, select } from "./runners.js";
import { contains, locations, outline, position, publicNavigation, publicOutline, sourceRange } from "./symbols.js";

interface Action {
	id: string;
	identity: string;
	path: string;
	title: string;
	source: string;
	applicability: LintFix["applicability"];
	rule?: string;
	edits?: TextEdit[];
	before?: string;
	after?: string;
	lsp?: Record<string, unknown>;
	finding?: Finding;
	unsupported?: string;
	scope: string[];
}
function problem(error: unknown): Record<string, unknown> {
	const reason = message(error);
	return {
		status: /unsupported/i.test(reason)
			? "unsupported"
			: /timeout|cancel|pending/i.test(reason)
				? "pending"
				: "failed",
		reason,
	};
}
function isTest(path: string): boolean {
	return /(?:^|[\\/])(?:test[^\\/]*|__tests__)(?:[\\/]|$)|(?:_test|\.test|\.spec)\.[^\\/]+$/.test(path);
}
async function mapBounded<T, R>(values: T[], fn: (value: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(values.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(4, values.length) }, async () => {
			while (next < values.length) {
				const index = next++;
				const value = values[index];
				if (value !== undefined) results[index] = await fn(value);
			}
		}),
	);
	return results;
}
export class Intelligence {
	readonly plans = new EditPlans();
	readonly pages = new OutputPages("detail:");
	private readonly actions = new Map<string, Action>();
	private scope: string[] = [];
	constructor(
		private readonly root: string,
		private readonly language: Languages,
	) {}
	clear(): void {
		this.plans.clear();
		this.pages.clear();
		this.actions.clear();
	}
	pageArguments(args: Record<string, unknown>): Record<string, unknown> {
		return { ...this.pages.arguments(text(args["cursor"])), ...args };
	}
	planPaths(id: string): string[] {
		return this.plans.get(id).paths;
	}
	actionPaths(ids: unknown): string[] {
		return Array.isArray(ids) ? [...new Set(ids.flatMap((id) => this.actions.get(String(id))?.scope ?? []))] : [];
	}
	private remember(action: Omit<Action, "id" | "scope">): Action {
		const value = { ...action, scope: [...this.scope], id: randomUUID() };
		this.actions.set(value.id, value);
		while (this.actions.size > 512) this.actions.delete(this.actions.keys().next().value ?? "");
		return value;
	}
	private async preview(
		identity: string,
		files: PlannedFile[],
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<Record<string, unknown>> {
		const plan = this.plans.create(identity, files, this.scope);
		let validation: PlanValidation;
		try {
			validation =
				args["validate"] === false
					? validationResult(
							"skipped",
							plan.files.map((file) => file.path),
							"Validation explicitly disabled",
						)
					: await this.language.validatePlan(
							plan.files,
							signal,
							Array.isArray(args["validationPaths"])
								? args["validationPaths"].filter((path): path is string => typeof path === "string")
								: [],
						);
		} catch (error) {
			this.plans.discard(plan.id);
			throw error;
		}
		return {
			status: plan.files.length ? "planned" : "unchanged",
			plan: plan.id,
			createdAt: plan.createdAt,
			expiresAt: plan.expiresAt,
			storage: plan.storage,
			files: plan.files.map((file) => file.path),
			diff: plan.files.flatMap(diffLines),
			validation,
			note: "Only apply writes this single-use plan. Validation is scoped evidence, not a build or behavior guarantee; restart or eviction may invalidate it before expiry.",
		};
	}
	async execute(
		operation: string,
		args: Record<string, unknown>,
		paths: string[],
		config: Config,
		identity: string,
		signal: AbortSignal,
		bindings = paths,
	): Promise<Record<string, unknown>> {
		this.scope = bindings;
		if (args["cursor"]) return this.pages.read(args, identity, operation);
		let output: Record<string, unknown>;
		if (operation === "navigate") output = await this.language.navigate(args, signal);
		else if (operation === "rename") {
			const edit = await this.language.renameEdit(args, signal);
			output = await this.preview(identity, await workspaceEdits(this.root, edit), args, signal);
		} else if (operation === "format") {
			if (!config.formattingEnabled) throw new Error("Configuration error: formatting disabled");
			const files: PlannedFile[] = [];
			for (const path of paths) {
				signal.throwIfAborted();
				const formatted = await formatWithRunner(this.root, path, signal, config);
				const absolute = await workspacePath(this.root, path);
				const before = formatted?.before ?? (await readFile(absolute, "utf8"));
				const after = formatted?.after ?? applyTextChanges(before, await this.language.formatEdits(path, signal));
				files.push(await plannedFile(this.root, path, after, before));
			}
			output = await this.preview(identity, files, args, signal);
		} else if (operation === "inspect")
			output =
				args["operation"] === "impact" ? await this.impact(args, paths, signal) : await this.inspect(args, signal);
		else if (operation === "actions") output = await this.actionRequest(args, paths, config, identity, signal);
		else throw new Error("Unknown intelligence operation");
		if (operation === "navigate" || operation === "inspect")
			output = publicNavigation(output, this.root) as Record<string, unknown>;
		return this.pages.write({ ...output, operation }, args, identity);
	}
	private async inspect(args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
		const path = text(args["path"]);
		const absolute = await workspacePath(this.root, path);
		let symbols: ReturnType<typeof outline> = [];
		let outlineIssue: Record<string, unknown> | undefined;
		try {
			symbols = outline(await this.language.documentSymbols(path, signal));
		} catch (error) {
			outlineIssue = problem(error);
			if (args["symbol"]) return { status: "partial", path, sections: { outline: outlineIssue } };
		}
		const point = await position(absolute, args, async () => symbols);
		const at = { path, line: point.line, column: point.column };
		const parts = await mapBounded(
			["hover", "definition", "references", "incoming", "outgoing"],
			async (operation) => {
				try {
					const result = await this.language.navigate({ ...at, operation }, signal);
					if (operation === "references" && result["status"] === "complete") {
						const refs = locations(result["result"]);
						return [
							operation,
							{
								status: "complete",
								count: refs.length,
								files: [...new Set(refs.map((ref) => this.localPath(ref.uri)))],
								sample: refs
									.slice(0, 5)
									.map((ref) => ({ path: this.localPath(ref.uri), line: ref.range.start.line + 1 })),
							},
						] as const;
					}
					return [operation, result] as const;
				} catch (error) {
					return [operation, problem(error)] as const;
				}
			},
		);
		const sections = Object.fromEntries(parts);
		if (outlineIssue) sections["outline"] = outlineIssue;
		const enclosing = symbols
			.filter((item) => contains(item.range, point.line - 1, point.column - 1))
			.sort((a, b) => a.range.end.line - a.range.start.line - (b.range.end.line - b.range.start.line))[0];
		return {
			status: Object.values(sections).every((value) => value["status"] === "complete") ? "complete" : "partial",
			path,
			...(enclosing ? { symbol: publicOutline(enclosing) } : {}),
			sections,
			...(args["source"] === true && enclosing
				? {
						source: sourceRange(await readFile(absolute, "utf8"), enclosing.range),
					}
				: {}),
		};
	}
	private localPath(uri: string): string {
		try {
			return relative(this.root, fileURLToPath(uri));
		} catch {
			return uri;
		}
	}
	private async impact(
		args: Record<string, unknown>,
		paths: string[],
		signal: AbortSignal,
	): Promise<Record<string, unknown>> {
		const targets: { path: string; symbol: string; line: number; column: number }[] = [];
		const issues: Record<string, unknown>[] = [];
		if (
			Array.isArray(args["symbols"]) &&
			["symbol", "pattern", "line", "column"].some((key) => args[key] !== undefined)
		)
			throw new Error("Use symbols or one position selector");
		for (const path of paths) {
			try {
				const symbols = outline(await this.language.documentSymbols(path, signal));
				if (Array.isArray(args["symbols"])) {
					for (const symbol of args["symbols"]) {
						try {
							targets.push({
								path,
								symbol: String(symbol),
								...(await position(await workspacePath(this.root, path), { symbol }, async () => symbols)),
							});
						} catch (error) {
							issues.push({ path, symbol, ...problem(error) });
						}
					}
					continue;
				}
				const selected =
					args["symbol"] || args["pattern"] || args["line"]
						? [await position(await workspacePath(this.root, path), args, async () => symbols)]
						: symbols
								.filter(
									(item) =>
										[5, 6, 9, 10, 11, 12, 23].includes(item.kind) &&
										(!item.parent ||
											!symbols.some(
												(parent) => parent.symbol === item.parent && [6, 9, 12].includes(parent.kind),
											)),
								)
								.map((item) => ({
									line: item.selection.start.line + 1,
									column: item.selection.start.character + 1,
									symbol: item.symbol,
								}));
				for (const point of selected)
					targets.push({
						path,
						symbol: "symbol" in point ? String(point.symbol) : text(args["symbol"], "selected"),
						line: point.line,
						column: point.column,
					});
			} catch (error) {
				issues.push({ path, ...problem(error) });
			}
		}
		const analyze = async (target: { path: string; symbol: string; line: number; column: number }) => {
			const query = async (operation: string) => {
				try {
					return await this.language.navigate(
						{ path: target.path, line: target.line, column: target.column, operation },
						signal,
					);
				} catch (error) {
					return problem(error);
				}
			};
			const [references, incoming] = await Promise.all([query("references"), query("incoming")]);
			const refs = locations(references["result"]);
			const callers: { path: string; symbol: string; line: number; column: number }[] = [];
			if (Array.isArray(incoming["result"]))
				for (const call of incoming["result"]) {
					if (!record(call) || !record(call["from"])) continue;
					const from = call["from"];
					const location = locations({ uri: from["uri"], range: from["selectionRange"] ?? from["range"] })[0];
					if (location)
						callers.push({
							path: this.localPath(location.uri),
							symbol: text(from["name"]),
							line: location.range.start.line + 1,
							column: location.range.start.character + 1,
						});
				}
			return {
				...target,
				status: references["status"] === "complete" && incoming["status"] === "complete" ? "complete" : "partial",
				references:
					references["status"] === "complete"
						? {
								status: "complete",
								count: refs.length,
								files: [...new Set(refs.map((ref) => this.localPath(ref.uri)))],
							}
						: references,
				callers: incoming["status"] === "complete" ? { status: "complete", items: callers } : incoming,
				candidateTests:
					references["status"] === "complete"
						? {
								status: "complete",
								paths: [...new Set(refs.map((ref) => this.localPath(ref.uri)).filter(isTest))],
							}
						: { status: references["status"], reason: references["reason"] },
			};
		};
		const results = await mapBounded(targets.slice(0, 200), analyze);
		const direct = new Map<string, { path: string; symbol: string; line: number; column: number }>();
		if (args["transitive"] === true)
			for (const item of results) {
				const callers = item.callers["items"];
				if (!Array.isArray(callers)) continue;
				for (const caller of callers) {
					if (
						!record(caller) ||
						typeof caller["path"] !== "string" ||
						typeof caller["line"] !== "number" ||
						typeof caller["column"] !== "number"
					)
						continue;
					const point = {
						path: caller["path"],
						symbol: text(caller["symbol"]),
						line: caller["line"],
						column: caller["column"],
					};
					direct.set(JSON.stringify(point), point);
				}
			}
		if (direct.size > 100)
			issues.push({ status: "partial", reason: "Indirect relationship budget exceeded; narrow files or symbols" });
		const indirect = await mapBounded([...direct.values()].slice(0, 100), analyze);
		if (targets.length > 200)
			issues.push({ status: "partial", reason: "Symbol budget exceeded; narrow files or symbols" });
		return {
			status:
				issues.length ||
				results.some((item) => (item as Record<string, unknown>)["status"] !== "complete") ||
				indirect.some((item) => item["status"] !== "complete")
					? "partial"
					: "complete",
			symbols: results,
			indirect,
			issues,
			note: "Candidate tests are inferred from names and references, not runtime coverage. Zero references does not prove safe deletion.",
		};
	}
	private async actionRequest(
		args: Record<string, unknown>,
		paths: string[],
		config: Config,
		identity: string,
		signal: AbortSignal,
	): Promise<Record<string, unknown>> {
		const operation = text(args["operation"], "list");
		if (operation === "explain") {
			const path = paths[0] ?? "";
			const rule = text(args["rule"]);
			if (!rule) throw new Error("rule required for explain");
			const cwd = await lintDirectory(this.root, await workspacePath(this.root, path));
			const runner = await select(this.root, resolve(this.root, path), false, config, false, signal);
			if (!runner) return { status: "unsupported", reason: "No lint runner configured for this file" };
			let output = "";
			let settings: unknown;
			if (runner.name === "ruff") {
				const explained = await run(runner.command, [...runner.prefix, "rule", rule], cwd, signal);
				if (explained.code !== 0) throw new Error(explained.stderr);
				output = explained.stdout;
				const effective = await run(
					runner.command,
					[...runner.prefix, "check", "--show-settings", resolve(this.root, path)],
					cwd,
					signal,
				);
				settings = effective.code === 0 ? effective.stdout : "unknown";
			} else if (runner.name === "biome") {
				const explained = await run(
					runner.command,
					[...runner.prefix, "explain", rule.split("/").at(-1) ?? rule],
					cwd,
					signal,
				);
				if (explained.code !== 0) throw new Error(explained.stderr);
				output = explained.stdout;
				settings =
					"Effective rule/ignore origin is not exposed by this runner; inspect the existing project configuration";
			} else {
				const effective = await run(
					runner.command,
					[...runner.prefix, "--print-config", resolve(this.root, path)],
					cwd,
					signal,
				);
				if (effective.code !== 0) throw new Error(effective.stderr);
				const parsed: unknown = JSON.parse(effective.stdout || "null");
				settings =
					record(parsed) && record(parsed["rules"])
						? (parsed["rules"][rule] ?? "unknown")
						: "File ignored or no matching configuration";
				const metadata = await run(
					runner.command,
					[...runner.prefix, "--format", "json-with-metadata", resolve(this.root, path)],
					cwd,
					signal,
				);
				const report: unknown = JSON.parse(metadata.stdout || "null");
				const rules =
					record(report) && record(report["metadata"]) && record(report["metadata"]["rulesMeta"])
						? report["metadata"]["rulesMeta"]
						: {};
				const ruleMetadata = rules[rule];
				const docs = record(ruleMetadata) && record(ruleMetadata["docs"]) ? ruleMetadata["docs"] : {};
				output =
					text(docs["description"], "Installed rule metadata unavailable") +
					(docs["url"] ? `\n${String(docs["url"])}` : "") +
					"\nConfiguration source origin is unknown.";
			}
			return {
				status: "complete",
				runner: runner.name,
				rule,
				explanation: output,
				...(args["details"] === true
					? { effective: settings }
					: {
							effective:
								typeof settings === "string" && settings.length > 500
									? "Available with details=true"
									: settings,
						}),
			};
		}
		if (operation === "preview") {
			const ids = Array.isArray(args["ids"]) ? args["ids"].filter((id): id is string => typeof id === "string") : [];
			let issues: unknown[] = [];
			if (!ids.length) {
				const listed = await this.listActions(args, paths, config, identity, signal);
				issues = Array.isArray(listed["issues"]) ? listed["issues"] : [];
				const fresh = Array.isArray(listed["items"]) ? listed["items"] : [];
				ids.push(
					...fresh
						.filter(
							(item) => record(item) && item["applicability"] === "safe" && item["status"] !== "unsupported",
						)
						.map((item) => (record(item) ? text(item["id"]) : "")),
				);
			}
			const grouped = new Map<string, { edits: TextEdit[]; before: string; after?: string }>();
			for (const id of [...new Set(ids)]) {
				const action = this.actions.get(id);
				if (!action || action.identity !== identity) throw new Error("Action stale or missing; list actions again");
				if (action.unsupported) throw new Error(`unsupported: ${action.unsupported}`);
				if (action.lsp) {
					let raw = action.lsp;
					if (!raw["edit"]) {
						const resolved = await this.language.request(action.path, "codeAction/resolve", raw, signal);
						if (!record(resolved) || resolved["status"] === "unsupported")
							throw new Error("unsupported: unresolved Code Action");
						raw = resolved;
					}
					if (raw["command"] || raw["disabled"] || !record(raw["edit"]))
						throw new Error("unsupported: command, disabled action or missing text edit");
					const edit = raw["edit"] as unknown as WorkspaceEdit;
					await workspaceEdits(this.root, edit);
					const changes = { ...edit.changes };
					for (const change of edit.documentChanges ?? []) {
						if ("kind" in change) throw new Error("unsupported: resource operation");
						changes[change.textDocument.uri] = change.edits;
					}
					for (const [uri, edits] of Object.entries(changes))
						await this.addEdits(grouped, fileURLToPath(uri), edits);
				} else if (action.after !== undefined && action.before !== undefined) {
					if (grouped.has(action.path)) throw new Error("Overlapping action targets; select one file-level fix");
					grouped.set(action.path, { edits: [], before: action.before, after: action.after });
				} else await this.addEdits(grouped, action.path, action.edits ?? []);
			}
			const files: PlannedFile[] = [];
			for (const [path, group] of grouped)
				files.push(
					await plannedFile(
						this.root,
						path,
						group.after ?? applyTextChanges(group.before, group.edits),
						group.before,
					),
				);
			return {
				...(await this.preview(identity, files, args, signal)),
				...(issues.length ? { partial: true, issues } : {}),
			};
		}
		return this.listActions(args, paths, config, identity, signal);
	}
	private async addEdits(
		groups: Map<string, { edits: TextEdit[]; before: string; after?: string }>,
		path: string,
		edits: TextEdit[],
	): Promise<void> {
		path = relative(this.root, await workspacePath(this.root, path));
		const group = groups.get(path) ?? { edits: [], before: await readFile(resolve(this.root, path), "utf8") };
		if (group.after !== undefined) throw new Error("Overlapping action targets");
		group.edits.push(...edits);
		groups.set(path, group);
	}
	private async listActions(
		args: Record<string, unknown>,
		paths: string[],
		config: Config,
		identity: string,
		signal: AbortSignal,
	): Promise<Record<string, unknown>> {
		const items: Record<string, unknown>[] = [];
		const issues: Record<string, unknown>[] = [];
		const add = (action: Omit<Action, "id" | "scope">) => {
			const value = this.remember(action);
			items.push({
				id: value.id,
				path: value.path,
				title: value.title,
				source: value.source,
				applicability: value.applicability,
				...(value.rule ? { rule: value.rule } : {}),
				...(value.unsupported ? { status: "unsupported", reason: value.unsupported } : {}),
			});
		};
		if (args["source"] !== "lsp") {
			const results = await lintBatch(this.root, paths, signal, config, false);
			for (const [path, result] of results) {
				if (result.state !== "complete") {
					issues.push({ path, source: "lint", status: result.state, reason: result.note });
					continue;
				}
				for (const finding of result.findings)
					if (!args["rule"] || finding.rule === args["rule"])
						for (const fix of finding.lint?.fixes ?? [])
							add({
								identity,
								path,
								title: fix.title,
								source: finding.lint?.runner ?? "lint",
								applicability: fix.applicability,
								edits: fix.edits,
								finding,
								...(finding.rule ? { rule: finding.rule } : {}),
							});
				const runner = await select(this.root, resolve(this.root, path), false, config, false, signal);
				if (
					runner?.name === "biome" &&
					(!args["rule"] || result.findings.some((finding) => finding.rule === args["rule"]))
				) {
					const before = await readFile(resolve(this.root, path), "utf8");
					const cwd = await lintDirectory(this.root, resolve(this.root, path));
					let safeAfter: string | undefined;
					for (const unsafe of [false, true]) {
						const output = await run(
							runner.command,
							[
								...runner.prefix,
								"lint",
								"--write",
								...(unsafe ? ["--unsafe"] : []),
								...(args["rule"] ? [`--only=${text(args["rule"]).replace(/^lint\//, "")}`] : []),
								`--stdin-file-path=${resolve(this.root, path)}`,
							],
							cwd,
							signal,
							before,
						);
						if (![0, 1].includes(output.code)) {
							issues.push({ path, status: "failed", reason: output.stderr });
							continue;
						}
						if (unsafe && output.stdout === safeAfter) continue;
						if (!unsafe) safeAfter = output.stdout;
						if (output.stdout && output.stdout !== before)
							add({
								identity,
								path,
								title: unsafe ? "Biome file fixes including unsafe changes" : "Biome safe file fixes",
								source: "biome",
								...(args["rule"] ? { rule: text(args["rule"]) } : {}),
								applicability: unsafe ? "unsafe" : "safe",
								before,
								after: output.stdout,
							});
					}
				}
			}
		}
		if (args["source"] !== "lint")
			for (const path of paths) {
				try {
					const absolute = await workspacePath(this.root, path);
					const content = await readFile(absolute, "utf8");
					const at = await position(absolute, args, async () =>
						outline(await this.language.documentSymbols(path, signal)),
					);
					const range =
						args["line"] || args["symbol"] || args["pattern"]
							? {
									start: { line: at.line - 1, character: at.column - 1 },
									end: { line: at.line - 1, character: at.column - 1 },
								}
							: {
									start: { line: 0, character: 0 },
									end: {
										line: content.split("\n").length - 1,
										character: content.split("\n").at(-1)?.length ?? 0,
									},
								};
					const response = await this.language.request(
						path,
						"textDocument/codeAction",
						{ textDocument: { uri: pathToFileURL(absolute).href }, range, context: { diagnostics: [] } },
						signal,
					);
					if (record(response) && response["status"] === "pending")
						issues.push({
							path,
							source: "lsp",
							status: "pending",
							reason: "Diagnostics still pending; action list may be incomplete",
						});
					const raw = record(response) && "result" in response ? response["result"] : response;
					if (record(raw) && raw["status"] === "unsupported")
						issues.push({ path, source: "lsp", status: "unsupported" });
					if (Array.isArray(raw))
						for (const action of raw)
							if (record(action)) {
								const edit = record(action["edit"]) ? action["edit"] : {};
								const resources =
									Array.isArray(edit["documentChanges"]) &&
									edit["documentChanges"].some((change) => record(change) && "kind" in change);
								add({
									identity,
									path,
									title: text(action["title"], "Code Action"),
									source: "lsp",
									applicability: "unknown",
									lsp: action,
									...(action["command"] || action["disabled"] || resources
										? { unsupported: "Command, disabled or resource action" }
										: {}),
								});
							}
				} catch (error) {
					issues.push({ path, source: "lsp", ...problem(error) });
				}
			}
		return { status: issues.length ? "partial" : "complete", items, issues };
	}
}
