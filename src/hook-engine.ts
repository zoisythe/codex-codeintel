import { readFile } from "node:fs/promises";
import { BUDGET } from "./budgets.js";
import { configuration } from "./config.js";
import { configurationImpact } from "./config-files.js";
import { addedFindings, attributableFinding, diagnosticKey } from "./diagnostic-delta.js";
import { executionEnvironment } from "./environment.js";
import { hash, inventory, workspacePath } from "./files.js";
import { queueDelivery, utf8 } from "./hook-delivery.js";
import { actorLabel, hookEvent, isActorSession, rootSession } from "./hook-events.js";
import { analysisIdentity } from "./identity.js";
import { Metadata } from "./metadata.js";
import type { ProjectChecks } from "./project-checks.js";
import { type FileResult, type Finding, message, record, text } from "./results.js";
import { codeLanguage } from "./tool-resolution.js";
import { writeIntent } from "./write-intent.js";

export type HookOutput =
	| { kind: "silent" }
	| { kind: "context"; event: string; context: string; configuration?: string; infrastructure?: boolean }
	| { kind: "block"; reason: string };
export function renderHook(output: HookOutput): Record<string, unknown> | undefined {
	if (output.kind === "silent") return undefined;
	if (output.kind === "block") return { decision: "block", reason: output.reason };
	return output.infrastructure || output.event === "Stop" || output.event === "SubagentStop"
		? { systemMessage: output.context }
		: { hookSpecificOutput: { hookEventName: output.event, additionalContext: output.context } };
}

