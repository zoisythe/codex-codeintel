import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFile, mkdir, readFile, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { completeOutput } from "./page-output.mjs";
import { mcpResult, parseRecord, record } from "./protocol.mjs";

/** @param {string} root @param {string} home @param {NodeJS.ProcessEnv} [extra] @param {string} [cli] @param {string[]} [imports] */
export function bundleClient(root, home, extra = {}, cli = resolve("dist/cli.js"), imports = []) {
	const child = spawn(process.execPath, [...imports, cli, "mcp"], { cwd: root, env: { ...process.env, CODEX_HOME: home, ...extra }, stdio: ["pipe", "pipe", "pipe", "ipc"] });
	assert(child.stdin && child.stdout && child.stderr);
	const stdin = child.stdin, stdout = child.stdout, stderr = child.stderr;
	const exited = once(child, "exit");
	const workspaces = new Set([root]);
	/** @type {Map<number, (result: unknown) => void>} */ const pending = new Map();
	let id = 0, errorText = "";
	stderr.setEncoding("utf8").on("data", chunk => { errorText += chunk; });
	createInterface({ input: stdout }).on("line", line => {
		const data = parseRecord(line);
		assert(typeof data["id"] === "number");
		pending.get(data["id"])?.(data["result"]); pending.delete(data["id"]);
	});
	/** @template {string} N @param {N} name @param {import("./protocol-types.js").Arguments} [args] @returns {Promise<import("./protocol-types.js").McpResult<N>>} */
	async function raw(name, args = {}) {
		workspaces.add(args.workspace ?? root);
		const key = ++id;
		/** @type {unknown} */ const result = await new Promise((resolveResult, reject) => {
			const timer = setTimeout(() => reject(new Error(`MCP timeout ${name}: ${errorText}`)), 50000);
			pending.set(key, result => { clearTimeout(timer); resolveResult(result); });
			stdin.write(JSON.stringify({ jsonrpc: "2.0", id: key, method: "tools/call", params: { name, arguments: { workspace: root, ...args } } }) + "\n");
		});
		const artifacts = process.env["CODEX_LSP_ARTIFACTS"];
		if (artifacts) {
			await mkdir(artifacts, { recursive: true });
			const key = createHash("sha256").update(root).digest("hex").slice(0, 12);
			await appendFile(join(artifacts, `${key}.jsonl`), `${JSON.stringify({ name, args, result })}\n`);
		}
		return mcpResult(result);
	}
	/** @template {string} N @param {N} name @param {import("./protocol-types.js").Arguments} [args] @returns {Promise<import("./protocol-types.js").McpResult<N>>} */
	async function call(name, args = {}) {
		const result = await raw(name, args);
		return name === "status" ? completeOutput(result, next => raw(name, next)) : result;
	}
	/** @template {string} N @param {N} name @param {import("./protocol-types.js").Arguments} [args] @returns {Promise<import("./protocol-types.js").McpResult<N>>} */
	async function full(name, args = {}) { return completeOutput(await call(name, args), next => raw(name, next)); }
	/** @param {"rename" | "format" | "actions"} name @param {import("./protocol-types.js").Arguments} [args] @returns {Promise<import("./protocol-types.js").McpResult<"apply">>} */
	async function write(name, args = {}) {
		const preview = await full(name, args); if (preview.isError) return mcpResult(preview);
		return full("apply", { plan: preview.structuredContent.plan, ...(args.session ? { session: args.session } : {}) });
	}
	async function close() {
		stdin.end(); if (child.connected) child.disconnect(); await exited;
		for (const workspace of workspaces) await stopTestService(workspace, home, cli);
		if (process.platform === "win32") await new Promise(resolveResult => setTimeout(resolveResult, 100));
	}
	return { child, raw, call, full, write, close };
}
/** @param {string} root @param {string} home @param {string} [cli] */
export async function stopTestService(root, home, cli = resolve("dist/cli.js")) {
	/** @param {string | Buffer} value */ const hash = value => createHash("sha256").update(value).digest("hex");
	const user = process.getuid?.() ?? hash(homedir()).slice(0, 10);
	const identity = hash(JSON.stringify([process.getuid?.() ?? homedir(), await realpath(root), await realpath(home).catch(() => home), hash(await readFile(cli)), 1]));
	/** @type {unknown} */ const endpoint = JSON.parse(await readFile(join(tmpdir(), `clsp6-${user}`, `${identity}.endpoint`), "utf8").catch(() => "null"));
	if (!record(endpoint) || endpoint["identity"] !== identity || typeof endpoint["pid"] !== "number") return;
	try {
		if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(endpoint["pid"]), "/f", "/t"], { windowsHide: true, timeout: 5000, stdio: "ignore" });
		else process.kill(endpoint["pid"], "SIGTERM");
	} catch { /* The fixture service may already have stopped. */ }
}
