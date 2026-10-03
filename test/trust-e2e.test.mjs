import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { bundleClient } from "./bundle-client.mjs";

test("no config or trust file: default Hooks do no analysis and all pre-edit calls pass", { timeout: 15000 }, async t => {
	const dir = await mkdtemp(join(tmpdir(), "codeintel-defaults-")), root = join(dir, "parent"), child = join(root, "child"), home = join(dir, "home");
	await mkdir(child, { recursive: true }); await mkdir(home); await writeFile(join(root, "main.py"), "value: int = 1\n");
	const env = { ...process.env, PATH: "", CODEX_HOME: home, CODEX_LSP_CACHE: join(dir, "cache"), CODEX_LSP_TRUST_PROJECT: "1", LSP_TOOLS_MCP_USER_CONFIG: "obsolete" };
	const cli = resolve("dist/cli.js"), c = bundleClient(root, home, env);
	t.after(async () => { await c.close(); await rm(dir, { recursive: true, force: true }); });
	const hook = (event, cwd = root, session = "s") => {
		const result = spawnSync(process.execPath, [cli, "hook"], { cwd, env, encoding: "utf8", input: JSON.stringify({ cwd, session_id: session, hook_event_name: event, tool_name: "Write", tool_input: { path: "main.py" } }), timeout: 3000 });
		assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "");
	};
	for (const config of [undefined, 'invalid = "private-value']) {
		if (config) await writeFile(join(home, "config.toml"), config);
		for (const cwd of [root, child]) for (const event of ["SessionStart", "PreToolUse", "PostToolUse", "Stop", "SubagentStop"]) hook(event, cwd);
	}
	assert.equal(await readFile(join(dir, "cache", "sentinel"), "utf8").catch(() => "missing"), "missing");
	const status = (await c.call("lsp_status", { path: "main.py" })).structuredContent;
	assert.equal(status.trusted, undefined); assert.equal(status.configuration.trust, undefined); assert.deepEqual(status.configuration.automaticDiagnostics, { postToolUse: "off", stop: "off" });
	assert.equal(status.service.state, "stopped"); assert.equal(status.clients.processStarts, 0); assert.equal(status.index.fullScans ?? status.index.scans ?? 0, 0);
	assert(status.configurationIssues.some(issue => issue.scope === "CODEX_LSP_TRUST_PROJECT"));
	for (const raw of ["invalid JSON", '{"schemaVersion":0}', '{"schemaVersion":1,"lsp":42}', '{"schemaVersion":1,"automaticDiagnostics":{"stop":"full"}}']) {
		await writeFile(join(home, "lsp-client.json"), raw); hook("PreToolUse", root, ""); hook("SessionStart"); hook("Stop");
		assert(!(await c.call("lsp_status")).isError);
	}
	hook("SessionEnd");
});

