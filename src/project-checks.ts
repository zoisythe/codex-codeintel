import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import * as nodePath from "node:path";
import { basename, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parse as parseToml } from "smol-toml";
import { BUDGET } from "./budgets.js";
import { assertConfiguration, type Config, configuration } from "./config.js";
import { configurationImpact, configurationLanguages } from "./config-files.js";
import { addedFindings } from "./diagnostic-delta.js";
import { withExecution } from "./environment.js";
import { hash, type Inventory, inventory, workspacePath } from "./files.js";
import { analysisIdentity } from "./identity.js";
import { Metadata } from "./metadata.js";
import { projectOutput } from "./project-output.js";
import type { CheckerResult, ProjectCheck, ProjectResult } from "./project-types.js";
import { type Finding, message, record, text } from "./results.js";
import { run, select } from "./runners.js";
import { codeLanguage, resolveTool } from "./tool-resolution.js";

interface Job {
	id: string;
	identity: string;
	checks: ProjectCheck[];
	results: CheckerResult[];
	controller: AbortController;
	done: Promise<void>[];
	before: string;
	configuration: string;
	environment: NodeJS.ProcessEnv;
}
function normalizedPattern(pattern: string): string {
	return pattern.replace(/^(?:\.\/)+/, "").replace(/\/$/, "");
}
function includePattern(pattern: string): string {
	const normalized = normalizedPattern(pattern);
	if (normalized === "." || normalized === "") return "**/*";
	if (/[*?{}[\]]/.test(normalized) || /\.(?:[cm]?[jt]sx?|pyi?)$/.test(normalized)) return normalized;
	return `${normalized}/**/*`;
}
export function covers(
	check: Pick<ProjectCheck, "cwd" | "coverage"> & { excluded?: string[]; parser?: ProjectCheck["parser"] },
	path: string,
): boolean {
	if ((check.parser === "ty" || check.parser === "ruff") && !/\.pyi?$/.test(path)) return false;
	if (check.parser === "tsc" && !/\.[cm]?[jt]sx?$/.test(path)) return false;
	if (check.parser === "cargo" && !/\.rs$/.test(path)) return false;
	const local = relative(check.cwd === "." ? "" : check.cwd, path)
		.split("\\")
		.join("/");
	return (
		local !== ".." &&
		!local.startsWith("../") &&
		check.coverage.some((pattern) => nodePath.matchesGlob(local, pattern)) &&
		!check.excluded?.some((pattern) => {
			const normalized = normalizedPattern(pattern);
			return (
				normalized === "." ||
				normalized === "" ||
				nodePath.matchesGlob(local, normalized) ||
				nodePath.matchesGlob(local, `${normalized}/**`)
			);
		})
	);
}
export class ProjectChecks {
	private readonly jobs = new Map<string, Job>();
	private readonly sessionJobs = new Map<string, string>();
	cancelSession(session: string): void {
		const id = this.sessionJobs.get(session);
		if (id) this.jobs.get(id)?.controller.abort();
		this.sessionJobs.delete(session);
	}
	private latest: string | undefined;
	status(configuration?: string): unknown {
		const job = this.latest ? this.jobs.get(this.latest) : undefined;
		return job ? this.cachedOutput(job, 0, configuration) : { state: "unverified", checkers: [] };
	}
	constructor(private readonly root: string) {}
	get active(): boolean {
		return [...this.jobs.values()].some((job) => job.results.some((result) => result.state === "running"));
	}
	private async discover(config: Config, signal: AbortSignal): Promise<ProjectCheck[]> {
		if (config.projectChecks !== "auto") return [...config.projectChecks];
		const checks: ProjectCheck[] = [];
		const names = await readdir(this.root);
		const has = async (name: string) => (await stat(join(this.root, name)).catch(() => undefined))?.isFile();
		if (await has("tsconfig.json")) {
			checks.push({
				name: "typescript",
				cwd: ".",
				command: ["tsc", "--noEmit", "--pretty", "false"],
				parser: "tsc",
				coverage: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
			});
		}
		if (names.some((name) => ["pyproject.toml", "ty.toml", "ruff.toml", ".ruff.toml"].includes(name)))
			checks.push({
				name: "python",
				cwd: ".",
				command: ["ty", "check", "--output-format", "concise", "--color", "never"],
				parser: "ty",
				coverage: ["**/*.{py,pyi}"],
			});
		if (await has("Cargo.toml"))
			checks.push({
				name: "rust",
				cwd: ".",
				command: ["cargo", "check", "--workspace", "--all-targets", "--message-format=json"],
				parser: "cargo",
				coverage: ["**/*.rs"],
			});
		for (const path of ["representative.py", "representative.ts"]) {
			const enabled = path.endsWith("py")
				? checks.some((check) => check.name === "python")
				: checks.some((check) => check.name === "typescript") ||
					names.some(
						(name) =>
							configurationImpact(name).includes("lint") &&
							configurationLanguages(name).includes("typescript") &&
							!/^(?:package|pnpm-lock|yarn\.lock)/.test(name),
					);
			if (!enabled) continue;
			const expected = path.endsWith("py")
				? "ruff"
				: config.javascript === "eslint" || (!(await has("biome.json")) && !(await has("biome.jsonc")))
					? "eslint"
					: "biome";
			const runner = await select(this.root, join(this.root, path), false, config, false, signal).catch(() => ({
				name: expected as "ruff" | "eslint" | "biome",
				command: expected,
				prefix: [],
			}));
			if (runner)
				checks.push({
					name: runner.name,
					cwd: ".",
					command: [
						runner.command,
						...runner.prefix,
						...(runner.name === "ruff"
							? ["check", "--no-fix", "--no-fix-only", "--no-cache", "--output-format", "json", "."]
							: runner.name === "biome"
								? ["lint", "--reporter=json", "--max-diagnostics=none", "."]
								: ["--format", "json", "."]),
					],
					parser: runner.name,
					coverage: path.endsWith("py") ? ["**/*.{py,pyi}"] : ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
				});
		}
		return checks;
	}
	private async identity(checks: ProjectCheck[], config: Config, signal: AbortSignal): Promise<string> {
		const identities = await Promise.all(
			checks.map(async (check) => {
				const cwd = await workspacePath(this.root, check.cwd);
				const tool = await resolveTool(
					config.projectChecks === "auto" ? this.root : cwd,
					join(cwd, "representative"),
					check.command,
					config.projectChecks !== "auto",
					false,
				);
				return [
					check,
					tool,
					await Promise.all(
						// Source arguments and directory mtimes change on ordinary edits.
						// Only interpreter launch scripts belong to the tool identity.
						tool.command
							.slice(1)
							.filter(
								(arg, index, args) =>
									/^(?:node|python(?:\d+(?:\.\d+)*)?|bash|sh)(?:\.exe)?$/.test(
										basename(tool.command[0] ?? ""),
									) &&
									/\.(?:[cm]?js|py|sh)$/.test(arg) &&
									!args.slice(0, index).some((previous) => /\.(?:[cm]?js|py|sh)$/.test(previous)),
							)
							.map(async (arg) => {
								const info = await stat(resolve(cwd, arg)).catch(() => undefined);
								return [arg, info?.size, info?.mtimeMs, info?.ctimeMs, info?.ino];
							}),
					),
					await analysisIdentity(
						this.root,
						[relative(this.root, join(cwd, "representative"))],
						config,
						signal,
						false,
					),
				];
			}),
		);
		return hash(JSON.stringify([config.version, identities]));
	}
	private output(job: Job, cursor = 0): ProjectResult {
		const diagnostics = job.results.flatMap((result) => result.findings);
		const state = job.results.some((result) => result.state === "running")
			? "running"
			: job.results.some((result) => result.state === "stale")
				? "stale"
				: job.results.some((result) => result.state === "failed") || !job.checks.length
					? "failed"
					: "complete";
		return {
			operation: "check_project",
			job: job.id,
			state,
			checkers: job.results.map((result) => ({ ...result, findings: [] })),
			diagnostics: diagnostics.slice(cursor, cursor + 100),
			errors: diagnostics.filter((item) => item.severity === "error").length,
			warnings: diagnostics.filter((item) => item.severity === "warning").length,
			...(state === "running" || diagnostics.length > cursor + 100
				? {
						next: {
							workspace: this.root,
							run: "cached",
							job: job.id,
							cursor: diagnostics.length > cursor + 100 ? String(cursor + 100) : "0",
						},
					}
				: {}),
		};
	}
	private cachedOutput(job: Job, cursor: number, configuration?: string): ProjectResult {
		const output = this.output(job, cursor);
		if (configuration === undefined || configuration === job.configuration) return output;
		return {
			...output,
			state: "stale",
			checkers: output.checkers.map((result) => ({
				...result,
				state: "stale",
				note: "Configuration changed; cached diagnostics only",
			})),
		};
	}
	async request(
		args: Record<string, unknown>,
		environment: NodeJS.ProcessEnv,
		signal: AbortSignal,
	): Promise<ProjectResult> {
		const cached = args["run"] === "cached";
		const id = text(args["job"], this.latest);
		let job = id ? this.jobs.get(id) : undefined;
		if (cached)
			return job
				? this.cachedOutput(job, this.cursor(args), (await configuration(this.root)).version)
				: {
						operation: "check_project",
						job: id,
						state: "missing",
						checkers: [],
						diagnostics: [],
						errors: 0,
						warnings: 0,
					};
		const config = await configuration(this.root);
		assertConfiguration(config);
		const checks = await this.discover(config, signal);
		const identity = await this.identity(checks, config, signal);
		const before = await inventory(this.root, BUDGET.files, signal, config.exclude);
		if (!before.complete) throw new Error("Project snapshot incomplete; baseline unavailable");
		if (!job || args["refresh"] === true || job.identity !== identity || job.before !== before.version) {
			job = await this.start(checks, config, environment, identity, before);
		}
		const wait =
			typeof args["waitMs"] === "number" ? Math.min(BUDGET.stopWait, Math.max(0, args["waitMs"])) : BUDGET.postWait;
		await Promise.race([Promise.allSettled(job.done), delay(wait, undefined, { signal }).catch(() => undefined)]);
		return this.output(job, this.cursor(args));
	}
	private cursor(args: Record<string, unknown>): number {
		const cursor = Number(text(args["cursor"], "0"));
		if (!Number.isInteger(cursor) || cursor < 0) throw new Error("Invalid project cursor");
		return cursor;
	}
	private async start(
		checks: ProjectCheck[],
		config: Config,
		environment: NodeJS.ProcessEnv,
		identity: string,
		before: Inventory,
	): Promise<Job> {
		const job: Job = {
			id: randomUUID(),
			identity,
			configuration: config.version,
			environment,
			before: before.version,
			checks,
			controller: new AbortController(),
			results: checks.map((check) => ({
				name: check.name,
				parser: check.parser,
				cwd: check.cwd,
				coverage: check.coverage,
				state: "running",
				findings: [],
			})),
			done: [],
		};
		this.jobs.set(job.id, job);
		this.latest = job.id;
		for (const [index, check] of checks.entries())
			job.done.push(
				withExecution(environment, true, async () => {
					const result = job.results[index];
					if (!result) return;
					const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(BUDGET.project)]);
					try {
						const cwd = await workspacePath(this.root, check.cwd);
						const checkIdentity = await this.identity([check], config, signal);
						const beforeFiles = before;
						const tool = await resolveTool(
							config.projectChecks === "auto" ? this.root : cwd,
							join(cwd, "representative"),
							check.command,
							config.projectChecks !== "auto",
							false,
						);
						if (tool.source === "missing") throw new Error(tool.note ?? "Checker missing");
						if (config.projectChecks === "auto" && check.parser === "tsc") {
							const shown = await run(tool.command[0] ?? "", ["--showConfig"], cwd, signal, undefined, {
								timeout: BUDGET.project,
								environment,
							});
							const data: unknown = JSON.parse(shown.stdout);
							if (shown.code !== 0 || !record(data))
								throw new Error("TypeScript effective configuration unavailable");
							const pkg: unknown = JSON.parse(
								await readFile(join(cwd, "package.json"), "utf8").catch(() => "{}"),
							);
							if (
								(Array.isArray(data["references"]) && data["references"].length) ||
								(record(pkg) && pkg["workspaces"])
							)
								throw new Error("TypeScript references/multi-package projects require explicit projectChecks");
							const includes = data["include"];
							const files = data["files"];
							const excluded = data["exclude"];
							result.coverage = Array.isArray(includes)
								? includes.filter((item): item is string => typeof item === "string").map(includePattern)
								: Array.isArray(files)
									? files
											.filter((item): item is string => typeof item === "string")
											.map((item) => item.replace(/^\.\//, ""))
									: ["**/*.{ts,tsx,mts,cts}"];
							result.excluded = Array.isArray(excluded)
								? excluded.filter((item): item is string => typeof item === "string")
								: [];
							const compiler = record(data["compilerOptions"]) ? data["compilerOptions"] : {};
							if (compiler["allowJs"] !== true || compiler["checkJs"] !== true)
								result.excluded.push("**/*.{js,jsx,mjs,cjs}");
						}
						if (config.projectChecks === "auto" && check.parser === "ty") {
							const content = await readFile(join(cwd, "ty.toml"), "utf8").catch(() => undefined);
							const data = content
								? parseToml(content)
								: parseToml(await readFile(join(cwd, "pyproject.toml"), "utf8").catch(() => ""));
							const toolConfig = content
								? data
								: record(data["tool"]) && record(data["tool"]["ty"])
									? data["tool"]["ty"]
									: {};
							const src = record(toolConfig["src"]) ? toolConfig["src"] : {};
							if (Array.isArray(src["include"]))
								result.coverage = src["include"]
									.filter((item): item is string => typeof item === "string")
									.map(includePattern);
							if (Array.isArray(src["exclude"]))
								result.excluded = src["exclude"].filter((item): item is string => typeof item === "string");
						}

						const output = await run(tool.command[0] ?? "", tool.command.slice(1), cwd, signal, undefined, {
							timeout: BUDGET.project,
							environment,
						});
						result.findings = await projectOutput(
							check,
							output.stdout + (["tsc", "ty", "sarif"].includes(check.parser) ? output.stderr : ""),
							this.root,
							cwd,
						);
						if (
							output.code !== 0 &&
							!(
								result.findings.length &&
								(output.code === 1 ||
									(check.parser === "tsc" && output.code === 2) ||
									(check.parser === "cargo" && output.code === 101))
							)
						)
							throw new Error(output.stderr || `Checker exit ${output.code} without located diagnostics`);
						if ((await this.identity([check], await configuration(this.root), signal)) !== checkIdentity)
							throw new Error("Checker configuration/tool changed during baseline");
						const afterFiles = await inventory(this.root, BUDGET.files, signal, config.exclude);
						const relevant = [...new Set([...beforeFiles.files.keys(), ...afterFiles.files.keys()])].filter(
							(path) => covers(result, path) || configurationImpact(path).length > 0,
						);
						if (
							!afterFiles.complete ||
							relevant.some((path) => beforeFiles.files.get(path) !== afterFiles.files.get(path))
						)
							throw new Error("Project changed while establishing baseline; retry before editing");

						result.state = "complete";
					} catch (error) {
						result.state = "failed";
						result.note = message(error);
					}
				}),
			);
		while (this.jobs.size > 32) {
			const first = [...this.jobs.values()].find(
				(entry) => entry.id !== job.id && entry.results.every((result) => result.state !== "running"),
			);
			if (!first) break;
			this.jobs.delete(first.id);
		}
		return job;
	}
	async baseline(
		session: string,
		paths: string[] | undefined,
		environment: NodeJS.ProcessEnv,
		signal: AbortSignal,
		wait: number,
	): Promise<{
		reference: string;
		findings: Finding[];
		pending: string[];
		failures: string[];
		reliable: Record<string, string[]>;
		covered: string[];
	}> {
		const config = await configuration(this.root);
		assertConfiguration(config);
		const store = new Metadata(this.root);
		const state = await store.read(session);
		const checks = await this.discover(config, signal);
		const identity = await this.identity(checks, config, signal);
		let job: Job | undefined;
		let recovered: { identity: string; results: CheckerResult[]; before: string } | undefined;
		if (state.diagnosticBaseline) {
			const data = await store.readShared(state.diagnosticBaseline);
			if (record(data) && data["identity"] === identity && Array.isArray(data["results"]))
				recovered = data as unknown as typeof recovered;
		}
		if (recovered?.results.some((result) => result.state === "running")) recovered = undefined;
		if (!recovered) {
			job = [...this.jobs.values()].find(
				(entry) => entry.id === state.shown["baselineJob"] && entry.identity === identity,
			);
			if (!job) {
				if (state.edited)
					throw new Error(
						"Editing has already occurred; cannot create a pre-edit diagnostic baseline. Restart the session or explicitly disable automatic diagnostics",
					);
				const snapshot = await inventory(this.root, BUDGET.files, signal, config.exclude);
				if (!snapshot.complete) throw new Error("Baseline inventory incomplete");
				job = await this.start(checks, config, environment, identity, snapshot);
				this.sessionJobs.set(session, job.id);
				await store.update(session, signal, (current) => {
					if (current.epoch !== state.epoch || current.turn === "__ended__") return false;
					current.shown["baselineJob"] = job?.id ?? "";
					return true;
				});
			}
			const selected = job.checks
				.map((check, index) => ({ check, index }))
				.filter(({ check }) => !paths || paths.some((path) => covers(check, path)));
			await Promise.race([
				Promise.allSettled(selected.map(({ index }) => job?.done[index])),
				delay(wait, undefined, { signal }).catch(() => undefined),
			]);
			recovered = { identity, results: job.results, before: job.before };
		}
		const results = recovered.results;
		const reference = await store.shared(recovered);
		await store.update(session, signal, (current) => {
			if (current.epoch !== state.epoch || current.turn === "__ended__") return false;
			current.diagnosticBaseline = reference;
			current.configuration = config.version;
			return true;
		});
		const snapshot = paths ? undefined : await inventory(this.root, BUDGET.files, signal, config.exclude);
		const targets =
			paths ??
			[...(snapshot?.files.keys() ?? [])].filter(
				(path) => codeLanguage(config, path) && !/(?:json|yaml|css|html)$/.test(codeLanguage(config, path) ?? ""),
			);
		const failures: string[] = [];
		const pending: string[] = [];
		const reliable: Record<string, string[]> = {};
		const covered: string[] = [];
		for (const path of targets) {
			if (!codeLanguage(config, path)) continue;
			const related = results.filter((result) => covers(result, path));
			reliable[path] = related.filter((result) => result.state === "complete").map((result) => result.parser);
			const language = codeLanguage(config, path);
			const required =
				language === "typescript" && /\.[cm]?tsx?$/.test(path)
					? "tsc"
					: language === "python"
						? "ty"
						: language === "rust"
							? "cargo"
							: undefined;
			if (config.projectChecks === "auto" && required && !related.some((result) => result.parser === required))
				failures.push(`${path}: no type checker coverage; configure projectChecks`);
			if (!related.length) failures.push(`${path}: no project checker coverage; configure projectChecks`);
			if (
				related.length &&
				related.every((result) => result.state === "complete") &&
				!(config.projectChecks === "auto" && required && !related.some((result) => result.parser === required))
			)
				covered.push(path);
			for (const result of related) {
				if (result.state === "running") pending.push(result.name);
				else if (result.state !== "complete") failures.push(`${result.name}: ${result.note ?? result.state}`);
			}
		}
		return {
			reference,
			reliable,
			covered,
			findings: results.filter((result) => result.state === "complete").flatMap((result) => result.findings),
			failures: [...new Set(failures)],
			pending: [...new Set(pending)],
		};
	}
	async introduced(
		session: string,
		paths: string[],
		environment: NodeJS.ProcessEnv,
		signal: AbortSignal,
		wait: number,
	): Promise<Finding[]> {
		const baseline = await this.baseline(session, paths, environment, signal, 0);
		const store = new Metadata(this.root);
		const data = await store.readShared(baseline.reference);
		if (!record(data) || !Array.isArray(data["results"])) return [];
		const before = data["results"] as CheckerResult[];
		const output = await this.request({ waitMs: wait }, environment, signal);
		const job = this.jobs.get(output.job);
		if (!job || job.identity !== data["identity"]) return [];
		return job.results.flatMap((result) => {
			const old = before.find((item) => item.name === result.name && item.parser === result.parser);
			if (result.state !== "complete" || old?.state !== "complete") return [];
			return addedFindings(old.findings, result.findings).filter(
				(finding) =>
					paths.includes(finding.path) && baseline.covered.includes(finding.path) && covers(result, finding.path),
			);
		});
	}
	async revalidate(): Promise<void> {
		for (const job of this.jobs.values()) {
			if (!job.results.some((result) => result.state === "running")) continue;
			await withExecution(job.environment, true, async () => {
				const config = await configuration(this.root);
				if (config.version !== job.configuration || !config.valid) job.controller.abort();
			});
		}
	}
	async dispose(): Promise<void> {
		for (const job of this.jobs.values()) job.controller.abort();
		await Promise.allSettled([...this.jobs.values()].flatMap((job) => job.done));
	}
}
