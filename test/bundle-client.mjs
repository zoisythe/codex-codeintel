import { completeOutput } from "./page-output.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
export function bundleClient(root, home, extra = {}, cli = resolve("dist/cli.js"), imports = []) {
	const child = spawn(process.execPath, [...imports, cli, "mcp"], { cwd: root, env: { ...process.env, CODEX_HOME: home, ...extra }, stdio: ["pipe", "pipe", "pipe", "ipc"] });
	const exited = once(child, "exit");
	const workspaces = new Set([root]);
	const pending = new Map(); let id = 0, stderr = "";
	child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
	createInterface({ input: child.stdout }).on("line", line => { const data = JSON.parse(line); pending.get(data.id)?.(data.result); pending.delete(data.id); });
	return { child, async raw(name, args = {}) {
		workspaces.add(args.workspace ?? root);
		const key = ++id;
		const result = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`MCP timeout ${name}: ${stderr}`)), 50000);
			pending.set(key, result => { clearTimeout(timer); resolve(result); });
			child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: key, method: "tools/call", params: { name, arguments: { workspace: root, ...args } } }) + "\n");
		});
		return result;
	}, async call(name,args={}) { const result = await this.raw(name,args); return name === "status" ? completeOutput(result, next => this.raw(name,next)) : result;
	}, async full(name,args={}) { return completeOutput(await this.call(name,args), next => this.raw(name,next)); }, async write(name, args = {}) { const preview = await this.call(name, args); if (preview.isError) return preview; return this.full("apply", { plan: preview.structuredContent.plan, ...(args.session ? { session: args.session } : {}) }); }, async close() { child.stdin.end(); if (child.connected) child.disconnect(); await exited; for (const workspace of workspaces) await stopTestService(workspace, home, cli); if(process.platform === "win32") await new Promise(resolve => setTimeout(resolve,100)); } };
}
export async function stopTestService(root, home, cli = resolve("dist/cli.js")) {
	const hash = value => createHash("sha256").update(value).digest("hex");
	const user = process.getuid?.() ?? hash(homedir()).slice(0, 10);
	const identity = hash(JSON.stringify([process.getuid?.() ?? homedir(), await realpath(root), await realpath(home).catch(() => home), hash(await readFile(cli)), 1]));
	const endpoint = JSON.parse(await readFile(join(tmpdir(), `clsp6-${user}`, `${identity}.endpoint`), "utf8").catch(() => "null"));
	if (!endpoint || endpoint.identity !== identity) return;
	try {
		if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(endpoint.pid), "/f", "/t"], { windowsHide: true, timeout: 5000, stdio: "ignore" });
		else process.kill(endpoint.pid, "SIGTERM");
	} catch { /* The fixture service may already have stopped. */ }
}