test("parent and child configs load without trust; canonical boundaries and installed home remain enforced", { timeout: 12000 }, async t => {
	const dir = await mkdtemp(join(tmpdir(), "codeintel-scope-")), root = join(dir, "parent"), child = join(root, "child"), home = join(dir, "home"), log = join(dir, "launches");
	await mkdir(join(child, ".codex"), { recursive: true }); await mkdir(home);
	await writeFile(join(child, "main.fake"), "broken\n");
	await writeFile(join(child, ".codex", "lsp-client.json"), JSON.stringify({ schemaVersion: 1, trustedWorkspaces: [root], lsp: { fake: { command: [process.execPath, resolve("test/fixtures/fake-lsp.mjs")], extensions: [".fake"], env: { CODEX_LSP_TEST_MODE: "pull", CODEX_LSP_TEST_LOG: log } } } }));
	const c = bundleClient(root, home, { CODEX_LSP_CACHE: join(dir, "cache") });
	t.after(async () => { await c.close(); await rm(dir, { recursive: true, force: true }); });
	const status = (await c.call("lsp_status", { workspace: child, path: "main.fake" })).structuredContent;
	assert.equal(status.configurationSources[1].path, join(child, ".codex", "lsp-client.json")); assert.equal(status.tools[0].capabilities.diagnostics, "unverified");
	assert.equal(await readFile(log, "utf8").catch(() => ""), "", "status starts no LSP");
	assert.equal((await c.call("check_diagnostics", { workspace: child, path: "main.fake", source: "lsp" })).structuredContent.errors, 1);
	const escaped = await c.call("check_diagnostics", { workspace: child, path: "../outside.py" }); assert(escaped.isError);
	await writeFile(join(dir, "outside.fake"), "outside\n"); await symlink(join(dir, "outside.fake"), join(child, "escape.fake")); assert((await c.call("lsp_format", { workspace: child, path: "escape.fake" })).isError);
	const installed = join(home, "plugins/cache/example/plugin/0.9.0/dist/cli.js"); await mkdir(resolve(installed, ".."), { recursive: true }); await cp(resolve("dist/cli.js"), installed);
	await writeFile(join(home, "lsp-client.json"), JSON.stringify({ schemaVersion: 1, automaticDiagnostics: { postToolUse: "off", stop: "off" } }));
	const sanitized = { ...process.env, CODEX_LSP_CACHE: join(dir, "installed-cache") }; delete sanitized.CODEX_HOME;
	const hook = spawnSync(process.execPath, [installed, "hook"], { cwd: child, env: sanitized, input: JSON.stringify({ cwd: child, session_id: "installed", hook_event_name: "SessionStart" }), encoding: "utf8", timeout: 3000 }); assert.equal(hook.status, 0, hook.stderr); assert.equal(hook.stdout, "");
});

test("localized config errors degrade independently; malformed JSON keeps status and cached diagnostics", { timeout: 15000 }, async t => {
	const dir = await mkdtemp(join(tmpdir(), "codeintel-config-")), root = join(dir, "project"), home = join(dir, "home"); await mkdir(root); await mkdir(home);
	const path = join(home, "lsp-client.json"), fake = { command: [process.execPath, resolve("test/fixtures/fake-lsp.mjs")], extensions: [".fake"], env: { CODEX_LSP_TEST_MODE: "pull" } };
	await writeFile(join(root, "main.fake"), "broken\n"); await writeFile(join(root, "main.py"), "import os\n");
	await writeFile(path, JSON.stringify({ schemaVersion: 1, lsp: { fake, python: { command: [] }, cpp: { command: ["missing-explicit"], extensions: [".c"] } } }));
	const c = bundleClient(root, home, { CODEX_LSP_CACHE: join(dir, "cache") });
	t.after(async () => { await c.close(); await rm(dir, { recursive: true, force: true }); });
	const status = (await c.call("lsp_status")).structuredContent; assert(status.configurationIssues.some(issue => issue.scope === "lsp.python")); assert.equal(status.configuration.valid, true);
	assert.equal((await c.call("lsp_status", { path: "main.c" })).structuredContent.tools[0].tool.source, "missing");
	assert.equal((await c.call("check_diagnostics", { path: "main.fake", source: "lsp" })).structuredContent.errors, 1);
	await writeFile(path, "invalid JSON"); const broken = await c.call("lsp_status"); assert.equal(broken.isError, undefined); assert.equal(broken.structuredContent.configuration.valid, false);
	const cached = await c.call("check_diagnostics", { path: "main.fake", source: "lsp", run: "cached" }); assert.equal(cached.isError, undefined, JSON.stringify(cached)); assert.equal(cached.structuredContent.errors, 1); assert.equal(cached.structuredContent.results[0].state, "stale");
	assert.match((await c.call("lsp_navigation", { path: "main.fake", operation: "symbols" })).content[0].text, /Configuration error/);
	await writeFile(path, JSON.stringify({ schemaVersion: 1, lsp: { fake } })); assert.equal((await c.call("check_diagnostics", { path: "main.fake", source: "lsp" })).structuredContent.errors, 1);
});
