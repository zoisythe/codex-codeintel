import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { bundleClient } from "./bundle-client.mjs";

test("Codex user trust: exact workspaces, parent file scope, Hook cwd and live revocation", { timeout: 30000 }, async t => {
	const dir = await mkdtemp(join(tmpdir(), "codex-trust-"));
	const root = join(dir, "PJ"), child = join(root, "PJ1"), sibling = join(dir, "PJ-other"), home = join(dir, "home");
	for (const path of [child, sibling, home]) await mkdir(path, { recursive: true });
	const git = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" }); assert.equal(git.status, 0, git.stderr);
	const user = join(home, "config.toml"), log = join(dir, "lint-launches"), cli = resolve("dist/cli.js");
	const configure = entries => writeFile(user, entries.map(([path, level]) => `[projects.${JSON.stringify(path)}]\ntrust_level = ${JSON.stringify(level)}\n`).join("\n"));
	const script = `require("node:fs").appendFileSync(${JSON.stringify(log)}, "lint\\n");console.log(JSON.stringify({diagnostics:[{severity:"error",description:"trust fixture",category:"fixture"}]}));`;
	for (const path of [root, child]) {
		const bin = join(path, "node_modules", "@biomejs", "biome", "bin"); await mkdir(bin, { recursive: true });
		await writeFile(join(bin, "biome"), script); await writeFile(join(path, "biome.json"), "{}");
		await writeFile(join(path, "main.js"), "baseline\n");
	}
	const client = bundleClient(root, home);
	t.after(async () => { await client.close(); await rm(dir, { recursive: true, force: true }); });
	const status = async workspace => {
		const result = await client.call("lsp_status", { workspace, path: "main.js" }); assert(!result.isError, JSON.stringify(result)); return result.structuredContent;
	};
	const launches = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length;
	const check = (workspace, path = "main.js") => client.call("check_diagnostics", { workspace, path, source: "lint" });
	const hook = (workspace, event, session) => {
		const result = spawnSync(process.execPath, [cli, "hook"], { cwd: workspace, env: { ...process.env, CODEX_HOME: home, CODEX_LSP_CACHE: join(dir, "cache") }, input: JSON.stringify({ cwd: workspace, hook_event_name: event, session_id: session }), encoding: "utf8", timeout: 10000 });
		assert.equal(result.status, 0, result.stderr); return result.stdout;
	};
	assert.equal((await status(root)).trusted, false, "missing user config does not grant trust");
	await configure([[root, "trusted"]]);
	const parent = await status(root); assert.equal(parent.trusted, true); assert.equal(parent.configuration.trust.path, user);
	assert.equal((await status(child)).trusted, false, "parent trust is not inherited by a child workspace");
	assert.equal((await status(sibling)).trusted, false, "similar prefixes are separate workspaces");
	assert.equal((await check(root, "PJ1/main.js")).structuredContent.errors, 1, "trusted parent can lint files in its child");
	const count = await launches();
	await check(child); assert.equal(await launches(), count, "child workspace cannot run lint before its own trust");
	hook(child, "SessionStart", "child"); await writeFile(join(child, "main.js"), "child changed\n");
	assert.match(hook(child, "PostToolUse", "child"), /lint requires workspace trust/); assert.equal(await launches(), count, "Hook must not promote child cwd to Git root");
	hook(root, "SessionStart", "parent"); await writeFile(join(child, "main.js"), "parent changed child\n");
	assert.match(hook(root, "PostToolUse", "parent"), /trust fixture/); assert.equal(await launches(), count + 1);
	await configure([[root, "trusted"], [child, "trusted"]]);
	assert.equal((await check(child)).structuredContent.errors, 1, "new Codex trust takes effect in an existing MCP process");
	await writeFile(join(child, "main.js"), "trusted child changed\n");
	assert.match(hook(child, "PostToolUse", "child"), /trust fixture/);
	await configure([[root, "trusted"], [child, "untrusted"]]);
	const beforeRevocation = await launches();
	const denied = await check(child); assert.equal(denied.structuredContent.errors, 0); assert.equal(denied.structuredContent.results[0].state, "skipped");
	const revoked = await status(child); assert.equal(revoked.trusted, false); assert.equal(revoked.configuration.trust.level, "untrusted");
	hook(child, "SessionStart", "revoked");
	await writeFile(join(child, "main.js"), "revoked child changed\n"); assert.match(hook(child, "PostToolUse", "revoked"), /lint requires workspace trust/);
	assert.equal(await launches(), beforeRevocation, "revocation invalidates lint caches and stops Hook execution");
	assert.equal((await check(root, "PJ1/main.js")).structuredContent.errors, 1, "file operations stay authorized by the selected parent workspace");
	await mkdir(join(child, ".codex"));
	await writeFile(join(child, ".codex", "config.toml"), `[projects.${JSON.stringify(child)}]\ntrust_level = "trusted"\n`);
	await writeFile(join(child, ".codex", "lsp-client.json"), JSON.stringify({ schemaVersion: 1, trustedWorkspaces: [child] }));
	await writeFile(join(home, "lsp-client.json"), JSON.stringify({ schemaVersion: 1, trustedWorkspaces: [child] }));
	assert.equal((await status(child)).trusted, false, "project trust and legacy plugin lists cannot override Codex");
	await writeFile(join(child, ".codex", "lsp-client.json"), "invalid JSON"); assert.equal((await status(child)).trusted, false, "untrusted project config is not loaded");
	await rm(join(child, ".codex", "lsp-client.json"));
	const alias = join(dir, "alias"); await symlink(child, alias, process.platform === "win32" ? "junction" : "dir");
	await configure([[alias, "trusted"]]); assert.equal((await status(child)).trusted, true, "aliases identify the same directory");
	await configure([[alias, "trusted"], [child, "untrusted"]]); assert.equal((await status(alias)).trusted, false, "conflicting aliases fail closed");
	await configure([[child, "invalid"]]); assert.equal((await status(child)).trusted, false);
	await writeFile(user, 'invalid = "private-value');
	const malformed = await client.call("lsp_status", { workspace: child }); assert(malformed.isError); assert.match(malformed.content[0].text, /Invalid TOML/); assert(!malformed.content[0].text.includes("private-value"));
	assert.equal(hook(child, "SessionEnd", "child"), "", "session cleanup survives malformed user trust");
	await rm(user); assert.equal((await status(child)).trusted, false);
	await configure([[root, "trusted"]]);
	const installed = join(home, "plugins", "cache", "example", "plugin", "0.6.0", "dist", "cli.js");
	await mkdir(resolve(installed, ".."), { recursive: true }); await cp(cli, installed);
	const originalTrust = await readFile(user, "utf8"), sanitized = { ...process.env, CODEX_LSP_CACHE: join(dir, "installed-cache") };
	delete sanitized.CODEX_HOME;
	const installedHook = event => {
		const result = spawnSync(process.execPath, [installed, "hook"], { cwd: root, env: sanitized, input: JSON.stringify({ cwd: root, session_id: "installed", hook_event_name: event }), encoding: "utf8", timeout: 10000 });
		assert.equal(result.status, 0, result.stderr); return result.stdout;
	};
	installedHook("SessionStart"); await writeFile(join(root, "main.js"), "installed hook changed\n");
	assert.match(installedHook("PostToolUse"), /trust fixture/, "installed Hook recovers CODEX_HOME after host environment sanitization");
	assert.equal(await readFile(user, "utf8"), originalTrust, "the plugin never writes Codex trust records");
	const bin = join(dir, "bin"); await mkdir(bin);
	const launcher = join(bin, process.platform === "win32" ? "npx.cmd" : "npx");
	await writeFile(launcher, "exit 99\n", { mode: 0o755 });
	await writeFile(join(home, "lsp-client.json"), JSON.stringify({ schemaVersion: 1, lsp: { typescript: "tsc" } }));
	await writeFile(join(root, "main.ts"), "export const value = 1;\n");
	await configure([[root, "untrusted"]]);
	const temporary = bundleClient(root, home, { PATH: bin });
	try {
		const selected = (await temporary.call("lsp_status", { path: "main.ts" })).structuredContent;
		assert.equal(selected.tools[0].tool.source, "temporary"); assert.equal(selected.trusted, false);
		const blocked = await temporary.call("check_diagnostics", { path: "main.ts", source: "lsp" });
		assert(blocked.isError); assert.match(blocked.content[0].text, /requires workspace trust in Codex user config\.toml/);
	} finally { await temporary.close(); }
});
