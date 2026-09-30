import { readFile } from "node:fs/promises";
import type { AutomaticResult } from "./automatic.js";
import { configuration } from "./config.js";
import { hash, inventory, workspacePath } from "./files.js";
import { Metadata } from "./metadata.js";
import { type FileResult, message, render, text } from "./results.js";
import { Runtime } from "./runtime.js";
import { languageFor } from "./tool-resolution.js";

type Checker = (path: string, signal: AbortSignal) => Promise<FileResult>;
export class HookEngine {
	private readonly store: Metadata;
	constructor(
		private readonly root: string,
		private readonly checker?: Checker,
	) {
		this.store = new Metadata(root);
	}
	async hook(input: Record<string, unknown>, signal: AbortSignal): Promise<string> {
		const began = Date.now();
		signal.throwIfAborted();
		const id = text(input["session_id"]);
		if (!id)
			return JSON.stringify({ systemMessage: "Codex LSP: missing session_id; automatic checking unavailable" });
		const event = text(input["hook_event_name"], "PostToolUse");
		const stopping = event === "Stop" || event === "SubagentStop";
		const output = (context: string) =>
			JSON.stringify(
				stopping
					? { systemMessage: context }
					: { hookSpecificOutput: { hookEventName: event, additionalContext: context } },
			);
		if (event === "SessionEnd") {
			await this.store.end(id, signal);
			if (!this.checker) {
				const runtime = new Runtime();
				try {
					await runtime.request(this.root, "session_end", { session: id }, signal);
				} catch {
					/* The durable tombstone cancels recovered work too. */
				} finally {
					await runtime.close();
				}
			}
			return "";
		}
		if (stopping && input["stop_hook_active"] === true) return "";
		const initial = await this.store.read(id);
		if (initial.turn === "__ended__" && event !== "SessionStart") return "";
		const config = await configuration(this.root);
		const baselineOnly = event === "SessionStart" || event === "PreToolUse";
		if (event === "PreToolUse" && initial.baseline) {
			await this.store.update(id, signal, (state) => {
				const turn = text(input["turn_id"]);
				if (turn && turn !== state.turn) {
					state.turn = turn;
					state.current = [];
				}
			});
			return "";
		}
		const snapshot = await inventory(this.root, 10000, signal, config.exclude);
		if (!snapshot.complete)
			return output(
				"Codex LSP: partial; change discovery/file limit exceeded (10000 files / 1 MiB per file); baseline retained, unfinished workspace range pending. Narrow scope with check_diagnostics scope=paths run=active.",
			);
		const changed = [...snapshot.files]
			.filter(([path, content]) => initial.baseline?.[path] !== content)
			.map(([path]) => path);
		const deleted = Object.keys(initial.baseline ?? {}).filter((path) => !snapshot.files.has(path));
		const configured = stopping ? config.automaticDiagnostics.stop : config.automaticDiagnostics.postToolUse;
		const mode = !initial.baseline && !baselineOnly && configured !== "off" ? "full" : configured;
		let registered = false;
		const state = await this.store.update(id, signal, (state) => {
			if (state.version !== initial.version && state.generation !== initial.generation) return false;
			if (state.turn === "__ended__" && event !== "SessionStart") return false;
			if (state.turn === "__ended__") state.turn = "";
			const turn = text(input["turn_id"]);
			if (turn && turn !== state.turn) {
				state.turn = turn;
				state.current = [];
			}
			if (baselineOnly) {
				state.baseline ??= Object.fromEntries(snapshot.files);
				state.configuration = config.version;
				registered = true;
				return true;
			}
			const configChanged =
				state.configuration !== config.version ||
				changed.some((path) =>
					/(?:config|lock|manifest|Cargo\.toml|package\.json|pyproject|ty\.toml|ruff\.toml|\.clangd|compile_commands|compile_flags|rust-toolchain)/i.test(
						path,
					),
				);
			const paths = (mode === "full" || configChanged ? [...snapshot.files.keys()] : changed).filter((path) =>
				languageFor(config, path),
			);
			if (changed.length || deleted.length || configChanged || (mode === "full" && state.automaticScope !== "full"))
				state.generation++;
			state.configuration = config.version;
			state.baseline = Object.fromEntries(snapshot.files);
			state.touched = [
				...new Set([...state.touched, ...changed.filter((path) => languageFor(config, path))]),
			].filter((path) => snapshot.files.has(path));
			state.current = [
				...new Set([...state.current, ...changed.filter((path) => languageFor(config, path))]),
			].filter((path) => snapshot.files.has(path));
			state.pending = [...new Set([...state.pending, ...paths])].filter((path) => snapshot.files.has(path));
			state.delivery = [...new Set([...state.delivery, ...paths])].filter((path) => snapshot.files.has(path));
			for (const channel of ["lsp", "lint"] as const)
				state.pendingChannels[channel] = [...new Set([...state.pendingChannels[channel], ...paths])].filter(
					(path) => snapshot.files.has(path),
				);
			state.automaticScope = mode === "full" ? "full" : "delta";
			registered = true;
			return true;
		});
		if (!registered || baselineOnly || mode === "off") return "";
		if (!config.trusted && !this.checker)
			return output(
				`session=${id}\nCodex LSP: automatic LSP/lint requires workspace trust; lint requires workspace trust. pending=${state.pending.length}`,
			);
		const paths =
			mode === "full"
				? [...snapshot.files.keys()].filter((path) => languageFor(config, path))
				: [...new Set([...state.pending, ...state.delivery])];
		if (!paths.length && !deleted.length && !stopping) return "";
		let result: AutomaticResult;
		if (this.checker) {
			const results: FileResult[] = [];
			for (const path of paths) {
				if (signal.aborted) break;
				results.push(await this.checker(path, signal));
			}
			result = {
				generation: state.generation,
				scope: mode,
				total: paths.length,
				state: signal.aborted ? "pending" : "complete",
				results,
				pending: paths.filter(
					(path) => !results.some((entry) => entry.path === path && entry.state === "complete"),
				),
				note: "",
			};
		} else {
			const runtime = new Runtime();
			try {
				result = JSON.parse(
					await runtime.request(
						this.root,
						"automatic",
						{
							session: id,
							generation: state.generation,
							scope: mode,
							paths,
							waitMs: Math.max(1, (stopping ? 42500 : 3600) - (Date.now() - began)),
						},
						signal,
					),
				) as AutomaticResult;
			} catch (error) {
				return output(
					`session=${id}\nCodex LSP ${mode}: partial; pending=${paths.length}; unfinished paths=${paths.slice(0, 10).join(", ")}. ${message(error)}. Background checks continue; later Hook/MCP can retrieve results.`,
				);
			} finally {
				await runtime.close();
			}
		}
		if (result.generation !== state.generation) return "";
		const commitSignal = AbortSignal.timeout(750);
		if ((await configuration(this.root)).version !== config.version)
			return output("Codex LSP: stale; configuration/trust changed; pending retained");
		const valid: FileResult[] = [];
		for (const entry of result.results) {
			try {
				if (
					hash(
						await readFile(await workspacePath(this.root, entry.path), {
							encoding: "utf8",
							signal: commitSignal,
						}),
					) === snapshot.files.get(entry.path)
				)
					valid.push(entry);
			} catch {
				/* Deleted/changed files do not deliver old findings. */
			}
		}
		let feedback = "";
		await this.store.update(id, commitSignal, (current) => {
			if (current.generation !== state.generation || current.turn === "__ended__") return false;
			const fresh: FileResult[] = [];
			const cleared: string[] = [];
			for (const path of deleted) {
				if (current.shown[`issues:${path}`] === "yes")
					cleared.push(`${path} removed; previous diagnostics cleared`);
				delete current.shown[path];
				delete current.shown[`issues:${path}`];
			}
			for (const entry of valid) {
				if (signal.aborted && this.checker) continue;
				if (entry.state === "complete") current.pending = current.pending.filter((path) => path !== entry.path);
				const fingerprint = hash(
					JSON.stringify([
						entry.state,
						entry.findings,
						entry.channels,
						entry.state === "complete" ? undefined : entry.note,
					]),
				);
				if (entry.state === "complete" && !entry.findings.length && current.shown[`issues:${entry.path}`] === "yes")
					cleared.push(`${entry.path}: previous diagnostics cleared`);
				const environment = !entry.findings.length && (entry.state === "failed" || entry.state === "skipped");
				const environmentKey = `environment:${languageFor(config, entry.path)?.language}:${hash(entry.note ?? "unavailable")}`;
				if (
					current.shown[entry.path] !== fingerprint &&
					(entry.findings.length || entry.state !== "complete") &&
					(!environment || current.shown[environmentKey] !== fingerprint)
				)
					fresh.push(entry);
				if (environment) current.shown[environmentKey] = fingerprint;
				current.shown[entry.path] = fingerprint;
				current.shown[`issues:${entry.path}`] = entry.findings.length ? "yes" : "no";
			}
			const pending = paths.filter(
				(path) => !valid.some((entry) => entry.path === path && entry.state === "complete"),
			);
			const errors = valid
				.flatMap((entry) => entry.findings)
				.filter((finding) => finding.severity === "error").length;
			const summary = `session=${id}\nAutomatic ${mode}: ${pending.length ? "partial" : "complete"}; checked=${paths.length - pending.length}/${paths.length} errors=${errors} pending=${pending.length}${pending.length ? `\nUnfinished range: ${pending.slice(0, 10).join(", ")}${pending.length > 10 ? ` (+${pending.length - 10})` : ""}` : ""}${result.note ? `\n${result.note}` : ""}`;
			const signature = hash(
				JSON.stringify([
					state.generation,
					summary,
					valid.map((entry) => [entry.path, entry.state, entry.findings, entry.channels]),
					cleared,
				]),
			);
			if (
				stopping
					? current.shown["stop"] !== signature
					: fresh.length || cleared.length || (pending.length && current.shown["post"] !== signature)
			) {
				feedback = `${summary}${fresh.length ? `\nLSP/lint channels: ${render(fresh, 15, 3500)}` : ""}${cleared.length ? `\n${cleared.join("\n")}` : ""}${pending.length && result.state === "running" ? "\nBackground analysis continues; retrieve on a later Hook or cached MCP query." : ""}`;
			}
			if (stopping) current.shown["stop"] = signature;
			else current.shown["post"] = signature;
			current.delivery = current.delivery.filter(
				(path) =>
					!valid.some((entry) => entry.path === path && entry.state !== "pending" && entry.state !== "stale"),
			);
			return true;
		});
		return feedback ? output(feedback) : "";
	}
}
