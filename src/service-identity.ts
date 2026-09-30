import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { executionEnvironment } from "./environment.js";
import { hash } from "./files.js";

export const SERVICE_PROTOCOL = 1;
let bundle: Promise<string> | undefined;
export function bundleIdentity(): Promise<string> {
	bundle ??= readFile(new URL(import.meta.url), "utf8").then(hash);
	return bundle;
}
export async function workspaceIdentity(root: string): Promise<string> {
	const home = resolve(executionEnvironment()["CODEX_HOME"] ?? resolve(homedir(), ".codex"));
	return hash(
		JSON.stringify([
			process.getuid?.() ?? homedir(),
			await realpath(root),
			await realpath(home).catch(() => home),
			await bundleIdentity(),
			SERVICE_PROTOCOL,
		]),
	);
}
