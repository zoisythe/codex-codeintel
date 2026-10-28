import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { BUDGET } from "./budgets.js";
import { configuration } from "./config.js";
import { Engine, type ToolOutput } from "./engine.js";
import { executionEnvironment } from "./environment.js";
import { hash, inventory } from "./files.js";
import { normalizeHook, rootSession } from "./hook-events.js";
import { registerHook } from "./hook-inbox.js";
import { analysisIdentity } from "./identity.js";
import { ensureService, exchange, existingService } from "./ipc.js";
import { Metadata } from "./metadata.js";
import { OutputPages } from "./output-pages.js";
import { type Finding, failureKind, message, publicFinding, record, text, WriteFailure } from "./results.js";
import { writeIntent } from "./write-intent.js";

export class Runtime {
	private readonly active = new Set<AbortController>();
	private readonly pages = new OutputPages("view:");
	private outcomeIdentity(root: string): string {
		return hash(JSON.stringify([root, executionEnvironment(), "apply-outcome"]));
	}
	private async pageIdentity(root: string, signal: AbortSignal): Promise<string> {
		const config = await configuration(root);
		const snapshot = await inventory(root, BUDGET.files, signal, config.exclude);
		const paths = [
			...new Map(
				[...snapshot.files.keys()].map((path) => [
					path.replace(/[^/\\]+$/, "") + path.slice(path.lastIndexOf(".")),
					path,
				]),
			).values(),
		];
		return hash(
			JSON.stringify([
				root,
				config.version,
				snapshot.version,
				executionEnvironment(),
				await analysisIdentity(root, paths, config, signal).catch(message),
			]),
		);
	}
	private async output(
		root: string,
		operation: string,
		args: Record<string, unknown>,
		value: ToolOutput,
		signal: AbortSignal,
	): Promise<ToolOutput> {
		if (["hook", "hook_wait", "hook_ack", "session_end"].includes(operation)) return value;
		const clean = (item: unknown): unknown => {
			if (Array.isArray(item)) return item.map(clean);
			if (!record(item)) return item;
			if (
				typeof item["message"] === "string" &&
				typeof item["source"] === "string" &&
				typeof item["line"] === "number" &&
				typeof item["path"] === "string"
			)
				return publicFinding(item as unknown as Finding);
			return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, clean(entry)]));
		};
		let output = clean(value) as ToolOutput;
		if (operation === "status" && record(output["configuration"])) {
			const config = output["configuration"];
			output = {
				...output,
				configuration: {
					valid: config["valid"],
					automaticDiagnostics: config["automaticDiagnostics"],
					stopGate: config["stopGate"],
				},
			};
			if (Array.isArray(output["tools"]))
				output["tools"] = output["tools"].map((item) =>
					record(item)
						? Object.fromEntries(Object.entries(item).filter(([key]) => !["server", "extensions"].includes(key)))
						: item,
				);
		}
		const compact = (item: unknown): boolean =>
			Array.isArray(item)
				? item.length <= 20 && item.every(compact)
				: record(item)
					? Object.values(item).every(compact)
					: true;
		if (Buffer.byteLength(JSON.stringify(output)) < 6200 && compact(output)) return output;
		return {
			...this.pages.write(
				output,
				{ ...args, workspace: root },
				operation === "apply" ? this.outcomeIdentity(root) : await this.pageIdentity(root, signal),
			),
			operation,
		};
	}
	async request(
		root: string,
		operation: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<ToolOutput> {
		if (operation === "hook") {
			const normalized = normalizeHook(args);
			if (!normalized) return { operation, output: { kind: "silent" } };
			args = normalized;
		}
		const event = operation === "hook" ? text(args["hook_event_name"]) : "";
		if (!isAbsolute(root)) throw new Error("workspace must be an absolute project directory");
		root = await realpath(root);
		if (operation === "hook" && event !== "SessionEnd" && event !== "Interrupt") {
			const config = await configuration(root);
			if (config.automaticDiagnostics.postToolUse === "off" && config.automaticDiagnostics.stop === "off")
				return { operation: "hook", output: { kind: "silent" } };
			if (!text(args["session_id"])) return { operation: "hook", output: { kind: "silent" } };
		}
		const controller = new AbortController();
		this.active.add(controller);
		signal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(BUDGET.request)]);
		try {
			if (typeof args["cursor"] === "string" && args["cursor"].startsWith("view:"))
				return {
					...this.pages.read(
						{ ...args, workspace: root },
						operation === "apply" ? this.outcomeIdentity(root) : await this.pageIdentity(root, signal),
						operation,
					),
					operation,
				};
			const passiveHook =
				(event === "PostToolUse" && writeIntent(root, args).kind === "read") ||
				["SessionEnd", "Interrupt", "SubagentStop"].includes(event);
			if (operation === "hook" && !passiveHook && args["stop_hook_active"] !== true) {
				const registered = await registerHook(root, args, signal);
				if (!registered) return { operation, output: { kind: "silent" } };
				args = { ...args, registration: registered.id };
			}
			const existing = await existingService(root, signal);
			const passive =
				operation === "status" ||
				passiveHook ||
				operation === "hook_ack" ||
				operation === "hook_wait" ||
				(operation === "diagnostics" && args["run"] === "cached") ||
				operation === "session_end" ||
				(operation === "check" && args["run"] === "cached");
			if (!existing && passive) {
				if (operation === "hook_ack") return { operation };
				if (operation === "hook_wait") return { operation, state: "unavailable", output: { kind: "silent" } };
				if (operation === "hook") {
					const store = new Metadata(root),
						session = text(args["session_id"]);
					if (event === "SessionEnd") await store.end(session, signal);
					if (event === "Interrupt")
						await store.update(session, signal, (state) => {
							if (state.turn === "__ended__") return false;
							const turn = text(args["turn_id"]);
							if (turn) state.interrupts[turn] = (state.interrupts[turn] ?? 0) + 1;
							else state.waitEpoch++;
							return true;
						});
					if (event === "Interrupt" && text(args["turn_id"])) {
						for (const id of [
							session,
							...(await store.ids()).filter((id) => id !== session && rootSession(id) === session),
						])
							await store.update(id, signal, (state) => {
								for (const entry of Object.values(state.hookEvents))
									if (entry.turn === args["turn_id"] && ["queued", "running"].includes(entry.state))
										entry.state = "cancelled";
							});
					}
					return { operation, output: { kind: "silent" } };
				}
				if (operation === "session_end") return { operation };
				if (operation === "check")
					return {
						operation,
						job: typeof args["job"] === "string" ? args["job"] : "",
						state: "missing",
						checkers: [],
						diagnostics: [],
						errors: 0,
						warnings: 0,
					};
				const engine = new Engine(root);
				try {
					const output = await engine.dispatch(operation, args, signal);
					return operation === "status"
						? await this.output(
								root,
								operation,
								args,
								{
									...output,
									service: { state: "stopped" },
									automaticTasks: { running: 0, pending: 0, complete: 0 },
									hookTasks: { mode: "native-async", queued: 0, running: 0 },
								},
								signal,
							)
						: await this.output(root, operation, args, output, signal);
				} finally {
					await engine.dispose();
				}
			}
			const endpoint = existing ?? (await ensureService(root, signal));
			return await this.output(root, operation, args, await exchange(endpoint, operation, args, signal), signal);
		} catch (error) {
			if (
				["check", "diagnostics", "status", "navigate", "rename", "format", "inspect", "actions", "apply"].includes(
					operation,
				)
			)
				return this.output(
					root,
					operation,
					args,
					{
						operation,
						isError: true,
						status: failureKind(message(error)),
						reason: message(error),
						...(operation === "apply"
							? { modifiedPaths: error instanceof WriteFailure ? error.modifiedPaths : [] }
							: {}),
					},
					new AbortController().signal,
				);
			throw error;
		} finally {
			this.active.delete(controller);
		}
	}
	async close(): Promise<void> {
		for (const controller of this.active) controller.abort();
		this.active.clear();
	}
}
