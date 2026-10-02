import { rm } from "node:fs/promises";
import { BUDGET } from "./budgets.js";
import { waitWithSignal } from "./deadline.js";
import { withExecution } from "./environment.js";
import { consumeDelivery } from "./hook-delivery.js";
import type { HookEngine, HookOutput } from "./hook-engine.js";
import { type RegisteredHook, registeredHooks } from "./hook-inbox.js";
import { logEvent } from "./log.js";
import { Metadata } from "./metadata.js";
import { text } from "./results.js";
import { writeIntent } from "./write-intent.js";

interface BackgroundHook {
	controller: AbortController;
	done: Promise<void>;
	registrations: Set<string>;
	initial: RegisteredHook;
}

export class HookCoordinator {
	private readonly jobs = new Map<string, BackgroundHook>();
	private readonly tasks = new Set<BackgroundHook>();
	private readonly seen = new Set<string>();
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
		return [...this.jobs].map(([key]) => ({ key, state: "running" }));
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
			const state = await withExecution(entry.environment, true, () =>
				new Metadata(this.root).read(text(entry.input["session_id"])),
			);
			if (state.epoch !== entry.epoch) {
				await rm(entry.path, { force: true });
				continue;
			}
			this.seen.add(entry.path);
			const key = `${text(entry.input["session_id"])}:${text(entry.input["hook_event_name"])}`;
			const previous = this.jobs.get(key);
			if (previous) {
				if (entry.input["hook_event_name"] === "SessionStart") {
					previous.registrations.add(entry.path);
					continue;
				}
				// New discovery must not wait behind an older LSP collection. It
				// advances generation and lets Automatic cancel the stale analysis.
				previous.controller.abort();
			}
			const job: BackgroundHook = {
				initial: entry,
				controller: new AbortController(),
				done: Promise.resolve(),
				registrations: new Set([entry.path]),
			};
			this.jobs.set(key, job);
			this.tasks.add(job);
			if (entry.input["hook_event_name"] === "SessionStart") this.onStart(entry);
			job.done = this.run(key, job);
		}
	}
	private async run(key: string, job: BackgroundHook): Promise<void> {
		const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(BUDGET.project)]);
		try {
			await withExecution(job.initial.environment, true, () => this.hooks.hook(job.initial.input, signal, true));
		} catch {
			// Keep uncertain ranges in metadata; foreground shell calls remain available.
			if (!signal.aborted) await logEvent("background-failure");
		} finally {
			if (this.jobs.get(key) === job) this.jobs.delete(key);
			for (const path of job.registrations) {
				await rm(path, { force: true }).catch(() => logEvent("cancel-cleanup-failure"));
				this.seen.delete(path);
			}
			this.tasks.delete(job);
		}
	}
	async request(
		input: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<{ output: HookOutput; deliveryId?: string }> {
		const began = Date.now();
		const session = text(input["session_id"]);
		const event = text(input["hook_event_name"], "PostToolUse");
		if (event === "PreToolUse") return { output: await this.hooks.hook(input, signal) };
		if (event === "SessionEnd") {
			for (const job of this.tasks) if (text(job.initial.input["session_id"]) === session) job.controller.abort();
			return { output: await this.hooks.hook(input, signal) };
		}
		if (event === "PostToolUse" && writeIntent(this.root, input).kind === "read")
			return consumeDelivery(this.root, session, event, signal);
		await this.ingest();
		if (event === "SessionStart" || input["stop_hook_active"] === true) return { output: { kind: "silent" } };
		const key = `${session}:${event}`;
		const job = this.jobs.get(key);
		let pending = false;
		if (job) {
			const wait = event === "Stop" || event === "SubagentStop" ? BUDGET.stopWait : BUDGET.postWait;
			const waiting = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, wait - (Date.now() - began)))]);
			try {
				await waitWithSignal(job.done, waiting);
			} catch (error) {
				if (signal.aborted || !waiting.aborted) throw error;
				pending = true;
			}
		}
		const delivery = await consumeDelivery(this.root, session, event, signal);
		return pending && delivery.output.kind === "silent"
			? {
					output: {
						kind: "context",
						event,
						context:
							"[Codex CodeIntel automatic diagnostics] Checks still running; results pending. Background work continues and later Hooks can retrieve results.",
					},
				}
			: delivery;
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		for (const job of this.tasks) job.controller.abort();
		await Promise.allSettled([...this.tasks].map((job) => job.done));
	}
}
