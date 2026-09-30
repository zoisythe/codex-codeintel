import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { executionEnvironment } from "./environment.js";
import { hash } from "./files.js";
import { BUILTIN_SERVERS } from "./lsp/server-definitions.js";
import type { ProjectCheck } from "./project-types.js";
import { record } from "./results.js";
import { type Trust, workspaceTrust } from "./trust.js";

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
	readonly trusted: boolean;
	readonly trust: Trust;
	readonly extensions: Readonly<Record<string, readonly string[]>>;
	readonly servers: Readonly<Record<string, Server | false>>;
	readonly formatting: Readonly<{ tabSize: number; insertSpaces: boolean }>;
}
export function configPaths(root: string): { user: string; project: string; codex: string } {
	for (const key of Object.keys(executionEnvironment()))
		if ((key.startsWith("LSP_TOOLS_MCP_") && key.endsWith("_CONFIG")) || key === "CODEX_LSP_TRUST_PROJECT")
			throw new Error(
				`Migration required: remove ${key}; use $CODEX_HOME/lsp-client.json (schemaVersion: 1) and <workspace>/.codex/lsp-client.json; trust comes from $CODEX_HOME/config.toml. See docs/usage.md#upgrade`,
			);
	return {
		user: join(executionEnvironment()["CODEX_HOME"] ?? join(homedir(), ".codex"), "lsp-client.json"),
		project: join(root, ".codex", "lsp-client.json"),
		codex: join(executionEnvironment()["CODEX_HOME"] ?? join(homedir(), ".codex"), "config.toml"),
	};
}
async function read(path: string): Promise<Record<string, unknown>> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!record(value) || value["schemaVersion"] !== 1)
			throw new Error(
				`Migration required: ${path} requires schemaVersion: 1 and language-keyed lsp entries; see docs/usage.md#upgrade`,
			);
		// Legacy trustedWorkspaces is accepted but grants no trust.
		for (const key of Object.keys(value))
			if (
				![
					"schemaVersion",
					"trustedWorkspaces",
					"lsp",
					"lint",
					"exclude",
					"formatting",
					"automaticDiagnostics",
					"projectChecks",
				].includes(key)
			)
				throw new Error(`Unknown configuration field ${key} in ${path}`);
		return value;
	} catch (error) {
		if (record(error) && error["code"] === "ENOENT") return {};
		throw new Error(`Configuration error in ${path}: ${error instanceof Error ? error.message : String(error)}`);
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
export async function trusted(root: string): Promise<boolean> {
	return (await configuration(root)).trusted;
}
export async function configuration(root: string): Promise<Config> {
	const paths = configPaths(root);
	const user = await read(paths.user);
	const trust = await workspaceTrust(root, paths.codex);
	const project = trust.level === "trusted" ? await read(paths.project) : {};
	const servers: Record<string, Server | false> = {};
	for (const [language, name] of Object.entries(defaults)) servers[language] = server(name, language, "builtin");
	for (const [data, source] of [
		[user, paths.user],
		[project, paths.project],
	] as const) {
		if (data["lsp"] !== undefined && !record(data["lsp"])) throw new Error(`Invalid lsp in ${source}`);
		if (record(data["lsp"]))
			for (const [language, value] of Object.entries(data["lsp"]))
				servers[language] = server(value, language, source);
		for (const key of ["lint", "formatting", "automaticDiagnostics"])
			if (data[key] !== undefined && !record(data[key])) throw new Error(`Invalid ${key} in ${source}`);
	}
	const extensions: Record<string, readonly string[]> = {};
	for (const [language, name] of Object.entries(defaults)) {
		const entry = server(name, language, "builtin");
		if (entry) extensions[language] = entry.extensions;
	}
	for (const [language, entry] of Object.entries(servers)) if (entry) extensions[language] = entry.extensions;
	const used = new Map<string, string>();
	for (const [language, entry] of Object.entries(servers))
		if (entry)
			for (const extension of entry.extensions) {
				if (used.has(extension))
					throw new Error(
						`Extension conflict ${extension}: ${used.get(extension)} and ${language}; disable or replace the original language entry`,
					);
				used.set(extension, language);
			}
	const lint = { ...(record(user["lint"]) ? user["lint"] : {}), ...(record(project["lint"]) ? project["lint"] : {}) };
	const javascript = lint["javascript"] ?? "auto";
	const python = lint["python"] ?? "auto";
	if (javascript !== "auto" && javascript !== "biome" && javascript !== "eslint" && javascript !== "off")
		throw new Error("Invalid lint.javascript");
	if (python !== "auto" && python !== "ruff" && python !== "off") throw new Error("Invalid lint.python");
	const exclude = project["exclude"] ?? user["exclude"] ?? [];
	if (
		!Array.isArray(exclude) ||
		!exclude.every(
			(item): item is string =>
				typeof item === "string" &&
				!item.startsWith("!") &&
				!item.includes("\\") &&
				!isAbsolute(item) &&
				!item.split("/").includes(".."),
		)
	)
		throw new Error("exclude requires relative forward-slash globs without negation");
	const formatting = {
		tabSize: 4,
		insertSpaces: true,
		...(record(user["formatting"]) ? user["formatting"] : {}),
		...(record(project["formatting"]) ? project["formatting"] : {}),
	};
	if (
		!Number.isInteger(formatting.tabSize) ||
		formatting.tabSize < 1 ||
		formatting.tabSize > 16 ||
		typeof formatting.insertSpaces !== "boolean"
	)
		throw new Error("Invalid formatting.tabSize or formatting.insertSpaces");
	const automaticDiagnostics = {
		postToolUse: "delta",
		stop: "errors",
		...(record(user["automaticDiagnostics"]) ? user["automaticDiagnostics"] : {}),
		...(record(project["automaticDiagnostics"]) ? project["automaticDiagnostics"] : {}),
	};
	for (const [key, value] of Object.entries(automaticDiagnostics)) {
		if (value === "full" || (key === "stop" && value === "delta"))
			throw new Error(
				"Migration required: automaticDiagnostics uses postToolUse=delta/off and stop=errors/off; use check_project for full checks. See docs/usage.md#upgrade",
			);
		if (!["postToolUse", "stop"].includes(key) || ![key === "stop" ? "errors" : "delta", "off"].includes(value))
			throw new Error(`Invalid automaticDiagnostics.${key}`);
	}
	const projectChecks = project["projectChecks"] ?? user["projectChecks"] ?? "auto";
	if (projectChecks !== "auto") {
		if (!Array.isArray(projectChecks)) throw new Error("projectChecks requires auto or a list");
		const used = new Set<string>();
		for (const check of projectChecks) {
			if (
				!record(check) ||
				Object.keys(check).some((key) => !["name", "cwd", "command", "parser", "coverage"].includes(key)) ||
				typeof check["name"] !== "string" ||
				!check["name"] ||
				used.has(check["name"]) ||
				typeof check["cwd"] !== "string" ||
				isAbsolute(check["cwd"]) ||
				check["cwd"].split(/[\\/]/).includes("..") ||
				!["tsc", "ty", "cargo", "ruff", "eslint", "biome", "json", "sarif"].includes(String(check["parser"])) ||
				!Array.isArray(check["command"]) ||
				!check["command"].length ||
				!check["command"].every((arg: unknown) => typeof arg === "string" && arg.length) ||
				!Array.isArray(check["coverage"]) ||
				!check["coverage"].length ||
				!check["coverage"].every(
					(arg: unknown) =>
						typeof arg === "string" && !isAbsolute(arg) && !arg.startsWith("!") && !arg.split("/").includes(".."),
				)
			)
				throw new Error(
					"Invalid projectChecks entry: require unique name, relative cwd, command array, parser and coverage globs",
				);
			used.add(check["name"]);
		}
	}

	return freeze({
		schemaVersion: 1,
		projectChecks: projectChecks as Config["projectChecks"],
		automaticDiagnostics: automaticDiagnostics as Config["automaticDiagnostics"],
		javascript,
		python,
		exclude,
		trusted: trust.level === "trusted",
		trust,
		...paths,
		extensions,
		servers,
		formatting,
		version: hash(JSON.stringify([user, project, trust, paths])),
	});
}
