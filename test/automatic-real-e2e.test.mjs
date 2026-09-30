import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { bundleClient } from "./bundle-client.mjs";

const enabled = process.env.CODEX_LSP_REAL_TOOLS === "1";
test("actual ty, legacy/native TypeScript, clangd C/C++, rust-analyzer automatic edit and repair feedback", { skip: !enabled, timeout: 240000 }, async t => {
	const dir = await mkdtemp(join(tmpdir(), "codex-auto-real-")), tools = join(dir, "tools");
	const setup = spawnSync("npm", ["install", "--prefix", tools, "--no-audit", "--no-fund", "typescript-language-server", "typescript@5.9.3"], { encoding: "utf8", timeout: 90000 });
	assert.equal(setup.status, 0, setup.stderr);
	const summaries = [];
	const bundleSha256 = createHash("sha256").update(await readFile(resolveCli())).digest("hex");
	t.after(async () => { await rm(dir, { recursive: true, force: true }); });
	for (const language of ["python", "typescript", "native-typescript", "c", "cpp", "rust"]) {
		const root = join(dir, language), home = join(dir, `${language}-home`);
		await mkdir(root); await mkdir(home);
		await writeFile(join(home, "config.toml"), `[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`);
		await writeFile(join(home, "lsp-client.json"), JSON.stringify({ schemaVersion: 1, lint: { javascript: "off", python: "off" }, ...(language === "native-typescript" ? { lsp: { typescript: "tsc" } } : {}) }));
		let path, clean, broken;
		if (language === "python") { path = "main.py"; clean = "value: int = 1\n"; broken = 'value: int = "wrong"\n'; }
		else if (language.includes("typescript")) {
			await symlink(language === "typescript" ? join(tools, "node_modules") : resolve("node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
			await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ["*.ts"] }));
			path = "main.ts"; clean = "export const value: number = 1;\n"; broken = 'export const value: number = "wrong";\n';
		} else if (language === "c" || language === "cpp") {
			path = `main.${language}`; clean = "int main(void) { return 0; }\n"; broken = "int main(void) { return missing_name; }\n";
			await writeFile(join(root, "compile_flags.txt"), language === "c" ? "-std=c17\n" : "-std=c++17\n");
		} else {
			await mkdir(join(root, "src"));
			await writeFile(join(root, "Cargo.toml"), '[package]\nname="automatic_fixture"\nversion="0.1.0"\nedition="2021"\n');
			path = "src/main.rs"; clean = "fn main() { let _value: i32 = 1; }\n"; broken = 'fn main() { let _value: i32 = "wrong"; }\n';
			await writeFile(join(root, path), clean);
			const cargo = spawnSync("cargo", ["check", "--offline"], { cwd: root, encoding: "utf8", timeout: 30000 }); assert.equal(cargo.status, 0, cargo.stderr);
		}
		await writeFile(join(root, path), clean);
		const feedback = [];
		const hook = event => new Promise((resolve, reject) => {
			const started = performance.now(), child = spawn(process.execPath, [resolveCli(), "hook"], { cwd: root, env: { ...process.env, CODEX_HOME: home, CODEX_LSP_CACHE: join(dir, "cache") }, stdio: ["pipe", "pipe", "pipe"] });
			let out = "", err = "";
			child.stdout.setEncoding("utf8").on("data", chunk => { out += chunk; }); child.stderr.setEncoding("utf8").on("data", chunk => { err += chunk; });
			child.on("error", reject); child.on("exit", code => { if (code !== 0) reject(new Error(err)); else { feedback.push(out); resolve({ output: out, elapsed: performance.now() - started }); } });
			child.stdin.end(JSON.stringify({ cwd: root, session_id: language, hook_event_name: event }));
		});
		await hook("SessionStart");
		await writeFile(join(root, path), broken);
		const cold = await hook("PostToolUse");
		for (let attempt = 0; attempt < 8 && !feedback.some(output => /error \[/.test(output)); attempt++) { await delay(1500); await hook("PostToolUse"); }
		assert(feedback.some(output => /error \[/.test(output)), `${language}: no automatic error: ${feedback.join("\n")}`);
		await writeFile(join(root, path), clean);
		const hot = await hook("PostToolUse");
		for (let attempt = 0; attempt < 8 && !feedback.some(output => /previous diagnostics cleared/.test(output)); attempt++) { await delay(1500); await hook("PostToolUse"); }
		assert(feedback.some(output => /previous diagnostics cleared/.test(output)), `${language}: no automatic clearing: ${feedback.join("\n")}`);
		const stop = await hook("Stop"); if (stop.output) assert.equal(JSON.parse(stop.output).decision, undefined);
		// Status is read after automatic feedback; diagnosis never calls MCP.
		const c = bundleClient(root, home, { CODEX_LSP_CACHE: join(dir, "cache") });
		try {
			const status = (await c.call("lsp_status", { path })).structuredContent;
			assert.equal(status.tools[0].running, true, JSON.stringify(status.tools));
			summaries.push({ language, coldMs: cold.elapsed, hotMs: hot.elapsed, processStarts: status.clients.processStarts, command: status.tools[0].tool.command, serviceIdentity: status.service.identity });
			await hook("SessionEnd");
			process.kill(status.service.pid, "SIGTERM");
		} finally { await c.close(); }
	}
	await writeFile(resolve("docs/performance-0.6-real.json"), JSON.stringify({ platform: process.platform, node: process.version, bundleSha256, automaticOnly: true, results: summaries }, null, 2) + "\n");
	t.diagnostic(JSON.stringify(summaries));
});
function resolveCli() { return resolve("dist/cli.js"); }
