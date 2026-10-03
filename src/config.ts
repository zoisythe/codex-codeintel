import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { executionEnvironment } from "./environment.js";
import { hash } from "./files.js";
import { BUILTIN_SERVERS } from "./lsp/server-definitions.js";
import type { ProjectCheck } from "./project-types.js";
import { record } from "./results.js";

export interface Server {
	readonly id: string;
	readonly command: readonly string[];
	readonly extensions: readonly string[];
	readonly explicit: boolean;
	readonly source: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly initialization?: Readonly<Record<string, unknown>>;
}
export interface Config {
	readonly schemaVersion: 1;
	readonly projectChecks: "auto" | readonly ProjectCheck[];
	readonly automaticDiagnostics: Readonly<{ postToolUse: "delta" | "off"; stop: "errors" | "off" }>;
	readonly javascript: "auto" | "biome" | "eslint" | "off";
	readonly python: "auto" | "ruff" | "off";
	readonly exclude: string[];
	readonly version: string;
	readonly user: string;
	readonly project: string;
	readonly stopGate: "off" | "introduced-errors";
	readonly issues: readonly ConfigIssue[];
	readonly sources: readonly { path: string; exists: boolean }[];
	readonly valid: boolean;
	readonly formattingEnabled: boolean;
	readonly extensions: Readonly<Record<string, readonly string[]>>;
	readonly servers: Readonly<Record<string, Server | false>>;
	readonly formatting: Readonly<{ tabSize: number; insertSpaces: boolean }>;
}
export interface ConfigIssue {
	readonly source: string;
	readonly scope: string;
	readonly severity: "error" | "migration";
	readonly message: string;
}
export function configPaths(root: string): { user: string; project: string } {
	return {
		user: join(executionEnvironment()["CODEX_HOME"] ?? join(homedir(), ".codex"), "lsp-client.json"),
		project: join(root, ".codex", "lsp-client.json"),
	};
}
export function assertConfiguration(config: Config): void {
	if (!config.valid)
		throw new Error(
			`Configuration error: ${config.issues
				.filter((issue) => issue.scope === "configuration" && issue.severity === "error")
				.map((issue) => `${issue.source}: ${issue.message}`)
				.join("; ")}`,
		);
}
async function read(
	path: string,
	issues: ConfigIssue[],
	sources: { path: string; exists: boolean }[],
): Promise<Record<string, unknown>> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (record(error) && error["code"] === "ENOENT") {
			sources.push({ path, exists: false });
			return {};
		}
		issues.push({ source: path, scope: "configuration", severity: "error", message: "Cannot read configuration" });
		sources.push({ path, exists: true });
		return {};
	}
	sources.push({ path, exists: true });
	try {
		const value: unknown = JSON.parse(content);
		if (!record(value) || value["schemaVersion"] !== 1)
			throw new Error(
				"Migration required: schemaVersion: 1 and language-keyed lsp entries; see docs/usage.md#upgrade",
			);
		for (const key of Object.keys(value)) {
			if (["trustedWorkspaces", "trusted", "trust"].includes(key)) {
				issues.push({
					source: path,
					scope: key,
					severity: "migration",
					message: `Legacy ${key} is ignored; directory trust is no longer checked by this plugin`,
				});
			} else if (
				![
					"schemaVersion",
					"lsp",
					"lint",
					"exclude",
					"formatting",
					"automaticDiagnostics",
					"projectChecks",
					"stopGate",
				].includes(key)
			) {
				throw new Error(`Unknown configuration field ${key}`);
			}
		}
		return value;
	} catch (error) {
		issues.push({
			source: path,
			scope: "configuration",
			severity: "error",
			message:
				error instanceof SyntaxError ? "Invalid JSON" : error instanceof Error ? error.message : String(error),
		});
		return {};
	}
}
const defaults: Record<string, string> = {
	python: "ty",
	typescript: "typescript",
	cpp: "clangd",
	rust: "rust",
	bash: "bash",
	yaml: "yaml-ls",
	svelte: "svelte",
	astro: "astro",
	go: "gopls",
	lua: "lua-ls",
	java: "jdtls",
	html: "html",
	css: "css",
	json: "json",
};
const web = {
	html: { command: ["vscode-html-language-server", "--stdio"], extensions: [".html", ".htm"] },
	css: { command: ["vscode-css-language-server", "--stdio"], extensions: [".css", ".scss", ".less"] },
	json: { command: ["vscode-json-language-server", "--stdio"], extensions: [".json", ".jsonc"] },
};
const builtins: Record<string, unknown> = {
	...BUILTIN_SERVERS,
	...web,
	tsc: { command: ["tsc", "--lsp", "--stdio"], extensions: BUILTIN_SERVERS["typescript"]?.extensions },
	tsgo: { command: ["tsgo", "--lsp", "--stdio"], extensions: BUILTIN_SERVERS["typescript"]?.extensions },
};
function server(value: unknown, language: string, source: string): Server | false {
	if (value === false) return false;
	const builtin = typeof value === "string" ? builtins[value] : undefined;
	if (typeof value === "string" && !builtin) throw new Error(`Unknown built-in server ${value} for ${language}`);
	const item = builtin ?? value;
	if (!record(item)) throw new Error(`lsp.${language} must be a built-in name, custom server or false`);
	for (const key of Object.keys(item))
		if (!["command", "extensions", "env", "initialization"].includes(key))
			throw new Error(`Invalid lsp.${language}.${key}; priority/disabled were removed; use false to disable`);
	const command = item["command"];
	const extensions = item["extensions"];
	if (!Array.isArray(command) || !command.length || !command.every((v): v is string => typeof v === "string" && !!v))
		throw new Error(`lsp.${language}.command requires a nonempty string array`);
	if (
		!Array.isArray(extensions) ||
		!extensions.length ||
		!extensions.every((v): v is string => typeof v === "string" && /^\.[^/\\]+$/.test(v))
	)
		throw new Error(`lsp.${language}.extensions requires dot-prefixed extensions`);
	const env = item["env"];
	const initialization = item["initialization"];
	if (env !== undefined && (!record(env) || !Object.values(env).every((v) => typeof v === "string")))
		throw new Error(`Invalid lsp.${language}.env`);
	if (initialization !== undefined && !record(initialization))
		throw new Error(`Invalid lsp.${language}.initialization`);
	return {
		id: typeof value === "string" ? value : language,
		command,
		extensions,
		explicit: !builtin,
		source,
		...(env ? { env: env as Record<string, string> } : {}),
		...(initialization ? { initialization: initialization as Record<string, unknown> } : {}),
	};
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
export async function configuration(root: string): Promise<Config> {
	const paths = configPaths(root);
	const issues: ConfigIssue[] = [];
	const sources: { path: string; exists: boolean }[] = [];
	for (const key of Object.keys(executionEnvironment()))
		if ((key.startsWith("LSP_TOOLS_MCP_") && key.endsWith("_CONFIG")) || key === "CODEX_LSP_TRUST_PROJECT")
			issues.push({
				source: "environment",
				scope: key,
				severity: "migration",
				message: `Legacy ${key} is ignored; use $CODEX_HOME/lsp-client.json and <workspace>/.codex/lsp-client.json`,
			});
	const user = await read(paths.user, issues, sources);
	const project = await read(paths.project, issues, sources);
	const problem = (source: string, scope: string, error: unknown) =>
		issues.push({
			source,
			scope,
			severity: "error",
			message: error instanceof Error ? error.message : String(error),
		});
	const servers: Record<string, Server | false> = {};
	const extensions: Record<string, readonly string[]> = {};
	for (const [language, name] of Object.entries(defaults)) {
		const entry = server(name, language, "builtin");
		servers[language] = entry;
		if (entry) extensions[language] = entry.extensions;
	}
	let javascript: Config["javascript"] = "auto";
	let python: Config["python"] = "auto";
	let exclude: string[] = [];
	let formatting: Config["formatting"] = { tabSize: 4, insertSpaces: true };
	let formattingEnabled = true;
	let automaticDiagnostics: Config["automaticDiagnostics"] = { postToolUse: "off", stop: "off" };
	let projectChecks: Config["projectChecks"] = "auto";
	for (const [data, source] of [
		[user, paths.user],
		[project, paths.project],
	] as const) {
		if (data["lsp"] !== undefined) {
			if (!record(data["lsp"])) {
				problem(source, "lsp", "Invalid lsp; all LSP capabilities disabled");
				for (const language of Object.keys(servers)) servers[language] = false;
			} else
				for (const [language, value] of Object.entries(data["lsp"])) {
					try {
						servers[language] = server(value, language, source);
						const entry = servers[language];
						if (entry) extensions[language] = entry.extensions;
					} catch (error) {
						servers[language] = false;
						problem(source, `lsp.${language}`, error);
					}
				}
		}
		if (data["lint"] !== undefined) {
			const lint = data["lint"];
			if (!record(lint)) {
				javascript = python = "off";
				problem(source, "lint", "Invalid lint; lint capabilities disabled");
			} else
				for (const [key, value] of Object.entries(lint)) {
					if (
						key === "javascript" &&
						typeof value === "string" &&
						["auto", "biome", "eslint", "off"].includes(value)
					)
						javascript = value as Config["javascript"];
					else if (key === "python" && typeof value === "string" && ["auto", "ruff", "off"].includes(value))
						python = value as Config["python"];
					else {
						if (key === "python") python = "off";
						if (key === "javascript") javascript = "off";
						problem(source, `lint.${key}`, `Invalid lint.${key}`);
					}
				}
		}
		if (data["exclude"] !== undefined) {
			const value = data["exclude"];
			if (
				Array.isArray(value) &&
				value.every(
					(item): item is string =>
						typeof item === "string" &&
						!item.startsWith("!") &&
						!item.includes("\\") &&
						!isAbsolute(item) &&
						!item.split("/").includes(".."),
				)
			)
				exclude = value;
			else problem(source, "configuration", "exclude requires relative forward-slash globs without negation");
		}
		if (data["formatting"] !== undefined) {
			const value = data["formatting"];
			const merged = { ...formatting, ...(record(value) ? value : {}) };
			formattingEnabled =
				record(value) &&
				Object.keys(value).every((key) => ["tabSize", "insertSpaces"].includes(key)) &&
				Number.isInteger(merged.tabSize) &&
				merged.tabSize >= 1 &&
				merged.tabSize <= 16 &&
				typeof merged.insertSpaces === "boolean";
			if (formattingEnabled) formatting = merged;
			else
				problem(source, "formatting", "Invalid formatting.tabSize or formatting.insertSpaces; formatting disabled");
		}
		if (data["automaticDiagnostics"] !== undefined) {
			const value = data["automaticDiagnostics"];
			if (!record(value)) {
				automaticDiagnostics = { postToolUse: "off", stop: "off" };
				problem(source, "automaticDiagnostics", "Invalid automaticDiagnostics; automatic feedback disabled");
			} else
				for (const [key, mode] of Object.entries(value)) {
					if (key === "postToolUse" && (mode === "delta" || mode === "off"))
						automaticDiagnostics = { ...automaticDiagnostics, postToolUse: mode };
					else if (key === "stop" && (mode === "errors" || mode === "off"))
						automaticDiagnostics = { ...automaticDiagnostics, stop: mode };
					else {
						if (key === "postToolUse" || key === "stop")
							automaticDiagnostics = { ...automaticDiagnostics, [key]: "off" };
						problem(
							source,
							`automaticDiagnostics.${key}`,
							"Migration required: automaticDiagnostics uses postToolUse=delta/off and stop=errors/off; use check_project for full checks",
						);
					}
				}
		}
		if (data["projectChecks"] !== undefined) {
			const value = data["projectChecks"];
			if (value === "auto") projectChecks = "auto";
			else if (!Array.isArray(value)) {
				projectChecks = [];
				problem(source, "projectChecks", "projectChecks requires auto or a list; project checks disabled");
			} else {
				const checks: ProjectCheck[] = [];
				const names = new Set<string>();
				for (const [index, check] of value.entries()) {
					if (
						!record(check) ||
						Object.keys(check).some((key) => !["name", "cwd", "command", "parser", "coverage"].includes(key)) ||
						typeof check["name"] !== "string" ||
						!check["name"] ||
						names.has(check["name"]) ||
						typeof check["cwd"] !== "string" ||
						isAbsolute(check["cwd"]) ||
						check["cwd"].split(/[\\/]/).includes("..") ||
						!["tsc", "ty", "cargo", "ruff", "eslint", "biome", "json", "sarif"].includes(
							typeof check["parser"] === "string" ? check["parser"] : "",
						) ||
						!Array.isArray(check["command"]) ||
						!check["command"].length ||
						!check["command"].every((arg: unknown) => typeof arg === "string" && arg.length) ||
						!Array.isArray(check["coverage"]) ||
						!check["coverage"].length ||
						!check["coverage"].every(
							(arg: unknown) =>
								typeof arg === "string" &&
								!isAbsolute(arg) &&
								!arg.startsWith("!") &&
								!arg.includes("\\") &&
								!arg.split("/").includes(".."),
						)
					) {
						problem(
							source,
							`projectChecks.${record(check) ? (typeof check["name"] === "string" ? check["name"] : index) : index}`,
							"Invalid projectChecks entry: require unique name, relative cwd, command array, parser and coverage globs",
						);
						continue;
					}
					names.add(check["name"]);
					checks.push(check as unknown as ProjectCheck);
				}
				projectChecks = checks;
			}
		}
	}
	const used = new Map<string, string[]>();
	for (const [language, entry] of Object.entries(servers))
		if (entry)
			for (const extension of entry.extensions) used.set(extension, [...(used.get(extension) ?? []), language]);
	for (const [extension, languages] of used)
		if (languages.length > 1)
			for (const language of languages) {
				problem(
					servers[language] ? servers[language].source : "configuration",
					`lsp.${language}`,
					`Extension conflict ${extension}: ${languages.join(" and ")}; disable or replace the original language entry`,
				);
				servers[language] = false;
			}
	let stopGate: Config["stopGate"] = "off";
	if (user["stopGate"] === "off" || user["stopGate"] === "introduced-errors") stopGate = user["stopGate"];
	else if (user["stopGate"] !== undefined)
		problem(paths.user, "stopGate", "Invalid stopGate; expected off or introduced-errors; gate disabled");
	if (project["stopGate"] !== undefined)
		issues.push({
			source: paths.project,
			scope: "stopGate",
			severity: "migration",
			message: "Project stopGate is ignored; only user global configuration may enable the ending gate",
		});
	const valid = !issues.some((issue) => issue.scope === "configuration" && issue.severity === "error");
	if (!valid) automaticDiagnostics = { postToolUse: "off", stop: "off" };
	return freeze({
		schemaVersion: 1,
		projectChecks,
		automaticDiagnostics,
		stopGate,
		javascript,
		python,
		exclude,
		issues,
		sources,
		valid,
		formattingEnabled,
		...paths,
		extensions,
		servers,
		formatting,
		version: hash(
			JSON.stringify([
				projectChecks,
				automaticDiagnostics,
				stopGate,
				javascript,
				python,
				exclude,
				formatting,
				formattingEnabled,
				servers,
				extensions,
				issues.filter((issue) => issue.severity === "error"),
				paths,
			]),
		),
	});
}
