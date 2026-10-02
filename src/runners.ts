import { spawn } from "node:child_process";
import { access, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { BUDGET } from "./budgets.js";
import { type Config, configuration } from "./config.js";
import { configurationImpact } from "./config-files.js";
import { automaticExecution, executionEnvironment, subprocessEnvironment } from "./environment.js";
import { createSpawnCommand, terminateProcessTree } from "./lsp/process.js";

export { trusted } from "./config.js";

import { inside, workspacePath } from "./files.js";
import { parseLint } from "./lint-output.js";
import { logEvent } from "./log.js";
import { measured } from "./metrics.js";
import { preparedRuff, rememberRuff } from "./prepared-tools.js";
import { HIDDEN_PROCESS } from "./process-options.js";
import { type FileResult, type FormatResult, message, record } from "./results.js";
import { languageFor, resolveTool } from "./tool-resolution.js";

export async function run(
	command: string,
	args: string[],
	cwd: string,
	signal: AbortSignal,
	input?: string,
	options: { timeout?: number; environment?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
	signal.throwIfAborted();
	const environment = subprocessEnvironment(options.environment ?? executionEnvironment());
	return new Promise((resolve, reject) => {
		const prepared = createSpawnCommand([command, ...args], process.platform, environment["ComSpec"], environment);
		const child = spawn(prepared.command, prepared.args, {
			...HIDDEN_PROCESS,
			cwd,
			env: environment,
			shell: prepared.shell,
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});
		const cancel = () => terminateProcessTree(child, "SIGKILL");
		signal.addEventListener("abort", cancel, { once: true });
		if (signal.aborted) cancel();
		let stdout = "";
		let stderr = "";
		let exceeded = false;
		const timer = setTimeout(() => {
			exceeded = true;
			void logEvent("timeout");
			terminateProcessTree(child, "SIGKILL");
		}, options.timeout ?? BUDGET.runner);
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
			if (Buffer.byteLength(stdout) > BUDGET.outputBytes) {
				exceeded = true;
				terminateProcessTree(child, "SIGKILL");
			}
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-4000);
		});
		child.once("error", (error) => {
			void logEvent("startup-failure");
			clearTimeout(timer);
			signal.removeEventListener("abort", cancel);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			signal.removeEventListener("abort", cancel);
			if (code !== 0 && code !== 1 && !signal.aborted) void logEvent("abnormal-exit");
			if (signal.aborted) reject(new Error("Runner cancelled"));
			else if (exceeded) reject(new Error("Runner exceeded time/output budget"));
			else resolve({ stdout, stderr, code: code ?? -1 });
		});
		child.stdin.on("error", () => {
			/* Child may reject stdin before consuming it. */
		});
		child.stdin.end(input);
	});
}
interface Runner {
	name: "biome" | "eslint" | "ruff";
	command: string;
	prefix: string[];
	source?: string;
}
async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
async function configured(root: string, path: string, names: string[]): Promise<boolean> {
	let dir = dirname(path);
	while (inside(root, dir)) {
		for (const name of names) if (await exists(join(dir, name))) return true;
		if (dir === root) break;
		dir = dirname(dir);
	}
	return false;
}
async function executable(
	root: string,
	target: string,
	packageName: string,
	entry: string,
): Promise<string | undefined> {
	let dir = dirname(target);
	while (inside(root, dir)) {
		const path = join(dir, "node_modules", packageName, entry);
		if (await exists(path)) return realpath(path);
		const parent = dirname(dir);
		if (dir === root) break;
		dir = parent;
	}
	return undefined;
}
async function javascriptRunner(
	root: string,
	path: string,
	name: "biome" | "eslint",
	packageName: string,
	entry: string,
): Promise<Runner> {
	const tool = await resolveTool(root, path, [name], false, false);
	if (tool.source === "project") return { name, command: tool.command[0] ?? name, prefix: [], source: "project" };
	const script = await executable(root, path, packageName, entry);
	if (script) return { name, command: process.execPath, prefix: [script], source: "project" };
	if (tool.source === "PATH") return { name, command: tool.command[0] ?? name, prefix: [], source: "PATH" };
	throw new Error(`${name}: configured tool is not installed`);
}
export async function select(
	root: string,
	path: string,
	formatting = false,
	provided?: Config,
	active = false,
	signal: AbortSignal = new AbortController().signal,
): Promise<Runner | undefined> {
	const config = provided ?? (await configuration(root));
	const extension = extname(path);
	const choice = formatting ? "auto" : /\.pyi?$/.test(extension) ? config.python : config.javascript;
	if (choice === "off") return undefined;
	if (/\.pyi?$/.test(extension)) {
		let tool = await resolveTool(root, path, ["ruff"], false, false);
		if (tool.source === "missing") {
			const prepared = await preparedRuff();
			if (prepared) return { name: "ruff", command: prepared, prefix: [], source: "prepared" };
			if (!active || automaticExecution() || !config.trusted)
				throw new Error(
					"Ruff unavailable: no local or prepared executable; run trusted active MCP diagnostics to prepare it. Hook never downloads tools",
				);
			tool = await resolveTool(root, path, ["ruff"]);
			if (tool.source === "missing") throw new Error(tool.note);
			const launcher = tool.command[0] ?? "";
			if (/^uvx?(?:\.exe)?$/.test(basename(launcher))) {
				const prepared = await run(
					launcher,
					[...tool.command.slice(1, -1), "python", "-c", "import shutil; print(shutil.which('ruff') or '')"],
					root,
					signal,
				);
				if (prepared.code !== 0 || !prepared.stdout.trim())
					throw new Error(`Ruff preparation failed: ${prepared.stderr}`);
				await rememberRuff(prepared.stdout.trim());
				return { name: "ruff", command: prepared.stdout.trim(), prefix: [], source: "prepared" };
			}
		}
		return { name: "ruff", command: tool.command[0] ?? "ruff", prefix: tool.command.slice(1), source: tool.source };
	}

	if (!/\.(?:[cm]?[jt]sx?|jsonc?|css)$/.test(path)) return undefined;
	if ((choice === "auto" || choice === "biome") && (await configured(root, path, ["biome.json", "biome.jsonc"])))
		return javascriptRunner(root, path, "biome", "@biomejs/biome", "bin/biome");
	if (
		(choice === "auto" || choice === "eslint") &&
		(await configured(root, path, [
			"eslint.config.js",
			"eslint.config.mjs",
			"eslint.config.cjs",
			"eslint.config.ts",
			".eslintrc.json",
			".eslintrc.cjs",
		]))
	)
		return javascriptRunner(root, path, "eslint", "eslint", "bin/eslint.js");
	if (choice !== "auto") throw new Error(`${choice}: matching project configuration missing`);
	return undefined;
}
export async function runnerIdentity(root: string, path: string, provided?: Config): Promise<string> {
	const config = provided ?? (await configuration(root));
	if (!config.trusted) return "untrusted";
	try {
		const runner = await select(root, path, false, config);
		if (!runner) return "none";
		const identities = await Promise.all(
			[runner.command, ...runner.prefix.filter((value) => value.includes("/"))].map(async (command) => {
				const info = await stat(command).catch(() => undefined);
				return [command, info?.size, info?.mtimeMs, info?.ino];
			}),
		);
		return JSON.stringify([runner, identities]);
	} catch {
		return "unavailable";
	}
}

