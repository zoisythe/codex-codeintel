import { readFile } from "node:fs/promises";
import { BUDGET } from "./budgets.js";
import { configuration } from "./config.js";
import { configurationImpact } from "./config-files.js";
import { addedFindings, diagnosticKey } from "./diagnostic-delta.js";
import { executionEnvironment } from "./environment.js";
import { hash, inventory, workspacePath } from "./files.js";
import { Metadata } from "./metadata.js";
import type { ProjectChecks } from "./project-checks.js";
import { type FileResult, type Finding, message, record, render, text } from "./results.js";
import { codeLanguage } from "./tool-resolution.js";
import { writeIntent } from "./write-intent.js";

export type HookOutput =
	| { kind: "silent" }
	| { kind: "context"; event: string; context: string }
	| { kind: "deny"; reason: string }
	| { kind: "block"; reason: string };
export function renderHook(output: HookOutput): Record<string, unknown> | undefined {
	if (output.kind === "silent") return undefined;
	if (output.kind === "block") return { decision: "block", reason: output.reason };
	if (output.kind === "deny")
		return {
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: output.reason,
			},
		};
	return output.event === "Stop" || output.event === "SubagentStop" || output.event === "SessionStart"
		? { systemMessage: output.context }
		: { hookSpecificOutput: { hookEventName: output.event, additionalContext: output.context } };
}
export interface HookDependencies {
	projects: Pick<ProjectChecks, "baseline">;
	check(
		paths: string[],
		session: string,
		turn: string,
		generation: number,
		wait: number,
		signal: AbortSignal,
	): Promise<{ generation: number; results: FileResult[]; note: string }>;
	end(session: string): void;
}
export class HookEngine {
	private readonly store: Metadata;
	private queue: Promise<unknown> = Promise.resolve();
	constructor(
		private readonly root: string,
		private readonly dependencies: HookDependencies,
	) {
		this.store = new Metadata(root);
	}
	hook(input: Record<string, unknown>, signal: AbortSignal): Promise<HookOutput> {
		const task = this.queue.then(() => this.execute(input, signal));
		this.queue = task.catch(() => undefined);
		return task;
	}
	private async execute(input: Record<string, unknown>, signal: AbortSignal): Promise<HookOutput> {
		const began = Date.now();
		signal.throwIfAborted();
		const id = text(input["session_id"]);
		const event = text(input["hook_event_name"], "PostToolUse");
		const stopping = event === "Stop" || event === "SubagentStop";
		const context = (value: string): HookOutput => ({ kind: "context", event, context: `session=${id}\n${value}` });
		if (!id)
			return event === "PreToolUse"
				? { kind: "deny", reason: "Codex CodeIntel: missing session_id; cannot establish a pre-edit baseline" }
				: context("Codex CodeIntel: missing session_id");
		if (event === "SessionEnd") {
			await this.store.end(id, signal);
			this.dependencies.end(id);
			return { kind: "silent" };
		}
		if (stopping && input["stop_hook_active"] === true) return { kind: "silent" };
		const initial = await this.store.read(id);
		if (initial.turn === "__ended__" && event !== "SessionStart") return { kind: "silent" };
		const config = await configuration(this.root);
		if (config.automaticDiagnostics.postToolUse === "off" && config.automaticDiagnostics.stop === "off")
			return { kind: "silent" };
		const turn = text(input["turn_id"], initial.turn);
		await this.store.update(id, signal, (state) => {
			if (event === "SessionStart" && state.turn === "__ended__") state.turn = "";
			if (turn !== state.turn) {
				state.turn = turn;
				state.current = [];
				state.blocked = [];
			}
		});
		if (event === "SessionStart" || event === "PreToolUse") {
			const intent = event === "SessionStart" ? { kind: "read" as const } : writeIntent(this.root, input);
			if (intent.kind === "configuration") return { kind: "silent" };
			try {
				const baseline = await this.dependencies.projects.baseline(
					id,
					intent.kind === "write" ? intent.paths : [],
					executionEnvironment(),
					signal,
					intent.kind === "write" ? Math.max(1, BUDGET.postWait - (Date.now() - began)) : 0,
				);
				if (intent.kind === "write" && (baseline.failures.length || baseline.pending.length))
					return {
						kind: "deny",
						reason: `Codex CodeIntel: pre-edit baseline unavailable. ${baseline.failures.join("; ")}${baseline.pending.length ? ` Pending: ${baseline.pending.join(", ")}; retry after check_project run=cached.` : ""} Repair checker configuration or set both automaticDiagnostics modes to off.`,
					};
				if (!initial.baseline) {
					const snapshot = await inventory(this.root, BUDGET.files, signal, config.exclude);
					const reference = await this.store.shared(Object.fromEntries(snapshot.files));
					await this.store.update(id, signal, (state) => {
						state.baseline ??= reference;
					});
				}
				return { kind: "silent" };
			} catch (error) {
				return intent.kind === "write"
					? { kind: "deny", reason: `Codex CodeIntel: pre-edit baseline unavailable: ${message(error)}` }
					: context(`Baseline pending: ${message(error)}`);
			}
		}
		const stateBefore = await this.store.read(id);
		if (!stateBefore.baseline || !stateBefore.diagnosticBaseline) {
			if (event === "PostToolUse" && writeIntent(this.root, input).kind === "write")
				await this.store.update(id, signal, (current) => {
					current.edited = true;
				});
			return context(
				"Pre-edit baseline missing; current diagnostics cannot be treated as an edit baseline. Run SessionStart/PreToolUse before editing, or disable automatic diagnostics.",
			);
		}
		const previous = await this.store.readShared(stateBefore.baseline);
		if (!record(previous)) throw new Error("Invalid shared snapshot");
		const intent = writeIntent(this.root, input);
		const forced = intent.kind === "write" || intent.kind === "configuration" ? (intent.paths ?? []) : [];
		const snapshot = await inventory(this.root, BUDGET.files, signal, config.exclude, this.root, false, forced);
		if (!snapshot.complete)
			return context("Change discovery incomplete; pending and unresolved diagnostics retained");
		const changed = [...snapshot.files].filter(([path, content]) => previous[path] !== content).map(([path]) => path);
		const deleted = Object.keys(previous).filter((path) => !snapshot.files.has(path));
		const sourcePaths = changed.filter((path) => codeLanguage(config, path) && !configurationImpact(path).length);
		const snapshotReference = await this.store.shared(Object.fromEntries(snapshot.files));
		const state = await this.store.update(id, signal, (current) => {
			if (current.generation !== stateBefore.generation) return false;
			if (changed.length || deleted.length) current.generation++;
			if (sourcePaths.length || deleted.some((path) => codeLanguage(config, path))) current.edited = true;
			current.baseline = snapshotReference;
			current.touched = [...new Set([...current.touched, ...sourcePaths])].filter((path) =>
				snapshot.files.has(path),
			);
			current.current = [...new Set([...current.current, ...sourcePaths])].filter((path) =>
				snapshot.files.has(path),
			);
			current.pending = [...new Set([...current.pending, ...sourcePaths])].filter((path) =>
				snapshot.files.has(path),
			);
			current.delivery = [...new Set([...current.delivery, ...sourcePaths])].filter((path) =>
				snapshot.files.has(path),
			);
			for (const path of deleted) {
				const moved = changed.find(
					(next) => snapshot.files.get(next) === previous[path] && previous[next] === undefined,
				);
				if (moved && current.unresolved[path])
					current.unresolved[moved] = current.unresolved[path].map((finding) => ({ ...finding, path: moved }));
				delete current.unresolved[path];
				delete current.shown[path];
			}
			return true;
		});
		if ((stopping ? config.automaticDiagnostics.stop : config.automaticDiagnostics.postToolUse) === "off")
			return { kind: "silent" };
		const paths = stopping
			? [...new Set([...state.current, ...state.pending])]
			: [...new Set([...state.pending, ...state.delivery])];
		if (!paths.length) return { kind: "silent" };
		const output = await this.dependencies.check(
			paths,
			id,
			turn,
			state.generation,
			Math.max(1, (stopping ? BUDGET.stopWait : BUDGET.postWait) - (Date.now() - began)),
			signal,
		);
		if (output.generation !== state.generation) return context("Stale diagnostic generation; pending retained");
		const baselineData = await this.store.readShared(state.diagnosticBaseline ?? "");
		const baseline: Finding[] =
			record(baselineData) && Array.isArray(baselineData["results"])
				? baselineData["results"].flatMap((item: unknown) =>
						record(item) && Array.isArray(item["findings"]) ? (item["findings"] as Finding[]) : [],
					)
				: [];
		const ledgerValue = state.shown["diagnosticCurrent"]
			? await this.store.readShared(state.shown["diagnosticCurrent"])
			: undefined;
		const ledger = record(ledgerValue) ? (ledgerValue as Record<string, Finding[]>) : {};
		for (const old of deleted) {
			const moved = changed.find(
				(path) => snapshot.files.get(path) === previous[old] && previous[path] === undefined,
			);
			if (moved)
				ledger[moved] = (ledger[old] ?? baseline.filter((finding) => finding.path === old)).map((finding) => ({
					...finding,
					path: moved,
				}));
			delete ledger[old];
		}
		const valid: FileResult[] = [];
		for (const result of output.results) {
			try {
				if (
					hash(await readFile(await workspacePath(this.root, result.path), "utf8")) ===
					snapshot.files.get(result.path)
				)
					valid.push(result);
			} catch {
				/* Deleted paths cannot deliver late results. */
			}
		}
		let feedback: HookOutput = { kind: "silent" };
		await this.store.update(id, AbortSignal.timeout(750), (current) => {
			if (current.generation !== state.generation || current.turn !== turn) return false;
			const fresh: FileResult[] = [];
			const repaired: string[] = [];
			for (const result of valid) {
				const preceding = ledger[result.path] ?? baseline.filter((finding) => finding.path === result.path);
				const added = addedFindings(preceding, result.findings);
				const previousIssues = current.unresolved[result.path] ?? [];
				if (result.state === "complete") {
					// Remove already introduced occurrences from the previous complete snapshot.
					// This also prevents a late channel counting the same partial finding twice.
					const historical = addedFindings(previousIssues, preceding);
					current.unresolved[result.path] = addedFindings(historical, result.findings);
					ledger[result.path] = result.findings;
					current.pending = current.pending.filter((path) => path !== result.path);
					current.delivery = current.delivery.filter((path) => path !== result.path);
					if (previousIssues.length > (current.unresolved[result.path]?.length ?? 0))
						repaired.push(
							`${result.path}: ${previousIssues.length - (current.unresolved[result.path]?.length ?? 0)} introduced diagnostics repaired`,
						);
				} else {
					// A late channel cannot clear confirmed errors from the other channel.
					current.unresolved[result.path] = [...previousIssues, ...addedFindings(previousIssues, added)];
				}
				const signature = hash(JSON.stringify(added.map(diagnosticKey)));
				if ((added.length || result.state !== "complete") && current.shown[result.path] !== signature)
					fresh.push({ ...result, findings: added });
				current.shown[result.path] = signature;
			}
			const unresolved = Object.entries(current.unresolved)
				.filter(([path]) => current.current.includes(path))
				.flatMap(([, findings]) => findings)
				.filter((finding) => finding.severity === "error");
			const confirmed = unresolved.filter((finding) =>
				valid.some(
					(result) =>
						result.path === finding.path &&
						result.findings.some((item) => diagnosticKey(item) === diagnosticKey(finding)),
				),
			);
			if (stopping && confirmed.length && !current.blocked.includes(turn || "__turn__")) {
				current.blocked.push(turn || "__turn__");
				feedback = {
					kind: "block",
					reason: `Codex CodeIntel: fix introduced errors before finishing.\n${render([{ path: ".", state: "complete", findings: confirmed }], 15, 3500)}`,
				};
			} else if (fresh.length || repaired.length || (stopping && current.pending.length))
				feedback = context(
					`Automatic delta: introduced=${fresh.flatMap((result) => result.findings).length}; pending=${current.pending.length}\n${fresh.length ? render(fresh, 15, 3500) : ""}${repaired.join("\n")}${output.note ? `\n${output.note}` : ""}`,
				);
			return true;
		});
		const ledgerReference = await this.store.shared(ledger);
		await this.store.update(id, AbortSignal.timeout(750), (current) => {
			if (current.generation !== state.generation || current.turn !== turn) return false;
			current.shown["diagnosticCurrent"] = ledgerReference;
			return true;
		});
		return feedback;
	}
}
