import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { bundleClient } from "./bundle-client.mjs";

test("real temporary ty/Ruff preparation, offline reuse and Hook direct execution", { timeout: 150000, skip: process.env.CODEX_LSP_REAL_TOOLS !== "1" || process.platform !== "linux" }, async t => {
	const uv = spawnSync("which", ["uv"], { encoding: "utf8" }).stdout.trim();
	const uvx = spawnSync("which", ["uvx"], { encoding: "utf8" }).stdout.trim();
	const python = spawnSync(uv, ["python", "find"], { encoding: "utf8" }).stdout.trim();
	assert(uv && python);
	const dir = await mkdtemp(join(tmpdir(), "codex-temporary-"));
	const root = join(dir, "project"), home = join(dir, "home"), bin = join(dir, "bin");
	await mkdir(root); await mkdir(home); await mkdir(bin);
	await symlink(uvx, join(bin, "uvx"));
	await writeFile(join(home, "config.toml"), `[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`);
	await writeFile(join(home, "lsp-client.json"), JSON.stringify({ schemaVersion: 1 }));
	await writeFile(join(root, "main.py"), 'import os\nvalue: int = "wrong"\n');
	const env = { PATH: bin, UV_CACHE_DIR: join(dir, "uv-cache"), UV_TOOL_DIR: join(dir, "tools"), UV_TOOL_BIN_DIR: join(dir, "toolbin"), UV_PYTHON: python, UV_PYTHON_DOWNLOADS: "never", CODEX_LSP_CACHE: join(dir, "metadata") };
	let client = bundleClient(root, home, env);
	t.after(async () => { await client.close(); await rm(dir, { recursive: true, force: true }); });
	const check = () => client.call("check_diagnostics", { path: "main.py" });
	let result = await check();
	if (result.structuredContent?.results.some(entry => entry.state === "stale")) result = await check();
	assert(!result.isError, JSON.stringify(result)); assert(result.structuredContent.errors > 0);
	const manifest = JSON.parse(await readFile(join(home, "cache", "codex-lsp-v5", "tools", "ruff.json"), "utf8"));
	assert(manifest.executable.startsWith(env.UV_CACHE_DIR));
	await client.close();
	client = bundleClient(root, home, { ...env, UV_OFFLINE: "1" });
	result = await check(); assert(!result.isError, JSON.stringify(result)); assert(result.structuredContent.errors > 0);
	const launcherLog = join(dir, "unexpected-launch");
	await rm(join(bin, "uvx"));
	await writeFile(join(bin, "uvx"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(launcherLog)}, "launched");process.exit(99);\n`, { mode: 0o755 });
	const hook = event => spawnSync(process.execPath, [resolve("dist/cli.js"), "hook"], { cwd: root, env: { ...process.env, ...env, CODEX_HOME: home, UV_OFFLINE: "1" }, encoding: "utf8", timeout: 10000, input: JSON.stringify({ cwd: root, session_id: "s", hook_event_name: event }) });
	assert.equal(hook("SessionStart").status, 0);
	await writeFile(join(root, "main.py"), "import sys\nvalue: int = 1\n");
	assert.match(hook("PostToolUse").stdout, /F401/);
	assert.equal(await readFile(launcherLog, "utf8").catch(() => ""), "", "Hook uses prepared executable, never launcher");
	await client.close();
	await rm(join(bin, "uvx")); await symlink(uvx, join(bin, "uvx"));
	client = bundleClient(root, home, { ...env, UV_CACHE_DIR: join(dir, "empty-cache"), UV_OFFLINE: "1" });
	result = await check(); assert.equal(result.structuredContent.results[0].channels.lsp, "failed", JSON.stringify(result)); assert.equal(result.structuredContent.results[0].channels.lint, "complete"); assert.match(result.content[0].text, /launch\/download|initialization failed/);
});

for (const [server, recipe] of [["typescript", "typescript@5.9.3"], ["tsc", "typescript@7.0.2"]]) {
test(`real npx ${server} recipe works offline after preparation`, { timeout: 150000, skip: process.env.CODEX_LSP_REAL_TOOLS !== "1" || process.platform !== "linux" }, async t => {
	const npx = spawnSync("which", ["npx"], { encoding: "utf8" }).stdout.trim(); assert(npx);
	const dir = await mkdtemp(join(tmpdir(), "codex-npx-")), root = join(dir, "project"), home = join(dir, "home"), bin = join(dir, "bin");
	await mkdir(root); await mkdir(home); await mkdir(bin);
	await symlink(npx, join(bin, "npx")); await symlink(process.execPath, join(bin, "node")); await symlink("/bin/sh", join(bin, "sh"));
	await writeFile(join(home, "config.toml"), `[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`);
	await writeFile(join(home, "lsp-client.json"), JSON.stringify({ schemaVersion: 1, automaticDiagnostics: { postToolUse: "off", stop: "off" }, lsp: { typescript: server } }));
	await writeFile(join(root, "main.ts"), 'export const value: number = "wrong";\n');
	await writeFile(join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true,"noEmit":true}}');
	const env = { PATH: bin, npm_config_cache: join(dir, "npm-cache"), CODEX_LSP_CACHE: join(dir, "metadata") };
	let client = bundleClient(root, home, env);
	t.after(async () => { await client.close(); await rm(dir, { recursive: true, force: true }); });
	const check = () => client.call("check_diagnostics", { path: "main.ts", source: "lsp" });
	const status = (await client.call("lsp_status", { path: "main.ts" })).structuredContent.tools[0];
	assert.equal(status.tool.source, "temporary"); assert(status.tool.command.includes(recipe));
	let result = await check(); assert(!result.isError, JSON.stringify(result)); assert(result.structuredContent.errors > 0, JSON.stringify(result));
	await client.close(); client = bundleClient(root, home, { ...env, npm_config_offline: "true" });
	result = await check(); assert(!result.isError, JSON.stringify(result)); assert(result.structuredContent.errors > 0, JSON.stringify(result));
	assert.equal(await readFile(join(root, "package.json"), "utf8").catch(() => ""), "");
	assert.equal(await readFile(join(root, "package-lock.json"), "utf8").catch(() => ""), "");
});
}