export async function lint(
	root: string,
	path: string,
	signal: AbortSignal,
	provided?: Config,
	active = false,
): Promise<FileResult | undefined> {
	return (await lintBatch(root, [path], signal, provided, active)).get(path);
}
export async function lintBatch(
	root: string,
	paths: string[],
	signal: AbortSignal,
	provided?: Config,
	active = false,
): Promise<Map<string, FileResult>> {
	const config = provided ?? (await configuration(root));
	const results = new Map<string, FileResult>();
	if (!config.trusted) return results;
	const groups = new Map<string, { runner: Runner; cwd: string; paths: string[] }>();
	for (const path of paths) {
		try {
			const absolute = await workspacePath(root, path);
			const runner = languageFor(config, path)
				? await select(root, absolute, false, config, active, signal)
				: undefined;
			if (!runner) {
				results.set(path, {
					path,
					state: "skipped",
					findings: [],
					note: "lint off or no matching Runner configuration",
				});
				continue;
			}
			let cwd = dirname(absolute);
			while (cwd !== root && inside(root, cwd)) {
				const names = await import("node:fs/promises").then((fs) => fs.readdir(cwd));
				if (names.some((name) => configurationImpact(name).includes("lint"))) break;
				cwd = dirname(cwd);
			}
			const key = JSON.stringify([
				runner,
				cwd,
				await runnerIdentity(root, absolute, config),
				executionEnvironment(),
			]);
			const group = groups.get(key) ?? { runner, cwd, paths: [] };
			group.paths.push(path);
			groups.set(key, group);
		} catch (error) {
			results.set(path, { path, state: "failed", findings: [], note: `lint: ${message(error)}` });
		}
	}
	for (const { runner, cwd, paths: members } of groups.values()) {
		const batches: string[][] = [];
		let batch: string[] = [];
		let bytes = 0;
		for (const path of members) {
			const size = Buffer.byteLength(resolve(root, path)) + 3;
			if (batch.length && bytes + size > BUDGET.argvBytes) {
				batches.push(batch);
				batch = [];
				bytes = 0;
			}
			batch.push(path);
			bytes += size;
		}
		if (batch.length) batches.push(batch);
		for (const paths of batches) {
			try {
				const args =
					runner.name === "biome"
						? ["lint", "--reporter=json", "--max-diagnostics=none"]
						: runner.name === "eslint"
							? ["--format", "json"]
							: ["check", "--no-fix", "--no-fix-only", "--no-cache", "--output-format", "json", "--"];
				const output = await measured("lint", () =>
					run(
						runner.command,
						[...runner.prefix, ...args, ...paths.map((path) => resolve(root, path))],
						cwd,
						signal,
					),
				);
				if (output.code !== 0 && output.code !== 1) throw new Error(output.stderr || `Runner exit ${output.code}`);
				const data: unknown = JSON.parse(output.stdout);
				const split = splitLint(runner.name, data, root, cwd);
				for (const path of paths)
					results.set(path, {
						path,
						state: "complete",
						findings: parseLint(
							runner.name,
							split.get(path) ?? (runner.name === "biome" ? { diagnostics: [] } : []),
							path,
							await readFile(resolve(root, path), "utf8"),
						),
					});
			} catch (error) {
				for (const path of paths)
					results.set(path, {
						path,
						state: signal.aborted ? "pending" : "failed",
						findings: [],
						note: `lint: ${message(error)}`,
					});
			}
		}
	}
	return results;
}
export function splitLint(runner: string, data: unknown, root: string, cwd: string): Map<string, unknown> {
	const grouped = new Map<string, unknown[]>();
	const items = runner === "biome" && record(data) ? data["diagnostics"] : data;
	if (!Array.isArray(items)) throw new Error("Unexpected lint output");
	if (
		runner === "biome" &&
		record(data) &&
		record(data["summary"]) &&
		Number(data["summary"]["diagnosticsNotPrinted"]) > 0
	)
		throw new Error("Lint result truncated");
	for (const item of items) {
		if (!record(item)) throw new Error("Malformed lint result");
		const location = record(item["location"]) ? item["location"] : {};
		const biomePath = record(location["path"]) ? location["path"]["file"] : location["path"];
		const file = runner === "eslint" ? item["filePath"] : runner === "ruff" ? item["filename"] : biomePath;
		if (typeof file !== "string") throw new Error("Lint result has no file path");
		const path = relative(root, resolve(cwd, file));
		if (!inside(root, resolve(root, path))) throw new Error("Lint result outside workspace");
		const values = grouped.get(path) ?? [];
		values.push(item);
		grouped.set(path, values);
	}
	return new Map([...grouped].map(([path, items]) => [path, runner === "biome" ? { diagnostics: items } : items]));
}
export async function formatWithRunner(
	root: string,
	path: string,
	signal: AbortSignal,
	provided?: Config,
): Promise<FormatResult | undefined> {
	const config = provided ?? (await configuration(root));
	if (!config.trusted) return undefined;
	const absolute = await workspacePath(root, path);
	const runner = await select(root, absolute, true, config, true, signal);
	if (!runner || runner.name === "eslint") return undefined;
	const before = await readFile(absolute, "utf8");
	const args =
		runner.name === "biome"
			? ["format", `--stdin-file-path=${absolute}`]
			: ["format", "--no-cache", "--stdin-filename", absolute, "-"];
	const result = await run(runner.command, [...runner.prefix, ...args], dirname(absolute), signal, before);
	if (result.code !== 0) throw new Error(result.stderr || "Format failed");
	if ((await readFile(absolute, "utf8")) !== before) throw new Error("File changed during format; retry");
	if (before === result.stdout) return { status: "unchanged", path, modifiedPaths: [] };
	signal.throwIfAborted();
	await writeFile(absolute, result.stdout);
	return { status: "formatted", path, modifiedPaths: [path] };
}

export async function preflightRunner(
	root: string,
	path: string,
	config: Config,
	signal: AbortSignal,
): Promise<boolean> {
	if (!config.trusted) {
		if (/\.pyi?$/.test(path)) throw new Error("Python formatting with Ruff requires workspace trust");
		return false;
	}
	const runner = await select(root, await workspacePath(root, path), true, config, true, signal);
	if (!runner || runner.name === "eslint") return false;
	const result = await run(runner.command, [...runner.prefix, "--version"], root, signal);
	if (result.code !== 0) throw new Error(`${runner.name} preflight failed: ${result.stderr}`);
	return true;
}
