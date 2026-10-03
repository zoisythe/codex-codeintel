import { readFile } from "node:fs/promises";
import { BUDGET } from "./budgets.js";
import { configuration } from "./config.js";
import { configurationImpact } from "./config-files.js";
import { addedFindings, attributableFinding, diagnosticKey } from "./diagnostic-delta.js";
import { executionEnvironment } from "./environment.js";
import { hash, inventory, workspacePath } from "./files.js";
import { queueDelivery } from "./hook-delivery.js";
import { analysisIdentity } from "./identity.js";
import { Metadata } from "./metadata.js";
import type { ProjectChecks } from "./project-checks.js";
import { type FileResult, type Finding, message, record, render, text } from "./results.js";
import { codeLanguage } from "./tool-resolution.js";
import { writeIntent } from "./write-intent.js";

export type HookOutput =
	| { kind: "silent" }
	| { kind: "context"; event: string; context: string; configuration?: string }
	| { kind: "block"; reason: string };
export function renderHook(output: HookOutput): Record<string, unknown> | undefined {
	if (output.kind === "silent") return undefined;
	if (output.kind === "block") return { decision: "block", reason: output.reason };
	return output.event === "Stop" || output.event === "SubagentStop" || output.event === "SessionStart"
		? { systemMessage: output.context }
		: { hookSpecificOutput: { hookEventName: output.event, additionalContext: output.context } };
}
export interface HookDependencies {
	projects: Pick<ProjectChecks, "baseline" | "introduced">;
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
	hook(input: Record<string, unknown>, signal: AbortSignal, background = false): Promise<HookOutput> {
		const event = text(input["hook_event_name"], "PostToolUse");
		if (event === "PreToolUse") return Promise.resolve({ kind: "silent" });
		const task =
			event === "SessionEnd"
				? this.prepare(input, signal, background)
				: this.queue.then(() => this.prepare(input, signal, background));
		// Analysis awaits live outside this discovery/state queue.
		this.queue = task.then(
			() => undefined,
			() => undefined,
		);
		return task.then(async (prepared) => {
			if (typeof prepared === "function") return prepared();
			if (prepared.kind === "context" && text(input["session_id"])) {
				const config = await configuration(this.root);
				if (prepared.configuration && prepared.configuration !== config.version) return { kind: "silent" };
				await this.store.update(text(input["session_id"]), signal, async (state) => {
					if (state.turn === "__ended__") return false;
					await queueDelivery(this.store, state, prepared, {}, config.version, "");
					return true;
				});
			}
			return prepared;
		});
	}
	private async prepare(
		input: Record<string, unknown>,
		signal: AbortSignal,
		background: boolean,
	): Promise<HookOutput | (() => Promise<HookOutput>)> {
		const began = Date.now();
		signal.throwIfAborted();
		const id = text(input["session_id"]);
		const event = text(input["hook_event_name"], "PostToolUse");
		const stopping = event === "Stop" || event === "SubagentStop";
		const context = (value: string): HookOutput => ({
			kind: "context",
			event,
			context: `session=${id}\n${value}`,
			configuration: config.version,
		});
		if (!id) return { kind: "silent" };
		if (event === "SessionEnd") {
			await this.store.end(id, signal);
			this.dependencies.end(id);
			return { kind: "silent" };
		}
		if (stopping && input["stop_hook_active"] === true) return { kind: "silent" };
		const initial = await this.store.read(id);
		if (initial.turn === "__ended__" && event !== "SessionStart") return { kind: "silent" };
		const config = await configuration(this.root);
		if (initial.configuration && initial.configuration !== config.version) {
			this.dependencies.end(id);
			await this.store.update(id, signal, (state) => {
				state.generation++;
				state.diagnosticBaseline = null;
				state.unresolved = {};
				state.shown = {};
				state.outbox = {};
				state.configuration = config.version;
			});
		}
		if (config.automaticDiagnostics.postToolUse === "off" && config.automaticDiagnostics.stop === "off")
			return { kind: "silent" };
		const turn = text(input["turn_id"], initial.turn);
		await this.store.update(id, signal, (state) => {
			if (state.epoch !== initial.epoch || (state.turn === "__ended__" && event !== "SessionStart")) return false;
			if (event === "SessionStart" && state.turn === "__ended__") state.turn = "";
			state.configuration = config.version;
			if (turn !== state.turn) {
				state.turn = turn;
				state.current = [];
				state.blocked = [];
			}
			return true;
		});
		if (event === "SessionStart") {
			try {
				const snapshot = await inventory(this.root, BUDGET.files, signal, config.exclude);
				if (!snapshot.complete)
					return context("Baseline inventory incomplete; current diagnostics cannot be attributed");
				const reference = await this.store.shared(Object.fromEntries(snapshot.files));
				await this.store.update(id, signal, (state) => {
					if (state.epoch !== initial.epoch || state.turn === "__ended__") return false;
					state.baseline ??= reference;
					return true;
				});
				await this.dependencies.projects.baseline(id, undefined, executionEnvironment(), signal, 0);
				return { kind: "silent" };
			} catch (error) {
				return context(`Baseline unavailable; current diagnostics cannot be attributed: ${message(error)}`);
			}
		}
		const stateBefore = await this.store.read(id);
		const previous = stateBefore.baseline ? await this.store.readShared(stateBefore.baseline) : {};
		if (!record(previous)) throw new Error("Invalid shared snapshot");
		const intent = writeIntent(this.root, input);
		const forced = intent.kind === "write" || intent.kind === "configuration" ? (intent.paths ?? []) : [];
		const snapshot = await inventory(this.root, BUDGET.files, signal, config.exclude, this.root, false, forced);
		if (!snapshot.complete)
			return context("Change discovery incomplete; pending and unresolved diagnostics retained");
		const changed = [...snapshot.files].filter(([path, content]) => previous[path] !== content).map(([path]) => path);
		const deleted = Object.keys(previous).filter((path) => !snapshot.files.has(path));
		const sourcePaths = [...new Set([...changed, ...forced])].filter(
			(path) => snapshot.files.has(path) && codeLanguage(config, path) && !configurationImpact(path).length,
		);
		const snapshotReference = await this.store.shared(Object.fromEntries(snapshot.files));
		const state = await this.store.update(id, signal, (current) => {
			if (current.generation !== stateBefore.generation || current.epoch !== stateBefore.epoch) return false;
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
		let reliable: Awaited<ReturnType<HookDependencies["projects"]["baseline"]>>;
		try {
			reliable = await this.dependencies.projects.baseline(id, paths, executionEnvironment(), signal, 0);
		} catch (error) {
			reliable = { reference: "", findings: [], reliable: {}, covered: [], failures: [message(error)], pending: [] };
		}
		state.diagnosticBaseline = reliable.reference || null;
		const snapshotAnalysis = await analysisIdentity(this.root, paths, config, signal);
		return async () => {
			const output = await this.dependencies.check(
				paths,
				id,
				turn,
				state.generation,
				Math.max(
					1,
					(background ? BUDGET.project : stopping ? BUDGET.stopWait : BUDGET.postWait) - (Date.now() - began),
				),
				signal,
			);
			if (output.generation !== state.generation) return context("Stale diagnostic generation; pending retained");
			const baselineData = state.diagnosticBaseline
				? await this.store.readShared(state.diagnosticBaseline)
				: undefined;
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
			let gateFindings: Finding[] = [];
			if (stopping && config.stopGate === "introduced-errors" && reliable.covered.length) {
				try {
					gateFindings = await this.dependencies.projects.introduced(
						id,
						paths,
						executionEnvironment(),
						signal,
						Math.max(0, BUDGET.stopWait - (Date.now() - began)),
					);
				} catch {
					/* Uncertain project confirmation cannot block completion. */
				}
			}
			if ((await analysisIdentity(this.root, paths, await configuration(this.root), signal)) !== snapshotAnalysis)
				return { kind: "silent" };
			for (let index = valid.length - 1; index >= 0; index--) {
				const result = valid[index];
				if (!result) continue;
				const content = await readFile(await workspacePath(this.root, result.path), "utf8").catch(() => "");
				if (hash(content) !== snapshot.files.get(result.path)) valid.splice(index, 1);
			}
			if ((await configuration(this.root)).version !== config.version)
				return context("Configuration changed; diagnostic results stale");
			let feedback: HookOutput = { kind: "silent" };
			const bindings = Object.fromEntries(
				valid.map((result) => [result.path, snapshot.files.get(result.path) ?? ""]),
			);
			const analysis = valid.length
				? await analysisIdentity(
						this.root,
						valid.map((result) => result.path),
						config,
						signal,
					)
				: "";
			await this.store.update(id, signal, async (current) => {
				if (current.generation !== state.generation || current.epoch !== state.epoch) return false;
				const fresh: FileResult[] = [];
				const repaired: string[] = [];
				let unattributed = 0;
				let introduced = 0;
				for (const result of valid) {
					const parsers = reliable.reliable[result.path] ?? [];
					const attributable = result.findings.filter((finding) =>
						attributableFinding(finding, parsers, baseline),
					);
					const unknown = result.findings.filter((finding) => !attributable.includes(finding));
					const preceding =
						ledger[result.path] ??
						baseline.filter(
							(finding) => finding.path === result.path && attributableFinding(finding, parsers, baseline),
						);
					const added = addedFindings(preceding, attributable);
					const previousIssues = current.unresolved[result.path] ?? [];
					if (result.state === "complete") {
						// Remove already introduced occurrences from the previous complete snapshot.
						// This also prevents a late channel counting the same partial finding twice.
						const historical = addedFindings(previousIssues, preceding);
						current.unresolved[result.path] = addedFindings(historical, attributable);
						ledger[result.path] = attributable;
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
					const reported = [...added, ...unknown];
					const signature = hash(
						JSON.stringify([reported.map(diagnosticKey), result.state, result.channels, result.note]),
					);
					if ((reported.length || result.state !== "complete") && current.shown[result.path] !== signature) {
						fresh.push({ ...result, findings: reported });
						unattributed += unknown.length;
						introduced += added.length;
					}
					current.shown[result.path] = signature;
				}
				const unresolved = Object.entries(current.unresolved)
					.filter(([path]) => current.current.includes(path))
					.flatMap(([, findings]) => findings)
					.filter((finding) => finding.severity === "error");
				const confirmed = gateFindings.filter(
					(finding) =>
						finding.severity === "error" &&
						unresolved.some((item) => item.path === finding.path) &&
						valid.some(
							(result) =>
								result.path === finding.path &&
								result.state === "complete" &&
								reliable.covered.includes(result.path) &&
								result.findings.some((item) => item.severity === "error"),
						),
				);
				if (
					stopping &&
					config.stopGate === "introduced-errors" &&
					confirmed.length &&
					!current.blocked.includes(turn || "__turn__")
				) {
					current.blocked.push(turn || "__turn__");
					feedback = {
						kind: "block",
						reason: `Codex CodeIntel: fix introduced errors before finishing.\n${render([{ path: ".", state: "complete", findings: confirmed }], 100000, BUDGET.outputBytes)}`,
					};
				} else if (fresh.length || repaired.length || (stopping && current.pending.length))
					feedback = context(
						`Automatic diagnostics: introduced=${introduced}; unattributed=${unattributed}; pending=${current.pending.length}${unattributed || reliable.failures.length || reliable.pending.length ? "\nCurrent diagnostics cannot be attributed to this turn without a reliable pre-edit baseline for their checker and coverage; ending gate unavailable for these ranges." : ""}\n${fresh.length ? render(fresh, 100000, BUDGET.outputBytes) : ""}${repaired.join("\n")}${output.note ? `\n${output.note}` : ""}`,
					);
				current.shown["diagnosticCurrent"] = await this.store.shared(ledger);
				await queueDelivery(this.store, { ...current, turn }, feedback, bindings, config.version, analysis);
				return true;
			});
			return feedback;
		};
	}
}
