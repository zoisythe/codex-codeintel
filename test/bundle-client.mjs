import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
export function bundleClient(root, home, extra = {}, cli = resolve("dist/cli.js"), imports = []) {
	const child = spawn(process.execPath, [...imports, cli, "mcp"], { cwd: root, env: { ...process.env, CODEX_HOME: home, ...extra }, stdio: ["pipe", "pipe", "pipe", "ipc"] });
	const exited = once(child, "exit");
	const pending = new Map(); let id = 0, stderr = "";
	child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
	createInterface({ input: child.stdout }).on("line", line => { const data = JSON.parse(line); pending.get(data.id)?.(data.result); pending.delete(data.id); });
	return { child, async call(name, args = {}) {
		const key = ++id;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`MCP timeout ${name}: ${stderr}`)), 50000);
			pending.set(key, result => { clearTimeout(timer); resolve(result); });
			child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: key, method: "tools/call", params: { name, arguments: { workspace: root, ...args } } }) + "\n");
		});
	}, async close() { child.stdin.end(); if (child.connected) child.disconnect(); await exited; } };
}
