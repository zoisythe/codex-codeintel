import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { BUDGET } from "./budgets.js";
import { configuration } from "./config.js";
import { waitWithSignal } from "./deadline.js";
import { withExecution } from "./environment.js";
import { consumeDelivery, queueDelivery } from "./hook-delivery.js";
import type { HookEngine, HookOutput } from "./hook-engine.js";
import { hookSession, internalHook, normalizeHook, rootSession } from "./hook-events.js";
import { type RegisteredHook, registeredHooks } from "./hook-inbox.js";
import { logEvent } from "./log.js";
import { Metadata } from "./metadata.js";
import { text } from "./results.js";
import { writeIntent } from "./write-intent.js";

interface BackgroundHook {
	controller: AbortController;
	done: Promise<void>;
	entries: RegisteredHook[];
	initial: RegisteredHook;
	updated: number;
	running: boolean;
	hints: string[];
}
interface HookResult {
	output: HookOutput;
	deliveryId?: string;
	deliverySession?: string;
	registration?: string;
	state?: string;
	revision?: number;
	waitToken?: string;
}

export class HookCoordinator {
	private readonly jobs = new Map<string, BackgroundHook>();
	private readonly tasks = new Set<BackgroundHook>();
	private readonly seen = new Set<string>();
	private readonly listeners = new Set<() => void>();
	private revision = 0;
	private ingesting: Promise<void> | undefined;
	private disposed = false;
	constructor(
		private readonly root: string,
		private readonly hooks: HookEngine,
		private readonly onStart: (entry: RegisteredHook) => void = () => undefined,
	) {}
	get active(): boolean {
		return this.tasks.size > 0;
	}
	status(): unknown {
		return {
			mode: "native-async",
			queued: [...this.tasks].filter((job) => !job.running).length,
			running: [...this.tasks].filter((job) => job.running).length,
		};
	}
	private changed(): void {
		this.revision++;
		for (const listener of this.listeners) listener();
	}
	ingest(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		this.ingesting ??= this.load().finally(() => {
			this.ingesting = undefined;
		});
		return this.ingesting;
	}
	private async load(): Promise<void> {
		for (const entry of await registeredHooks(this.root)) {
			if (this.disposed || this.seen.has(entry.path)) continue;
			await withExecution(entry.environment, true, async () => {
				const store = new Metadata(this.root);
				const parent = await store.read(rootSession(entry.session));
				const state = await store.read(entry.session);
				const status = state.hookEvents[entry.id]?.state;
				if (
					parent.epoch !== entry.epoch ||
					state.epoch !== entry.epoch ||
					(status && !["queued", "running"].includes(status))
				) {
					await rm(entry.path, { force: true });
					return;
				}
				this.seen.add(entry.path);
				const event = text(entry.input["hook_event_name"]);
				if (
					event === "Stop" &&
					this.jobs.has(`${entry.session}:PostToolUse`) &&
					(await configuration(this.root)).stopGate !== "introduced-errors"
				) {
					await store.update(entry.session, AbortSignal.timeout(1000), (current) => {
						const item = current.hookEvents[entry.id];
						if (item) item.state = "complete";
					});
					await rm(entry.path, { force: true });
					this.seen.delete(entry.path);
					this.changed();
					return;
				}
				const key = `${entry.session}:${event}`;
				const previous = this.jobs.get(key);
				if (previous && !previous.running && event === "PostToolUse") {
					previous.entries.push(entry);
					previous.updated = Date.now();
					this.changed();
					return;
				}
				if (previous && event === "SessionStart") {
					previous.entries.push(entry);
					return;
				}
				if (previous) previous.controller.abort();
				const job: BackgroundHook = {
					initial: entry,
					entries: [entry],
					updated: Date.now(),
					running: false,
					hints: previous
						? [
								...previous.hints,
								...previous.entries.flatMap((item) => {
									const intent = writeIntent(this.root, item.input);
									return intent.kind === "read" ? [] : (intent.paths ?? []);
								}),
							]
						: [],
					controller: new AbortController(),
					done: Promise.resolve(),
				};
				this.jobs.set(key, job);
				this.tasks.add(job);
				if (event === "SessionStart") this.onStart(entry);
				job.done = this.run(key, job);
				this.changed();
			});
		}
	}
	private async state(
		job: BackgroundHook,
		status: "running" | "complete" | "superseded" | "cancelled" | "failed",
	): Promise<void> {
		await withExecution(job.initial.environment, true, () =>
			new Metadata(this.root).update(job.initial.session, AbortSignal.timeout(1000), (state) => {
				if (state.epoch !== job.initial.epoch || state.turn === "__ended__") return false;
				for (const entry of job.entries)
					if (state.hookEvents[entry.id])
						state.hookEvents[entry.id] = {
							turn: text(entry.input["turn_id"]),
							state: status === "complete" && entry !== job.entries.at(-1) ? "superseded" : status,
						};
				return true;
			}),
		).catch(() => undefined);
		this.changed();
	}
	private async run(key: string, job: BackgroundHook): Promise<void> {
		const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(BUDGET.project)]);
		try {
			if (job.initial.input["hook_event_name"] === "PostToolUse") {
				const began = Date.now();
				while (true) {
					const remaining = Math.min(job.updated + BUDGET.merge, began + BUDGET.mergeMax) - Date.now();
					if (remaining <= 0) break;
					await delay(remaining, undefined, { signal });
				}
			}
			job.running = true;
			await this.state(job, "running");
			const latest = job.entries.at(-1) ?? job.initial;
			const hints = [
				...job.hints,
				...job.entries.flatMap((entry) => {
					const intent = writeIntent(this.root, entry.input);
					return intent.kind === "read" ? [] : (intent.paths ?? []);
				}),
			];
			await withExecution(latest.environment, true, () =>
				this.hooks.hook({ ...internalHook(latest.input), __paths: hints, __epoch: latest.epoch }, signal, true),
			);
			await this.state(job, "complete");
		} catch {
			await this.state(job, job.controller.signal.aborted ? "cancelled" : "failed");
			if (!signal.aborted) await logEvent("background-failure");
		} finally {
			if (this.jobs.get(key) === job) this.jobs.delete(key);
			for (const entry of job.entries) {
				await rm(entry.path, { force: true }).catch(() => logEvent("cancel-cleanup-failure"));
				this.seen.delete(entry.path);
			}
			this.tasks.delete(job);
			this.changed();
		}
	}
	private async delivery(input: Record<string, unknown>, signal: AbortSignal): Promise<HookResult> {
		const session = hookSession(input);
		return {
			...(await consumeDelivery(this.root, session, text(input["hook_event_name"]), signal)),
			deliverySession: session,
		};
	}
	private async waitToken(input: Record<string, unknown>): Promise<string> {
		const session = hookSession(input);
		const store = new Metadata(this.root),
			state = await store.read(session),
			parent = await store.read(rootSession(session));
		return `${parent.interrupts[text(input["turn_id"])] ?? 0}:${state.waitEpoch}`;
	}
	async wait(input: Record<string, unknown>, signal: AbortSignal): Promise<HookResult> {
		const limited = AbortSignal.any([signal, AbortSignal.timeout(BUDGET.hookWait)]);
		try {
			return await this.poll(input, limited);
		} catch (error) {
			if (signal.aborted || !limited.aborted) throw error;
			return {
				output: { kind: "silent" },
				state: "waiting",
				registration: text(input["registration"]),
				revision: this.revision,
				waitToken: text(input["waitToken"]),
			};
		}
	}
	private async poll(input: Record<string, unknown>, signal: AbortSignal): Promise<HookResult> {
		// Only observe an existing registration; never register or start analysis here.
		const session = hookSession(input),
			id = text(input["registration"]);
		const interrupted = typeof input["waitToken"] === "string" ? input["waitToken"] : await this.waitToken(input);
		const inspect = async (): Promise<HookResult> => {
			const store = new Metadata(this.root),
				state = await store.read(session),
				parent = await store.read(rootSession(session));
			const status =
				parent.epoch !== state.epoch ||
				parent.turn === "__ended__" ||
				`${parent.interrupts[text(input["turn_id"])] ?? 0}:${state.waitEpoch}` !== interrupted
					? "cancelled"
					: (state.hookEvents[id]?.state ?? "missing");
			return {
				...(status === "complete"
					? await this.delivery(input, signal)
					: { output: { kind: "silent" } as HookOutput }),
				state: status,
				registration: id,
				revision: this.revision,
				waitToken: interrupted,
			};
		};
		const first = await inspect();
		if (!["queued", "running"].includes(first.state ?? "") || input["revision"] !== this.revision) return first;
		let wake: () => void = () => undefined;
		const change = new Promise<void>((resolve) => {
			wake = resolve;
			this.listeners.add(wake);
		});
		try {
			if (first.revision === this.revision)
				await waitWithSignal(change, AbortSignal.any([signal, AbortSignal.timeout(BUDGET.hookWait)])).catch(
					(error: unknown) => {
						if (signal.aborted) throw error;
					},
				);
			return await inspect();
		} finally {
			this.listeners.delete(wake);
		}
	}
	async request(raw: Record<string, unknown>, signal: AbortSignal): Promise<HookResult> {
		const input = normalizeHook(raw);
		if (!input) return { output: { kind: "silent" } };
		const session = text(input["session_id"]),
			event = text(input["hook_event_name"]);
		if (event === "SessionEnd" || event === "Interrupt") {
			const turn = text(input["turn_id"]);
			if (event === "Interrupt")
				await new Metadata(this.root).update(session, signal, (state) => {
					if (state.turn === "__ended__") return false;
					if (turn) state.interrupts[turn] = (state.interrupts[turn] ?? 0) + 1;
					else state.waitEpoch++;
					return true;
				});
			for (const job of this.tasks)
				if (
					rootSession(job.initial.session) === session &&
					(event === "SessionEnd" || (turn && job.entries.every((entry) => text(entry.input["turn_id"]) === turn)))
				)
					job.controller.abort();
			await this.hooks.cancel(session, event === "SessionEnd" ? undefined : turn || null, signal);
			this.changed();
			return { output: { kind: "silent" } };
		}
		if (event === "PostToolUse" && writeIntent(this.root, input).kind === "read") return this.delivery(input, signal);
		await this.ingest();
		if (event === "SessionStart") return this.delivery(input, signal);
		if (input["stop_hook_active"] === true) return { output: { kind: "silent" } };
		const id = text(input["registration"]);
		if (event === "PostToolUse") {
			const state = await new Metadata(this.root).read(hookSession(input));
			return {
				output: { kind: "silent" },
				registration: id,
				state: state.hookEvents[id]?.state ?? "missing",
				revision: this.revision,
				waitToken: await this.waitToken(input),
			};
		}
		const config = await configuration(this.root),
			gate = event === "Stop" && config.stopGate === "introduced-errors";
		const jobs = [...this.tasks].filter((job) => job.initial.session === hookSession(input));
		const waiting = AbortSignal.any([signal, AbortSignal.timeout(gate ? BUDGET.stopWait : BUDGET.ordinaryWait)]);
		await waitWithSignal(Promise.allSettled(jobs.map((job) => job.done)), waiting).catch((error: unknown) => {
			if (signal.aborted) throw error;
		});
		let delivery = await this.delivery(input, signal);
		if (delivery.output.kind === "silent" && config.automaticDiagnostics.stop !== "off") {
			const store = new Metadata(this.root),
				target = hookSession(input);
			await store.update(target, signal, async (state) => {
				if (state.turn === "__ended__") return false;
				const pending = Math.max(
					state.pending.length,
					[...this.tasks].some((job) => job.initial.session === target) ? 1 : 0,
				);
				if (!pending) return false;
				await queueDelivery(
					store,
					{ ...state, turn: text(input["turn_id"], state.turn) },
					{
						kind: "context",
						event,
						context: `Automatic diagnostics: introduced=0; resolved=0; unattributed=0; pending=${pending}. Checks still running; results pending. Details: diagnostics(run=cached, scope=session).`,
					},
					{},
					config.version,
					"",
				);
				return true;
			});
			delivery = await this.delivery(input, signal);
		}
		return delivery;
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		for (const job of this.tasks) job.controller.abort();
		this.changed();
		await Promise.allSettled([...this.tasks].map((job) => job.done));
	}
}
