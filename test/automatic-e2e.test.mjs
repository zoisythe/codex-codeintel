import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { bundleClient } from "./bundle-client.mjs";

const cli = resolve("dist/cli.js");
async function fixture(t, mode = "pull") {
	const dir = await mkdtemp(join(tmpdir(), "codex-auto-")), root = join(dir, "project"), home = join(dir, "home"), log = join(dir, "spawns");
	await mkdir(root); await mkdir(home);
	const env = { ...process.env, CODEX_HOME: home, CODEX_LSP_CACHE: join(dir, "cache") };
	const config = { schemaVersion: 1, lsp: { fake: { command: [process.execPath, resolve("test/fixtures/fake-lsp.mjs")], extensions: [".fake"], env: { CODEX_LSP_TEST_MODE: mode, CODEX_LSP_TEST_LOG: log } } } };
	const configure = value => writeFile(join(home, "lsp-client.json"), JSON.stringify(value));
	await configure(config);
	await writeFile(join(home, "config.toml"), `[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`);
	const clients = [];
	const client = (environment = {}, script = cli, imports = []) => { const instance = bundleClient(root, home, { ...env, ...environment }, script, imports); clients.push(instance); return instance; };
	const hook = (event = "PostToolUse", session = "s", script = cli) => new Promise((resolve, reject) => {
		const started = performance.now();
		const child = spawn(process.execPath, [script, "hook"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.setEncoding("utf8").on("data", part => { stdout += part; });
		child.stderr.setEncoding("utf8").on("data", part => { stderr += part; });
		child.on("error", reject);
		child.on("exit", code => code === 0 ? resolve({ text: stdout, elapsed: performance.now() - started, value: stdout ? JSON.parse(stdout) : {} }) : reject(new Error(stderr)));
		child.stdin.end(JSON.stringify({ cwd: root, hook_event_name: event, session_id: session }));
	});
	const launches = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(Number);
	const state = async () => {
		const paths = (await readdir(env.CODEX_LSP_CACHE, { recursive: true })).filter(path => path.endsWith(".json"));
		const states = await Promise.all(paths.map(async path => JSON.parse(await readFile(join(env.CODEX_LSP_CACHE, path), "utf8"))));
		return states.find(entry => entry.id === "s");
	};
	t.after(async () => {
		const control = client();
		try { const status = (await control.call("lsp_status", { path: "main.fake" })).structuredContent; if (status.service?.pid) process.kill(status.service.pid, "SIGTERM"); } catch { /* Already exited. */ }
		await Promise.all(clients.map(instance => instance.close()));
		await delay(100); await rm(dir, { recursive: true, force: true });
	});
	return { dir, root, home, env, config, configure, client, hook, launches, state };
}

test("automatic delta feedback, shared cached channels, repair, deletion, move and missing baseline", { timeout: 30000 }, async t => {
	const f = await fixture(t);
	await writeFile(join(f.root, "main.fake"), "clean");
	assert.equal((await f.hook("SessionStart")).text, "");
	const first = f.client(), second = f.client();
	assert.equal((await first.call("lsp_status", { path: "main.fake" })).structuredContent.service.state, "stopped");
	assert.deepEqual(await f.launches(), []);
	await writeFile(join(f.root, "main.fake"), "broken");
	const cold = await f.hook(); assert.match(cold.text, /pull broken/); assert(cold.value.hookSpecificOutput.additionalContext);
	assert.equal((await second.call("check_diagnostics", { run: "cached", scope: "session", session: "s" })).structuredContent.errors, 1);
	assert.equal((await first.call("check_diagnostics", { run: "cached", path: "main.fake", source: "lsp" })).structuredContent.errors, 1);
	assert.equal((await f.hook()).text, "", "unchanged feedback is deduplicated");
	await writeFile(join(f.root, "main.fake"), "clean now");
	const hot = await f.hook(); assert.match(hot.text, /previous diagnostics cleared/);
	assert.equal((await f.hook()).text, "");
	assert.equal((await f.launches()).length, 1, "Hook and two MCP connections share one LSP");
	await writeFile(join(f.root, "added.fake"), "broken"); assert.match((await f.hook()).text, /added.fake/);
	await rename(join(f.root, "added.fake"), join(f.root, "moved.fake"));
	const moved = await f.hook(); assert.match(moved.text, /moved.fake/); assert.match(moved.text, /added.fake removed/);
	await rm(join(f.root, "moved.fake")); assert.match((await f.hook()).text, /moved.fake removed/);
	const cached = (await first.call("check_diagnostics", { run: "cached", scope: "session", session: "s" })).structuredContent;
	assert(!cached.results.some(result => result.path.includes("added") || result.path.includes("moved")));
	await writeFile(join(f.root, "untouched.fake"), "broken");
	const fallback = await f.hook("PostToolUse", "no-baseline"); assert.match(fallback.text, /Automatic full/); assert.match(fallback.text, /untouched.fake/);
	const stop = await f.hook("Stop"); assert.equal(stop.value.decision, undefined); assert.match(stop.value.systemMessage, /Automatic full: complete/);
	const status = (await first.call("lsp_status", { path: "main.fake" })).structuredContent;
	assert.deepEqual(status.automaticDiagnostics, { postToolUse: "delta", stop: "full" }); assert(status.automaticTasks.length);
	t.diagnostic(JSON.stringify({ platform: process.platform, coldMs: cold.elapsed, hotMs: hot.elapsed, lspStarts: (await f.launches()).length, serviceIdentity: status.service.identity }));
});

test("concurrent startup, short wait, background completion, crash recovery and session isolation", { timeout: 30000 }, async t => {
	const f = await fixture(t, "cold");
	await writeFile(join(f.root, "main.fake"), "clean");
	await Promise.all([f.hook("SessionStart", "s"), f.hook("SessionStart", "other")]);
	await writeFile(join(f.root, "main.fake"), "broken");
	const reports = await Promise.all([f.hook(), f.hook("PostToolUse", "other")]);
	assert(reports.every(report => report.elapsed < 5500)); assert(reports.some(report => /pending/.test(report.text)));
	assert.equal((await f.launches()).length, 1, "startup mutex and shared client prevent duplicate launches");
	await delay(3000);
	assert.match((await f.hook()).text, /broken fixture/, "later Hook retrieves background completion");
	const c = f.client();
	const status = (await c.call("lsp_status", { path: "main.fake" })).structuredContent;
	await f.hook("SessionEnd", "s");
	assert((await c.call("lsp_status", { path: "main.fake" })).structuredContent.sessions.includes("other"));
	process.kill(status.service.pid, "SIGTERM"); await delay(800);
	await writeFile(join(f.root, "main.fake"), "clean again");
	const restored = await f.hook("PostToolUse", "other"); assert.match(restored.text, /pending|cleared/);
	await delay(3000);
	const after = (await c.call("lsp_status", { path: "main.fake" })).structuredContent;
	assert.notEqual(after.service.pid, status.service.pid); assert.equal((await f.launches()).length, 2);
});

test("full automatic job completes all pages and installed identical bundles share service", { timeout: 30000 }, async t => {
	const f = await fixture(t);
	await Promise.all(Array.from({ length: 73 }, (_, index) => writeFile(join(f.root, `page-${String(index).padStart(3, "0")}.fake`), index === 72 ? "broken" : "clean")));
	await f.hook("SessionStart");
	const report = await f.hook("Stop"); assert.match(report.text, /checked=73\/73/); assert.match(report.text, /page-072.fake/); assert.equal(report.value.decision, undefined);
	const copy = join(f.dir, "installed.mjs"); await cp(cli, copy);
	const first = f.client(), second = f.client({}, copy);
	const status = async client => (await client.call("lsp_status", { path: "page-000.fake" })).structuredContent;
	assert.equal((await status(first)).service.pid, (await status(second)).service.pid);
	let args = { run: "cached", path: ".", source: "both" }, files = [];
	do { const response = (await second.call("check_diagnostics", args)).structuredContent; files.push(...response.results); args = response.next; } while (args);
	assert.equal(files.length, 73); assert.equal(files.filter(file => file.state === "complete").length, 73);
	assert.equal((await f.state()).pending.length, 0);
});

test("local-only automatic execution, independent lint, off overrides, trust revocation and configuration invalidation", { timeout: 15000 }, async t => {
	const f = await fixture(t);
	await writeFile(join(f.root, "main.py"), "import os\n");
	await f.configure({ schemaVersion: 1, lsp: { python: { command: [join(f.dir, "missing-lsp")], extensions: [".py"] } } });
	await f.hook("SessionStart"); await writeFile(join(f.root, "main.py"), "import sys\n");
	const missing = await f.hook(); assert.match(missing.text, /missing|Missing/i); assert.match(missing.text, /partial/); assert.deepEqual(await f.launches(), []);
	await f.configure({ schemaVersion: 1, automaticDiagnostics: { postToolUse: "off", stop: "off" } });
	assert.equal((await f.hook()).text, ""); assert.equal((await f.hook("Stop")).text, "");
	await f.configure(f.config);
	await writeFile(join(f.root, "main.fake"), "broken"); assert.match((await f.hook()).text, /pull broken/);
	await writeFile(join(f.home, "config.toml"), `[projects.${JSON.stringify(f.root)}]\ntrust_level = "untrusted"\n`);
	await writeFile(join(f.root, "main.fake"), "broken again");
	assert.match((await f.hook()).text, /requires workspace trust/);
	const c = f.client(); const cached = await c.call("check_diagnostics", { path: "main.fake", run: "cached" }); assert(!JSON.stringify(cached).includes("pull broken"));
	const metadata = JSON.stringify(await f.state()); assert(!metadata.includes("pull broken")); assert(metadata.includes("pendingChannels"));
});

test("Stop full finds an unmodified caller after native TypeScript interface edit", { timeout: 20000 }, async t => {
	const f = await fixture(t);
	await symlink(resolve("node_modules"), join(f.root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
	await f.configure({ schemaVersion: 1, lsp: { typescript: "tsc" }, lint: { javascript: "off" } });
	await writeFile(join(f.root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ["*.ts"] }));
	await writeFile(join(f.root, "defs.ts"), "export function value(): number { return 1; }\n");
	await writeFile(join(f.root, "caller.ts"), 'import { value } from "./defs";\nconst answer: number = value();\n');
	await f.hook("SessionStart");
	await writeFile(join(f.root, "defs.ts"), 'export function value(): string { return "one"; }\n');
	const delta = await f.hook(); assert(!delta.text.includes("caller.ts:"), delta.text);
	const full = await f.hook("Stop"); assert.match(full.text, /caller.ts.*error/); assert.equal(full.value.decision, undefined);
	await writeFile(join(f.root, "defs.ts"), "export function value(): number { return 1; }\n");
	await f.hook(); assert.match((await f.hook("Stop")).text, /previous diagnostics cleared/);
});

test("request environments invalidate cached results and use separate client identities in one service", { timeout: 15000 }, async t => {
	const f = await fixture(t);
	await writeFile(join(f.root, "main.fake"), "broken");
	const first = f.client({ TEST_EXECUTION_ID: "first", EXECUTION_SECRET_SENTINEL: "must-not-appear-in-status" }), second = f.client({ TEST_EXECUTION_ID: "second" });
	const args = { path: "main.fake", source: "lsp" };
	assert.equal((await first.call("check_diagnostics", args)).structuredContent.errors, 1);
	assert.equal((await second.call("check_diagnostics", { ...args, run: "cached" })).structuredContent.results[0].state, "stale");
	assert.equal((await second.call("check_diagnostics", args)).structuredContent.errors, 1);
	assert.equal((await f.launches()).length, 2, "execution environment participates in client and tool identity");
	const a = (await first.call("lsp_status", { path: "main.fake" })).structuredContent;
	const b = (await second.call("lsp_status", { path: "main.fake" })).structuredContent;
	assert.equal(a.service.pid, b.service.pid);
	assert(!JSON.stringify(a).includes("must-not-appear-in-status"));
});

test("superseded generations discard old errors and revocation cancels cold background tasks", { timeout: 25000 }, async t => {
	const f = await fixture(t, "cold");
	await writeFile(join(f.root, "main.fake"), "clean"); await f.hook("SessionStart");
	await writeFile(join(f.root, "main.fake"), "broken"); assert.match((await f.hook()).text, /pending/);
	await writeFile(join(f.root, "main.fake"), "clean now");
	const current = await f.hook(); assert(!current.text.includes("broken fixture"), current.text);
	await delay(3000);
	const delivered = await f.hook(); assert(!delivered.text.includes("broken fixture"), delivered.text);
	await writeFile(join(f.root, "main.fake"), "broken again");
	await f.configure({ ...f.config, lsp: { fake: { ...f.config.lsp.fake, env: { ...f.config.lsp.fake.env, CODEX_LSP_TEST_MODE: "cold", RESTART: "true" } } } });
	assert.match((await f.hook()).text, /pending/);
	await writeFile(join(f.home, "config.toml"), `[projects.${JSON.stringify(f.root)}]\ntrust_level = "untrusted"\n`);
	await delay(1200);
	const status = (await f.client().call("lsp_status", { path: "main.fake" })).structuredContent;
	assert(status.automaticTasks.every(job => job.state !== "running")); assert.equal(status.tools[0].running, false);
	assert((await f.state()).pending.includes("main.fake"));
});

test("service hard crash cleans stale endpoint and reconstructs durable pending range", { timeout: 20000 }, async t => {
	const f = await fixture(t, "cold");
	await writeFile(join(f.root, "main.fake"), "clean"); await f.hook("SessionStart");
	await writeFile(join(f.root, "main.fake"), "broken"); await f.hook();
	const c = f.client();
	// Status is serialized behind initialization; wait for a complete old task first.
	const old = (await c.call("lsp_status", { path: "main.fake" })).structuredContent;
	await writeFile(join(f.root, "main.fake"), "broken after crash");
	process.kill(old.service.pid, "SIGKILL"); await delay(400);
	const resumed = await f.hook(); assert.match(resumed.text, /pending|broken fixture/);
	await delay(3000);
	const status = (await c.call("lsp_status", { path: "main.fake" })).structuredContent;
	assert.notEqual(status.service.pid, old.service.pid); assert.equal(status.service.identity, old.service.identity);
	assert.equal((await f.launches()).length, 2);
});

test("automatic startup failure and inventory limits are partial and never block Stop", { timeout: 15000 }, async t => {
	const f = await fixture(t, "startup-fail");
	await writeFile(join(f.root, "main.fake"), "clean"); await f.hook("SessionStart");
	await writeFile(join(f.root, "main.fake"), "broken");
	const failed = await f.hook(); assert.match(failed.text, /partial/); assert.match(failed.text, /failed|initialization/i);
	const stop = await f.hook("Stop"); assert.equal(stop.value.decision, undefined); assert.match(stop.value.systemMessage, /partial/);
	await writeFile(join(f.root, "oversized.fake"), "x".repeat(1024 * 1024 + 1));
	const exceeded = await f.hook("Stop"); assert.match(exceeded.text, /limit exceeded|1 MiB/); assert.equal(exceeded.value.decision, undefined);
});

test("automatic total timeout retains pending metadata and Stop reports incomplete without blocking", { timeout: 20000 }, async t => {
	const f = await fixture(t, "slow");
	await writeFile(join(f.root, "main.fake"), "clean");
	const preload = join(f.dir, "short-job.mjs");
	await writeFile(preload, 'const original=AbortSignal.timeout;AbortSignal.timeout=ms=>original.call(AbortSignal,ms===300000?1200:ms);');
	const c = f.client({}, cli, ["--import", pathToFileURL(preload).href]);
	assert.equal((await c.call("check_diagnostics", { path: "main.fake", source: "lsp" })).structuredContent.results[0].state, "pending");
	await f.hook("SessionStart"); await writeFile(join(f.root, "main.fake"), "broken");
	const report = await f.hook(); assert.match(report.text, /five-minute budget/); assert.match(report.text, /pending/);
	assert((await f.state()).pending.includes("main.fake"));
	const stop = await f.hook("Stop"); assert.equal(stop.value.decision, undefined); assert.match(stop.text, /partial/);
});

test("automatic built-in resolution never invokes an available temporary launcher", { skip: process.platform === "win32", timeout: 10000 }, async t => {
	const f = await fixture(t);
	const bin = join(f.dir, "bin"), log = join(f.dir, "unexpected-download"); await mkdir(bin);
	await writeFile(join(bin, "uvx"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(log)}, "unexpected"); process.exit(99);\n`, { mode: 0o755 });
	f.env.PATH = bin;
	await f.configure({ schemaVersion: 1, lint: { python: "off" } });
	await writeFile(join(f.root, "main.py"), "value: int = 1\n"); await f.hook("SessionStart");
	await writeFile(join(f.root, "main.py"), 'value: int = "wrong"\n');
	assert.match((await f.hook()).text, /Tool missing: ty/);
	assert.equal(await readFile(log, "utf8").catch(() => ""), "");
	await f.configure({ schemaVersion: 1, lint: { python: "off" }, lsp: { python: { command: [join(bin, "uvx"), "ty", "server"], extensions: [".py"] } } });
	assert.match((await f.hook()).text, /Automatic temporary launcher disabled/);
	assert.equal(await readFile(log, "utf8").catch(() => ""), "");
});

test("IPC rejects incorrect authentication and protocol before executing writes", { timeout: 10000 }, async t => {
	const f = await fixture(t);
	await writeFile(join(f.root, "main.fake"), "broken");
	const c = f.client(); await c.call("check_diagnostics", { path: "main.fake", source: "lsp" });
	const status = (await c.call("lsp_status", { path: "main.fake" })).structuredContent;
	const user = process.getuid?.() ?? null;
	if (user === null) return; // The Windows user-derived path is verified by its native runner.
	const endpoint = JSON.parse(await readFile(join(tmpdir(), `clsp6-${user}`, `${status.service.identity}.endpoint`), "utf8"));
	for (const credentials of [{ token: "invalid", protocol: endpoint.protocol }, { token: endpoint.token, protocol: -1 }]) {
		await new Promise((resolve, reject) => {
			const socket = createConnection(endpoint.address); let output = "";
			const timer = setTimeout(() => { socket.destroy(); reject(new Error("Unauthenticated IPC did not close")); }, 1500);
			socket.on("data", data => { output += data; }); socket.on("error", () => {});
			socket.once("connect", () => socket.write(JSON.stringify({ ...credentials, identity: endpoint.identity, operation: "lsp_format", args: { path: "main.fake" }, environment: f.env }) + "\n"));
			socket.once("close", () => { clearTimeout(timer); assert.equal(output, ""); resolve(); });
		});
	}
	assert.equal(await readFile(join(f.root, "main.fake"), "utf8"), "broken");
	assert.equal((await c.call("check_diagnostics", { path: "main.fake", source: "lsp", run: "cached" })).structuredContent.errors, 1);
});