function summary(results: FileResult[]): string {
	const findings = results
		.flatMap((result) => result.findings)
		.sort((a, b) => Number(b.severity === "error") - Number(a.severity === "error"));
	return [
		...findings
			.slice(0, 5)
			.map(
				(item) =>
					`${utf8(item.path, 120)}:${item.line}:${item.column} ${item.severity} [${utf8(item.source, 60)}] ${utf8(item.message.replace(/\s+/g, " "), 240)}`,
			),
		...results
			.filter((result) => result.state !== "complete")
			.slice(0, 2)
			.map(
				(result) =>
					`${utf8(result.path, 120)}: ${result.state}${result.note ? `; ${utf8(result.note.replace(/\s+/g, " "), 120)}` : ""}`,
			),
		...(findings.length > 5 ? [`${findings.length - 5} more diagnostics in cache.`] : []),
	].join("\n");
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
	end(session: string, turn?: string): void;
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
	async cancel(parent: string, turn: string | null | undefined, signal: AbortSignal): Promise<void> {
		// An unknown Interrupt only releases waiters; it cannot guess ownership of analysis.
		if (turn === null) return;
		const ids = [parent, ...(await this.store.ids()).filter((id) => id !== parent && rootSession(id) === parent)];
		for (const id of ids) {
			if (turn === undefined) {
				await this.store.end(id, signal);
				this.dependencies.end(id);
			} else {
				this.dependencies.end(id, turn);
				await this.store.update(id, signal, (state) => {
					for (const entry of Object.values(state.hookEvents))
						if (entry.turn === turn && ["queued", "running"].includes(entry.state)) entry.state = "cancelled";
				});
			}
		}
	}
	hook(input: Record<string, unknown>, signal: AbortSignal, background = false): Promise<HookOutput> {
		const event = hookEvent(input);
		if (!event) return Promise.resolve({ kind: "silent" });
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
					if (state.turn === "__ended__" || (input["__epoch"] && input["__epoch"] !== state.epoch)) return false;
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
			context: `session=${rootSession(id)}; actor=${event === "PostToolUse" && !isActorSession(id) ? "shared" : actorLabel(id)}\n${value}`,
			configuration: config.version,
			...(event === "SessionStart" ? { infrastructure: true } : {}),
		});
		if (!id) return { kind: "silent" };
		if (event === "SessionEnd") {
			await this.cancel(id, undefined, signal);
			return { kind: "silent" };
		}
		if (event === "Interrupt") {
			await this.cancel(id, text(input["turn_id"]) || null, signal);
			return { kind: "silent" };
		}
		if (stopping && input["stop_hook_active"] === true) return { kind: "silent" };
		const initial = await this.store.read(id);
		if (input["__epoch"] && input["__epoch"] !== initial.epoch) return { kind: "silent" };
		if (isActorSession(id) && (await this.store.read(rootSession(id))).epoch !== initial.epoch)
			return { kind: "silent" };
		if (initial.turn === "__ended__" && event !== "SessionStart") return { kind: "silent" };
		const config = await configuration(this.root);
		if (initial.configuration && initial.configuration !== config.version) {
			this.dependencies.end(id);
			await this.store.update(id, signal, (state) => {
				if (state.epoch !== initial.epoch || state.turn === "__ended__") return false;
				state.generation++;
				state.diagnosticBaseline = null;
				state.unresolved = {};
				state.shown = {};
				state.outbox = {};
				state.configuration = config.version;
				return true;
			});
		}
		if (config.automaticDiagnostics.postToolUse === "off" && config.automaticDiagnostics.stop === "off")
			return { kind: "silent" };
		const turn = text(input["turn_id"], initial.turn);
		await this.store.update(id, signal, (state) => {
			if (state.epoch !== initial.epoch || (state.turn === "__ended__" && event !== "SessionStart")) return false;
			if (event === "SessionStart" && state.turn === "__ended__") state.turn = "";
			state.configuration = config.version;
			if (turn !== state.turn && !(event === "PostToolUse" && state.turn)) {
				state.turn = turn;
				if (event !== "Stop" && (event !== "PostToolUse" || isActorSession(id))) state.current = [];
				state.blocked = [];
			}
			return true;
		});
		if (event === "SessionStart") {
			try {
				if (!initial.baselineAttempted) {
					const snapshot = await inventory(this.root, BUDGET.files, signal, config.exclude);
					if (!snapshot.complete)
						return context("Baseline inventory incomplete; current diagnostics cannot be attributed");
					const reference = await this.store.shared(Object.fromEntries(snapshot.files));
					await this.store.update(id, signal, (state) => {
						if (state.epoch !== initial.epoch || state.turn === "__ended__") return false;
						state.baseline ??= reference;
						state.baselineAttempted = true;
						return true;
					});
				}
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
		const forced = [
			...new Set([
				...(intent.kind === "write" || intent.kind === "configuration" ? (intent.paths ?? []) : []),
				...(Array.isArray(input["__paths"])
					? input["__paths"].filter((path): path is string => typeof path === "string")
					: []),
			]),
		];
		const snapshot = await inventory(this.root, BUDGET.files, signal, config.exclude, this.root, false, forced);
		if (!snapshot.complete)
			return context("Change discovery incomplete; pending and unresolved diagnostics retained");
		const changed = [...snapshot.files].filter(([path, content]) => previous[path] !== content).map(([path]) => path);
		const deleted = Object.keys(previous).filter((path) => !snapshot.files.has(path));
		const sourcePaths = [
			...new Set([
				...(isActorSession(id) && forced.length ? changed.filter((path) => forced.includes(path)) : changed),
				...forced,
			]),
		].filter((path) => snapshot.files.has(path) && codeLanguage(config, path) && !configurationImpact(path).length);
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
		if (state.epoch !== stateBefore.epoch || state.turn === "__ended__") return { kind: "silent" };
		if ((stopping ? config.automaticDiagnostics.stop : config.automaticDiagnostics.postToolUse) === "off")
			return { kind: "silent" };
		const paths = stopping
			? [...new Set([...state.current, ...state.pending])]
			: [...new Set([...state.pending, ...state.delivery])];
		if (!paths.length) return { kind: "silent" };
		let reliable: Awaited<ReturnType<HookDependencies["projects"]["baseline"]>>;
		try {
			reliable = await this.dependencies.projects.baseline(
				rootSession(id),
				paths,
				executionEnvironment(),
				signal,
				0,
			);
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
			const observedValue = state.shown["observedCurrent"]
				? await this.store.readShared(state.shown["observedCurrent"])
				: undefined;
			const observed = record(observedValue) ? (observedValue as Record<string, Finding[]>) : {};
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
			if (
				event === "Stop" &&
				!isActorSession(id) &&
				config.stopGate === "introduced-errors" &&
				reliable.covered.length
			) {
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
			if ((await analysisIdentity(this.root, paths, await configuration(this.root), signal)) !== snapshotAnalysis) {
				await this.store.update(id, signal, (current) => {
					if (
						current.epoch !== state.epoch ||
						current.generation !== state.generation ||
						current.turn === "__ended__"
					)
						return false;
					current.pending.push(...paths);
					return true;
				});
				return { kind: "silent" };
			}
			if ((await this.store.read(rootSession(id))).epoch !== state.epoch) return { kind: "silent" };
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
				if (
					current.generation !== state.generation ||
					current.epoch !== state.epoch ||
					current.turn === "__ended__"
				)
					return false;
				const fresh: FileResult[] = [];
				const repaired: string[] = [];
				let unattributed = 0;
				let introduced = 0;
				let resolved = 0;
				current.pending = [
					...new Set([
						...current.pending,
						...paths.filter(
							(path) => !valid.some((result) => result.path === path && result.state === "complete"),
						),
					]),
				];
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
						const removed = addedFindings(result.findings, observed[result.path] ?? []).length;
						observed[result.path] = result.findings;
						// Remove already introduced occurrences from the previous complete snapshot.
						// This also prevents a late channel counting the same partial finding twice.
						const historical = addedFindings(previousIssues, preceding);
						current.unresolved[result.path] = addedFindings(historical, attributable);
						ledger[result.path] = attributable;
						current.pending = current.pending.filter((path) => path !== result.path);
						current.delivery = current.delivery.filter((path) => path !== result.path);
						if (previousIssues.length > (current.unresolved[result.path]?.length ?? 0)) {
							resolved += Math.max(
								removed,
								previousIssues.length - (current.unresolved[result.path]?.length ?? 0),
							);
							repaired.push(
								`${result.path}: ${previousIssues.length - (current.unresolved[result.path]?.length ?? 0)} introduced diagnostics repaired`,
							);
						} else if (removed) {
							resolved += removed;
							repaired.push(
								`${result.path}: ${removed} current diagnostics repaired; history remains unattributed where unconfirmed`,
							);
						}
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
					event === "Stop" &&
					!isActorSession(id) &&
					config.stopGate === "introduced-errors" &&
					confirmed.length &&
					!current.blocked.includes(turn || "__turn__")
				) {
					current.blocked.push(turn || "__turn__");
					feedback = {
						kind: "block",
						reason: `Codex CodeIntel: fix introduced errors before finishing. introduced=${confirmed.length}; resolved=${resolved}; unattributed=${unattributed}; pending=${current.pending.length}\n${summary([{ path: ".", state: "complete", findings: confirmed }])}\nDetails: diagnostics(run=cached, scope=session).`,
					};
				} else if (fresh.length || repaired.length || current.pending.length)
					feedback = context(
						`Automatic diagnostics: introduced=${introduced}; resolved=${resolved}; unattributed=${unattributed}; pending=${current.pending.length}${unattributed || reliable.failures.length || reliable.pending.length ? "\nCurrent diagnostics cannot be attributed without a reliable pre-edit baseline and checker coverage." : ""}\n${summary(fresh)}${repaired.slice(0, 5).join("\n")}${output.note ? `\n${output.note.slice(0, 200)}` : ""}\nDetails: diagnostics(run=cached, scope=session).`,
					);
				current.shown["diagnosticCurrent"] = await this.store.shared(ledger);
				current.shown["observedCurrent"] = await this.store.shared(observed);
				await queueDelivery(this.store, { ...current, turn }, feedback, bindings, config.version, analysis);
				return true;
			});
			return feedback;
		};
	}
}
