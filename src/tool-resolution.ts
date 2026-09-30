import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { ResolvedServer } from "../packages/lsp-tools-mcp/dist/lsp/types.js";
import type { Config, Server } from "./config.js";
import { hash, inside } from "./files.js";

export interface ToolResolution {
	command: string[];
	source: "explicit" | "project" | "PATH" | "temporary" | "missing";
	identity: string;
	note?: string;
}
const temporary: Record<string, { ecosystem: "python" | "npm"; packages: string[] }> = {
	ty: { ecosystem: "python", packages: ["ty"] },
	ruff: { ecosystem: "python", packages: ["ruff"] },
	"pyright-langserver": { ecosystem: "python", packages: ["pyright"] },
	"basedpyright-langserver": { ecosystem: "python", packages: ["basedpyright"] },
	"typescript-language-server": { ecosystem: "npm", packages: ["typescript-language-server", "typescript@5.9.3"] },
	tsc: { ecosystem: "npm", packages: ["typescript@7.0.2"] },
	"bash-language-server": { ecosystem: "npm", packages: ["bash-language-server"] },
	"yaml-language-server": { ecosystem: "npm", packages: ["yaml-language-server"] },
	"vscode-html-language-server": { ecosystem: "npm", packages: ["vscode-langservers-extracted"] },
	"vscode-css-language-server": { ecosystem: "npm", packages: ["vscode-langservers-extracted"] },
	"vscode-json-language-server": { ecosystem: "npm", packages: ["vscode-langservers-extracted"] },
	svelteserver: { ecosystem: "npm", packages: ["svelte-language-server"] },
	"astro-ls": { ecosystem: "npm", packages: ["@astrojs/language-server", "typescript"] },
};
async function executable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}
function suffixes(name: string): string[] {
	return process.platform === "win32" && !/\.(?:exe|com|cmd|bat)$/i.test(name)
		? [".exe", ".com", ".cmd", ".bat", ""]
		: [""];
}
export async function pathExecutable(name: string): Promise<string | undefined> {
	for (const dir of (process.env["PATH"] ?? "").split(delimiter).filter(Boolean)) {
		for (const suffix of suffixes(name)) {
			const path = resolve(dir, name + suffix);
			if (await executable(path)) return path;
		}
	}
	return undefined;
}
async function resolution(command: string[], source: ToolResolution["source"], note?: string): Promise<ToolResolution> {
	const info = await stat(command[0] ?? "").catch(() => undefined);
	return {
		command,
		source,
		identity: hash(JSON.stringify([command, source, info?.size, info?.mtimeMs, process.env["PATH"]])),
		...(note ? { note } : {}),
	};
}
const requestTools = new AsyncLocalStorage<Map<string, Promise<ToolResolution>>>();
export function withToolResolution<T>(action: () => Promise<T>): Promise<T> {
	return requestTools.run(new Map(), action);
}
export function resolveTool(...args: Parameters<typeof findTool>): Promise<ToolResolution> {
	const cache = requestTools.getStore();
	const key = JSON.stringify([args[0], dirname(resolve(args[0], args[1])), ...args.slice(2)]);
	const existing = cache?.get(key);
	if (existing) return existing;
	const task = findTool(...args);
	cache?.set(key, task);
	return task;
}
async function findTool(
	root: string,
	path: string,
	command: readonly string[],
	explicit = false,
	allowTemporary = true,
): Promise<ToolResolution> {
	const name = command[0];
	if (!name) throw new Error("Empty command");
	if (explicit) {
		const entry =
			isAbsolute(name) || name.includes("/") || name.includes("\\")
				? resolve(root, name)
				: await pathExecutable(name);
		return resolution(
			[entry ?? name, ...command.slice(1)],
			entry && (await executable(entry)) ? "explicit" : "missing",
			entry && (await executable(entry)) ? undefined : `Explicit command missing: ${name}; no fallback`,
		);
	}
	let dir = dirname(resolve(root, path));
	while (inside(root, dir)) {
		for (const candidate of [
			...suffixes(name).map((suffix) =>
				join(dir, ".venv", process.platform === "win32" ? "Scripts" : "bin", name + suffix),
			),
			...suffixes(name).map((suffix) => join(dir, "node_modules", ".bin", name + suffix)),
		])
			if (await executable(candidate)) return resolution([candidate, ...command.slice(1)], "project");
		if (dir === root) break;
		dir = dirname(dir);
	}
	const local = await pathExecutable(name);
	if (local) return resolution([local, ...command.slice(1)], "PATH");
	const plan = temporary[name];
	if (allowTemporary && plan) {
		if (plan.ecosystem === "python") {
			for (const [launcher, prefix] of [
				["uvx", ["--isolated", "--from", plan.packages[0] ?? name]],
				["uv", ["tool", "run", "--isolated", "--from", plan.packages[0] ?? name]],
				["pipx", ["run", "--spec", plan.packages[0] ?? name]],
			] as const) {
				const found = await pathExecutable(launcher);
				if (found)
					return resolution(
						[found, ...prefix, ...command],
						"temporary",
						"Available to attempt; initialization not verified",
					);
			}
		} else {
			const npx = await pathExecutable("npx");
			if (npx)
				return resolution(
					[npx, "--yes", ...plan.packages.flatMap((pkg) => ["--package", pkg]), "--", ...command],
					"temporary",
					"Available to attempt; initialization not verified",
				);
		}
	}
	return resolution(
		[...command],
		"missing",
		`Tool missing: ${name}; install locally and retry or use lsp_status refresh=true`,
	);
}
export function languageFor(config: Config, path: string): { language: string; server: Server } | undefined {
	for (const [language, server] of Object.entries(config.servers))
		if (server !== false && server.extensions.includes(extname(path))) return { language, server };
	return undefined;
}
export async function resolveServer(
	root: string,
	path: string,
	config: Config,
): Promise<{ language: string; tool: ToolResolution; server: ResolvedServer }> {
	const entry = languageFor(config, path);
	if (!entry) throw new Error(`Language disabled or unsupported: ${extname(path) || path}`);
	const tool = await resolveTool(root, path, entry.server.command, entry.server.explicit);
	return {
		language: entry.language,
		tool,
		server: {
			id: entry.server.id,
			command: tool.command,
			extensions: [...entry.server.extensions],
			priority: 0,
			...(entry.server.env ? { env: { ...entry.server.env } } : {}),
			...(entry.server.initialization ? { initialization: { ...entry.server.initialization } } : {}),
		},
	};
}

export function codeLanguage(config: Config, path: string): string | undefined {
	return (
		languageFor(config, path)?.language ??
		Object.entries(config.extensions).find(([, extensions]) => extensions.includes(extname(path)))?.[0]
	);
}
