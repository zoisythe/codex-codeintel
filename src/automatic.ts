import { setTimeout as delay, setImmediate as yieldBatch } from "node:timers/promises";
import { BUDGET } from "./budgets.js";
import { configuration } from "./config.js";
import type { Engine } from "./engine.js";
import { withExecution } from "./environment.js";
import { hash } from "./files.js";
import { analysisIdentity } from "./identity.js";
import { Metadata } from "./metadata.js";
import { type FileResult, message, text } from "./results.js";

interface Job {
	session: string;
	epoch: string;
	turn: string;
	generation: number;
	scope: string;
	configuration: string;
	analysis: string;
	environment: NodeJS.ProcessEnv;
	paths: string[];
	results: Map<string, FileResult>;
	controller: AbortController;
	started: number;
	state: "running" | "complete" | "pending" | "cancelled";
	note: string;
	done: Promise<void>;
}
export interface AutomaticResult {
	generation: number;
	scope: string;
	state: "running" | "complete" | "pending" | "cancelled" | "stale";
	total: number;
	results: FileResult[];
	pending: string[];
	note: string;
}
export class Automatic {
	private readonly jobs = new Map<string, Job>();
	constructor(
		private readonly root: string,
		private readonly engine: Engine,
	) {}
	get active(): boolean {
		return [...this.jobs.values()].some((job) => job.state === "running");
	}
	status(): unknown {
		return [...this.jobs.values()].map((job) => ({
			session: job.session,
			generation: job.generation,
			scope: job.scope,
			state: job.state,
			total: job.paths.length,
			processed: job.results.size,
			checked: [...job.results.values()].filter((result) => result.state === "complete").length,
			remaining: job.paths.filter((path) => job.results.get(path)?.state !== "complete"),
			note: job.note,
		}));
	}
	cancel(session?: string): void {
		for (const job of this.jobs.values())
			if (!session || job.session === session) {
				job.controller.abort();
				job.state = "cancelled";
				this.jobs.delete(job.session);
			}
	}
	private result(job: Job): AutomaticResult {
		return {
			generation: job.generation,
			scope: job.scope,
			state: job.state,
			total: job.paths.length,
			results: [...job.results.values()],
			pending: job.paths.filter((path) => {
				const result = job.results.get(path);
				return result?.state !== "complete";
			}),
			note: job.note,
		};
	}
	async request(
		args: Record<string, unknown>,
		environment: NodeJS.ProcessEnv,
		signal: AbortSignal,
	): Promise<AutomaticResult> {
		const session = text(args["session"]);
		const store = new Metadata(this.root);
		const state = await store.read(session);
		if (state.turn === "__ended__" || state.generation !== args["generation"])
			return { generation: -1, scope: "delta", total: 0, note: "", results: [], pending: [], state: "stale" };
		const config = await configuration(this.root);
		if (!config.trusted) {
			this.cancel();
			throw new Error("Automatic LSP/lint requires workspace trust; lint requires workspace trust");
		}
		const requested = Array.isArray(args["paths"])
			? args["paths"].filter((path): path is string => typeof path === "string")
			: state.pending;
		const analysis = await analysisIdentity(this.root, requested, config, signal);
		let job = this.jobs.get(session);
		if (
			job &&
			(job.epoch !== state.epoch ||
				job.generation !== state.generation ||
				job.configuration !== config.version ||
				job.analysis !== analysis ||
				hash(JSON.stringify(job.environment)) !== hash(JSON.stringify(environment)))
		) {
			this.cancel(session);
			job = undefined;
		}
		const knownPaths = job?.paths ?? [];
		if (job && requested.some((path) => !knownPaths.includes(path))) {
			this.cancel(session);
			job = undefined;
		}
		if (!job) {
			const paths = Array.isArray(args["paths"])
				? args["paths"].filter((path): path is string => typeof path === "string")
				: state.pending;
			job = {
				session,
				epoch: state.epoch,
				turn: text(args["turn"], state.turn),
				generation: state.generation,
				scope: text(args["scope"], state.automaticScope),
				configuration: config.version,
				analysis,
				environment,
				paths: [...new Set(paths)],
				results: new Map(),
				controller: new AbortController(),
				started: Date.now(),
				state: "running",
				note: "",
				done: Promise.resolve(),
			};
			this.jobs.set(session, job);
			const target = job;
			job.done = withExecution(environment, true, () => this.run(target));
		}
		const target = job;
		const wait =
			typeof args["waitMs"] === "number" ? Math.max(0, Math.min(BUDGET.project, args["waitMs"])) : BUDGET.postWait;
		if (wait === 0) return this.result(target);
		const waiting = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, wait))]);
		await Promise.race([target.done, delay(wait, undefined, { signal: waiting }).catch(() => undefined)]);
		return this.result(target);
	}
	private async run(job: Job): Promise<void> {
		const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(BUDGET.project)]);
		const store = new Metadata(this.root);
		try {
			let remaining = [...job.paths];
			if (!remaining.length)
				await this.engine.dispatch("automatic_batch", { paths: [], session: job.session }, signal);
			while (remaining.length && !signal.aborted) {
				const retry: string[] = [];
				for (let start = 0; start < remaining.length; start += BUDGET.batch) {
					signal.throwIfAborted();
					const state = await store.read(job.session);
					const config = await configuration(this.root);
					if (
						state.turn === "__ended__" ||
						state.epoch !== job.epoch ||
						state.generation !== job.generation ||
						config.version !== job.configuration ||
						(await analysisIdentity(this.root, job.paths, config, signal)) !== job.analysis ||
						!config.trusted
					) {
						job.state = "cancelled";
						job.note = "Generation/configuration/trust changed; results stale";
						return;
					}
					const paths = remaining.slice(start, start + BUDGET.batch);
					const output = await this.engine.dispatch(
						"automatic_batch",
						{ paths, session: job.session, turn: job.turn },
						signal,
					);
					const results = output["results"] as FileResult[];
					if (
						(await analysisIdentity(this.root, job.paths, await configuration(this.root), signal)) !==
						job.analysis
					) {
						job.state = "cancelled";
						job.note = "Analysis identity changed; results stale";
						return;
					}
					await store.update(job.session, signal, (current) => {
						if (
							current.generation !== job.generation ||
							current.epoch !== job.epoch ||
							current.turn === "__ended__"
						)
							return false;
						for (const result of results) {
							job.results.set(result.path, result);
							const channels = result.channels ?? { lsp: result.state, lint: result.state };
							for (const channel of ["lsp", "lint"] as const) {
								current.pendingChannels[channel] = current.pendingChannels[channel].filter(
									(path) => path !== result.path,
								);
								if (
									channels[channel] === "pending" ||
									channels[channel] === "stale" ||
									channels[channel] === "failed" ||
									(channel === "lsp" && channels[channel] === "skipped")
								)
									current.pendingChannels[channel].push(result.path);
							}
							if (result.state === "complete")
								current.pending = current.pending.filter((path) => path !== result.path);
							if (result.state === "pending" || result.state === "stale") retry.push(result.path);
						}
						return true;
					});
					// The Engine queue lets already waiting foreground requests run here.
					await yieldBatch();
				}
				remaining = retry;
				if (remaining.length) await delay(1000, undefined, { signal });
			}
			job.state = job.paths.every((path) => job.results.get(path)?.state === "complete") ? "complete" : "pending";
		} catch (error) {
			job.state = job.controller.signal.aborted ? "cancelled" : "pending";
			job.note =
				signal.aborted && !job.controller.signal.aborted
					? "Automatic analysis exceeded five-minute budget; unfinished range retained"
					: message(error);
		}
	}
	async revalidate(): Promise<void> {
		for (const job of this.jobs.values()) {
			if (job.state !== "running") continue;
			await withExecution(job.environment, true, async () => {
				try {
					const config = await configuration(this.root);
					const state = await new Metadata(this.root).read(job.session);
					if (
						!config.trusted ||
						config.version !== job.configuration ||
						state.generation !== job.generation ||
						state.epoch !== job.epoch ||
						state.turn === "__ended__"
					)
						this.cancel(job.session);
				} catch {
					this.cancel(job.session);
				}
			});
		}
	}
	async dispose(): Promise<void> {
		const tasks = [...this.jobs.values()].map((job) => job.done);
		this.cancel();
		await Promise.allSettled(tasks);
	}
}
