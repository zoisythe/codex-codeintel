import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { bundleClient } from "./bundle-client.mjs";

const enabled = process.env.CODEX_LSP_REAL_TOOLS === "1";
test("packed setupLSP: isolated global defaults, mixed project coverage, read-only validation and offline failure", { skip: !enabled, timeout: 120000 }, async t => {
	const dir = await mkdtemp(join(tmpdir(), "codeintel-setup-")), root = join(dir, "mixed"), home = join(dir, "global"), install = join(dir, "installed");
	await mkdir(root); await mkdir(home);
	const run = (command, args, cwd = root, env = process.env) => spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 30000 });
	const packed = run("npm", ["pack", "--json", "--pack-destination", dir], resolve(".")); assert.equal(packed.status, 0, packed.stderr);
	const output = JSON.parse(packed.stdout); const manifest = Array.isArray(output) ? output[0] : Object.values(output)[0]; assert(manifest.files.some(file => file.path === "skills/setup-lsp/SKILL.md")); assert(manifest.files.some(file => file.path === "skills/setup-lsp/references/languages.md"));
	const installed = run("npm", ["install", "--prefix", install, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", join(dir, manifest.filename)]); assert.equal(installed.status, 0, installed.stderr);
	const packageRoot = join(install, "node_modules/@zoisythe/codex-codeintel"), cli = join(packageRoot, "dist/cli.js");
	assert.match(await readFile(join(packageRoot, "skills/setup-lsp/agents/openai.yaml"), "utf8"), /display_name: "setupLSP"/);
	for (const file of ["configuration.md", "languages.md"]) assert((await readFile(join(packageRoot, "skills/setup-lsp/references", file), "utf8")).length > 500);
	await writeFile(join(home, "lsp-client.json"), JSON.stringify({ schemaVersion: 1, lsp: { cpp: "clangd", rust: "rust" }, lint: { javascript: "off", python: "off" } }));
	await mkdir(join(root, ".codex")); await mkdir(join(root, "rust/src"), { recursive: true });
	await symlink(resolve("node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
	await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, files: ["main.ts"] }));
	await writeFile(join(root, "main.ts"), "export const value: number = 1;\n"); await writeFile(join(root, "main.py"), "value: int = 1\n");
	await writeFile(join(root, "main.c"), "int main(void) { return 0; }\n"); await writeFile(join(root, "main.cpp"), "int value() { return 1; }\n");
	await writeFile(join(root, "compile_commands.json"), JSON.stringify(["main.c", "main.cpp"].map(file => ({ directory: root, file: join(root, file), arguments: [file.endsWith("cpp") ? "clang++" : "clang", "-c", join(root, file)] }))));
	await writeFile(join(root, "rust/Cargo.toml"), '[package]\nname="setup_fixture"\nversion="0.1.0"\nedition="2021"\n'); await writeFile(join(root, "rust/src/main.rs"), "fn main() {}\n");
	assert.equal(run("cargo", ["check", "--offline"], join(root, "rust")).status, 0);
	const offline = run("uv", ["pip", "install", "--offline", "--target", join(root, ".codex/tools"), "codeintel-setup-offline-does-not-exist"], root, { ...process.env, UV_CACHE_DIR: join(dir, "empty-uv-cache"), UV_PYTHON_DOWNLOADS: "never" }); assert.notEqual(offline.status, 0, "an offline install failure is isolated to the missing capability");
	await writeFile(join(root, ".codex/lsp-client.json"), JSON.stringify({ schemaVersion: 1, automaticDiagnostics: { postToolUse: "delta", stop: "errors" }, lsp: { typescript: "tsc", python: { command: [join(root, ".codex/tools/ty"), "server"], extensions: [".py", ".pyi"] } }, projectChecks: [
		{ name: "web-types", cwd: ".", command: [resolve("node_modules/.bin/tsc"), "--noEmit", "--pretty", "false"], parser: "tsc", coverage: ["main.ts"] },
		...["c", "cpp"].map(extension => ({ name: extension, cwd: ".", command: [extension === "c" ? "clang" : "clang++", "-fsyntax-only", "-fdiagnostics-format=sarif", "-Wno-sarif-format-unstable", `main.${extension}`], parser: "sarif", coverage: [`main.${extension}`] })),
		{ name: "rust", cwd: "rust", command: ["cargo", "check", "--workspace", "--all-targets", "--message-format=json", "--offline"], parser: "cargo", coverage: ["src/**/*.rs"] },
		{ name: "python-unavailable", cwd: ".", command: [join(root, ".codex/tools/ty"), "check"], parser: "ty", coverage: ["main.py"] }
	] }));
	const originals = await Promise.all(["main.ts", "main.py", "main.c", "main.cpp", "rust/src/main.rs"].map(async path => [path, await readFile(join(root, path), "utf8")]));
	const env = { CODEX_LSP_CACHE: join(dir, "cache") }, c = bundleClient(root, home, env, cli);
	t.after(async () => { const s = (await c.call("lsp_status", { path: "main.ts" })).structuredContent; if (s.service?.pid) process.kill(s.service.pid, "SIGTERM"); await c.close(); await delay(150); await rm(dir, { recursive: true, force: true }); });
	const before = (await c.call("lsp_status", { path: "main.ts", refresh: true })).structuredContent; assert.equal(before.configuration.stopGate, "off"); assert.equal(before.tools[0].capabilities.diagnostics, "unverified"); assert.equal(before.clients.processStarts, 0);
	for (const path of ["main.ts", "main.c", "main.cpp", "rust/src/main.rs"]) {
		let result;
		for (let attempt = 0; attempt < 4; attempt++) { result = await c.call("check_diagnostics", { path, source: "lsp" }); if (result.structuredContent?.results[0].state === "complete") break; }
		assert.equal(result.isError, undefined, JSON.stringify(result)); assert.equal(result.structuredContent.results[0].state, "complete", JSON.stringify(result));
		const nav = await c.call("lsp_navigation", { path, operation: "symbols" }); assert.equal(nav.isError, undefined, JSON.stringify(nav));
	}
	const missing = await c.call("check_diagnostics", { path: "main.py", source: "lsp" }); assert.equal(missing.isError, true); assert.match(missing.content[0].text, /Explicit command missing.*no fallback/);
	let project = (await c.call("check_project")).structuredContent; while (project.state === "running") { await delay(100); project = (await c.call("check_project", project.next)).structuredContent; }
	assert.equal(project.state, "failed"); assert.equal(project.checkers.filter(check => check.state === "complete").length, 4); assert(project.checkers.some(check => check.name === "python-unavailable" && check.state === "failed"));
	for (const [path, text] of originals) assert.equal(await readFile(join(root, path), "utf8"), text, "setup verification stays read-only");
	const pre = spawnSync(process.execPath, [cli, "hook"], { cwd: root, env: { ...process.env, CODEX_HOME: home, ...env }, input: JSON.stringify({ cwd: root, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { path: "main.py" } }), encoding: "utf8" }); assert.equal(pre.status, 0, pre.stderr); assert.equal(pre.stdout, "");
});
