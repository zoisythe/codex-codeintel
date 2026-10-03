import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { bundleClient } from "./bundle-client.mjs";

async function until(action, timeout = 12000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) { const value = await action(); if (value) return value; await delay(30); }
	assert.fail("Background analysis did not finish");
}
async function fixture(t, extra = {}, environment = {}) {
	const dir = await mkdtemp(join(tmpdir(), "codeintel-auto-")), root = join(dir, "project"), home = join(dir, "home"), log = join(dir, "lsp.log");
	await mkdir(root); await mkdir(home); await writeFile(join(root, "main.fake"), "clean\n");
	const env = { ...process.env, CODEX_HOME: home, CODEX_LSP_CACHE: join(dir, "cache"), ...environment };
	const config = { schemaVersion: 1, automaticDiagnostics: { postToolUse: "delta", stop: "errors" }, projectChecks: [{ name: "fake", cwd: ".", command: [process.execPath, resolve("test/fixtures/project-checker.mjs")], parser: "json", coverage: ["**/*.fake"] }], lsp: { fake: { command: [process.execPath, resolve("test/fixtures/fake-lsp.mjs")], extensions: [".fake"], env: { CODEX_LSP_TEST_MODE: "pull", CODEX_LSP_TEST_LOG: log } } }, ...extra };
	const configure = value => writeFile(join(home, "lsp-client.json"), JSON.stringify(value));
	await configure(config);
	const c = bundleClient(root, home, env);
	const status = async () => (await c.call("lsp_status", { path: "main.fake" })).structuredContent;
	const hook = (event = "PostToolUse", input = {}) => new Promise((resolveResult, reject) => {
		const began = performance.now(), child = spawn(process.execPath, [resolve("dist/cli.js"), "hook"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.setEncoding("utf8").on("data", value => { stdout += value; }); child.stderr.setEncoding("utf8").on("data", value => { stderr += value; });
		child.once("error", reject); child.once("close", code => code === 0 ? resolveResult({ text: stdout, value: stdout ? JSON.parse(stdout) : {}, ms: performance.now() - began }) : reject(new Error(stderr)));
		child.stdin.end(JSON.stringify({ cwd: root, hook_event_name: event, session_id: "s", turn_id: "turn-1", ...input }));
	});
	const state = async () => {
		for (const path of await readdir(env.CODEX_LSP_CACHE, { recursive: true }).catch(() => [])) {
			if (!path.endsWith(".json")) continue;
			const data = JSON.parse(await readFile(join(env.CODEX_LSP_CACHE, path), "utf8")); if (data.id === "s") return data;
		}
	};
	const read = () => hook("PostToolUse", { tool_name: "exec_command", tool_input: { cmd: "git status --short" } });
	const settle = () => until(async () => { const result = await status(); return result.hookTasks?.length === 0; });
	const start = async () => {
		await hook("SessionStart");
		await until(async () => { const value = (await c.call("check_project", { run: "cached" })).structuredContent; return value.state !== "missing" && value.state !== "running"; });
		await settle(); await read();
	};
	const post = async (input = {}) => {
		const result = await hook("PostToolUse", { tool_name: "Write", tool_input: { path: "main.fake" }, ...input });
		await settle(); const delivered = await read();
		return { ...result, text: (result.text.includes("deliveryId=") ? result.text : "") + delivered.text };
	};
	t.after(async () => { await hook("SessionEnd"); const s = await status(); if (s.service?.pid) try { process.kill(s.service.pid, "SIGTERM"); } catch {} await c.close(); await delay(100); await rm(dir, { recursive: true, force: true }); });
	return { dir, root, home, env, config, configure, c, status, hook, start, post, read, settle, state, write: value => writeFile(join(root, "main.fake"), value) };
}

test("default feedback reports introduced errors without blocking; PreToolUse never checks", { timeout: 20000 }, async t => {
	const f = await fixture(t); await f.start();
	assert.equal((await f.hook("PreToolUse", { session_id: "", tool_name: "Write", tool_input: { path: "main.fake" } })).text, "");
	await f.write("broken new\n"); const post = await f.post(); assert(post.ms < 1500, String(post.ms)); assert.match(post.text, /introduced=1/);
	assert.equal((await f.hook("Stop")).value.decision, undefined);
	const cached = (await f.c.call("check_diagnostics", { run: "cached", scope: "session", session: "s" })).structuredContent; assert.equal(cached.errors, 1);
});

test("global gate confirms new errors once per turn, historical shifts remain historical", { timeout: 25000 }, async t => {
	const f = await fixture(t, { stopGate: "introduced-errors" }); await f.write("broken historical\n"); await f.start();
	await f.write("\n\nbroken historical\n"); assert.equal((await f.post()).text, ""); assert.equal((await f.hook("Stop")).value.decision, undefined);
	await f.write("broken historical\nbroken duplicate\n"); assert.match((await f.post()).text, /introduced=1/);
	const stop = await f.hook("Stop"); assert.equal(stop.value.decision, "block"); assert.match(stop.value.reason, /pull broken/);
	assert.notEqual((await f.hook("SubagentStop")).value.decision, "block");
	assert.equal((await f.hook("Stop", { stop_hook_active: true })).text, "");
	await f.write("clean\n"); assert.match((await f.post()).text, /repaired/);
	await f.write("broken historical\nbroken again\n"); await f.post({ turn_id: "turn-2" }); assert.equal((await f.hook("Stop", { turn_id: "turn-2" })).value.decision, "block");
});

test("missing baseline still reports current diagnostics, cannot create post-edit history", { timeout: 15000 }, async t => {
	const f = await fixture(t, { stopGate: "introduced-errors" });
	await f.write("broken current\n"); const result = await f.post(); assert.match(result.text, /unattributed=1/); assert.match(result.text, /cannot be attributed/); assert.match(result.text, /pull broken/);
	assert.equal((await f.state()).diagnosticBaseline, null); assert.equal((await f.hook("Stop")).value.decision, undefined); assert.equal((await f.hook("PreToolUse", { tool_name: "Write", tool_input: { path: "main.fake" } })).text, "");
});

test("failed baseline and uncovered checks retain feedback but cannot gate", { timeout: 20000 }, async t => {
	for (const settings of [{ env: { CHECK_FAIL: "1" } }, { checks: [] }]) {
		const f = await fixture(t, { stopGate: "introduced-errors", ...(settings.checks ? { projectChecks: settings.checks } : {}) }, settings.env ?? {}); await f.start(); await f.write("broken\n"); assert.match((await f.post()).text, /unattributed=1/); assert.equal((await f.hook("Stop")).value.decision, undefined);
	}
});

test("one checker failure preserves reliable independent ranges", { timeout: 20000 }, async t => {
	const f = await fixture(t, { stopGate: "introduced-errors" }); await mkdir(join(f.root, "bad")); await writeFile(join(f.root, "bad", "other.fake"), "clean\n");
	await f.configure({ ...f.config, projectChecks: [...f.config.projectChecks, { name: "missing", cwd: "bad", command: [join(f.dir, "missing")], parser: "json", coverage: ["**/*.fake"] }] });
	await f.start(); await f.write("broken good range\n"); assert.match((await f.post()).text, /introduced=1/); assert.equal((await f.hook("Stop")).value.decision, "block");
	const project = (await f.c.call("check_project")).structuredContent; assert.equal(project.state, "failed"); assert(project.checkers.some(value => value.name === "fake" && value.state === "complete"));
});

test("project cannot enable gate and explicit global off takes precedence", { timeout: 15000 }, async t => {
	const f = await fixture(t, { stopGate: "off" }); await mkdir(join(f.root, ".codex")); await writeFile(join(f.root, ".codex", "lsp-client.json"), JSON.stringify({ schemaVersion: 1, stopGate: "introduced-errors" }));
	assert((await f.status()).configurationIssues.some(issue => /Project stopGate is ignored/.test(issue.message)));
	await f.start(); await f.write("broken\n"); await f.post(); assert.equal((await f.hook("Stop")).value.decision, undefined);
});

test("configuration and ending policy changes invalidate old baselines and deliveries", { timeout: 18000 }, async t => {
	const f = await fixture(t, { stopGate: "introduced-errors" }); await f.start(); await f.write("broken old\n"); await f.hook("PostToolUse", { tool_name: "Write", tool_input: { path: "main.fake" } }); await f.settle(); assert(Object.keys((await f.state()).outbox).length);
	await f.configure({ ...f.config, stopGate: "off" }); assert.equal((await f.c.call("check_project", {run:"cached"})).structuredContent.state,"stale"); assert.equal((await f.read()).text, ""); assert.equal((await f.hook("Stop")).value.decision, undefined);
	await f.configure({ ...f.config, stopGate: "introduced-errors" }); await f.write("broken new configuration\n"); assert.match((await f.post()).text, /unattributed=1/); assert.equal((await f.hook("Stop")).value.decision, undefined);
});

test("MCP formatting succeeds without a baseline; later diagnostic cancellation is supplementary", { timeout: 15000 }, async t => {
	const f = await fixture(t, {}, { CHECK_FAIL: "1" });
	await f.write("clean text\n");
	const result = await f.c.call("lsp_format", { path: "main.fake" }); assert.equal(result.isError, undefined, JSON.stringify(result)); assert(result.structuredContent.modifiedPaths.includes("main.fake"));
	assert.match(await readFile(join(f.root, "main.fake"), "utf8"), /fixed!/);
	assert.equal((await f.state())?.diagnosticBaseline ?? null, null);
});
