import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { bundleClient } from "./bundle-client.mjs";

const cli = resolve("dist/cli.js");
const digest = (value) => createHash("sha256").update(value).digest("hex");
async function until(action, timeout = 12000) {
	const deadline = performance.now() + timeout;
	while (performance.now() < deadline) {
		const result = await action();
		if (result) return result;
		await delay(40);
	}
	assert.fail("Background task did not reach the expected state");
}
async function fixture(t, extra = {}, mode = "pull") {
	const dir = await mkdtemp(join(tmpdir(), "codeintel-background-"));
	const root = join(dir, "project"), home = join(dir, "home"), log = join(dir, "children.jsonl"), lspLog = join(dir, "lsp.log");
	await mkdir(root); await mkdir(home);
	await writeFile(join(root, "main.fake"), "clean\n");
	await writeFile(join(home, "config.toml"), `[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`);
	const config = { schemaVersion: 1, projectChecks: [{ name: "fake", cwd: ".", command: [process.execPath, resolve("test/fixtures/project-checker.mjs")], parser: "json", coverage: ["**/*.fake"] }], lsp: { fake: { command: [process.execPath, resolve("test/fixtures/fake-lsp.mjs")], extensions: [".fake"], env: { CODEX_LSP_TEST_MODE: mode, CODEX_LSP_TEST_LOG: lspLog } } } };
	const configure = (value = config) => writeFile(join(home, "lsp-client.json"), JSON.stringify(value));
	await configure();
	const preload = join(dir, "observe.mjs");
	await writeFile(preload, `import cp from "node:child_process";import {appendFileSync} from "node:fs";const original=cp.ChildProcess.prototype.spawn;cp.ChildProcess.prototype.spawn=function(options){const result=original.call(this,options);appendFileSync(process.env.CODEINTEL_CHILD_LOG,JSON.stringify({parent:process.pid,pid:this.pid,file:options.file,args:options.args?.includes("service")?[...options.args.slice(0,-1),"<redacted>"]:options.args,windowsHide:options.windowsHide})+"\\n");return result;};if(process.argv[2]==="service"&&process.env.CODEINTEL_SERVICE_DELAY)await new Promise(resolve=>setTimeout(resolve,Number(process.env.CODEINTEL_SERVICE_DELAY)));`);
	const env = { ...process.env, CODEX_HOME: home, CODEX_LSP_CACHE: join(dir, "cache"), CODEINTEL_CHILD_LOG: log, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`, ...extra };
	const records = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const session = "background-session";
	const hook = async (event, input = {}) => {
		const began = performance.now();
		const child = spawn(process.execPath, [cli, "hook"], { cwd: root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		let text = "", stderr = "";
		child.stdout.setEncoding("utf8").on("data", (part) => { text += part; });
		child.stderr.setEncoding("utf8").on("data", (part) => { stderr += part; });
		return new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) => code === 0 ? resolve({ text, value: text ? JSON.parse(text) : {}, ms: performance.now() - began }) : reject(new Error(stderr)));
			child.stdin.end(JSON.stringify({ cwd: root, session_id: session, turn_id: "turn-1", hook_event_name: event, ...input }));
		});
	};
	const pre = () => hook("PreToolUse", { tool_name: "Write", tool_input: { path: "main.fake" } });
	const post = () => hook("PostToolUse", { tool_name: "Write", tool_input: { path: "main.fake" } });
	const read = () => hook("PostToolUse", { tool_name: "exec_command", tool_input: { cmd: "rg clean .\\main.fake" } });
	const state = async () => {
		for (const path of await readdir(env.CODEX_LSP_CACHE, { recursive: true }).catch(() => [])) {
			if (!path.endsWith(".json")) continue;
			const value = JSON.parse(await readFile(join(env.CODEX_LSP_CACHE, path), "utf8"));
			if (value.id === session) return value;
		}
	};
	const identity = digest(JSON.stringify([process.getuid?.() ?? homedir(), await realpath(root), await realpath(home), digest(await readFile(cli, "utf8")), 1]));
	const endpointPath = join(tmpdir(), `clsp6-${process.getuid?.() ?? digest(homedir()).slice(0, 10)}`, `${identity}.endpoint`);
	const raw = async (operation, args) => {
		const endpoint = JSON.parse(await readFile(endpointPath, "utf8"));
		return new Promise((resolve, reject) => {
			const socket = createConnection(endpoint.address); let buffer = "";
			socket.setEncoding("utf8"); socket.setTimeout(2000, () => socket.destroy(new Error("Cache consumption stalled")));
			socket.once("error", reject);
			socket.once("connect", () => socket.write(JSON.stringify({ ...endpoint, operation, args, environment: Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string")) }) + "\n"));
			socket.on("data", (part) => { buffer += part; if (buffer.includes("\n")) { const result = JSON.parse(buffer); socket.destroy(); result.error ? reject(new Error(result.error)) : resolve(result.output); } });
		});
	};
	const consume = () => raw("hook", { session_id: session, turn_id: "turn-1", hook_event_name: "PostToolUse", tool_name: "exec_command", tool_input: { cmd: "rg clean ." } });
	const clients = [];
	const client = () => { const instance = bundleClient(root, home, env); clients.push(instance); return instance; };
	const write = (value) => writeFile(join(root, "main.fake"), value);
	t.after(async () => {
		await hook("SessionEnd").catch(() => undefined);
		await Promise.all(clients.map((instance) => instance.close()));
		for (const entry of (await records()).filter((entry) => entry.args?.includes("service"))) {
			if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(entry.pid), "/f", "/t"], { windowsHide: true, stdio: "ignore" });
			else try { process.kill(entry.pid, "SIGTERM"); } catch { /* An extra startup candidate may already have exited. */ }
		}
		await delay(150);
		// dir is the exact mkdtemp result, never a project or computed parent.
		assert.equal(dirname(dir), tmpdir()); assert(basename(dir).startsWith("codeintel-background-"));
		await rm(dir, { recursive: true, force: true });
	});
	return { root, home, env, config, configure, hook, pre, post, read, state, records, write, consume, raw, session, client, lspLog };
}

test("cold shell passthrough, bounded startup and explicit write baseline", { timeout: 30000 }, async (t) => {
	const f = await fixture(t, { CODEINTEL_SERVICE_DELAY: "5200", CHECK_DELAY: "1500" });
	await f.configure({ schemaVersion: 999 });
	for (const cmd of ["rg clean .\\main.fake", 'rg "\\bclean\\b" .', "Get-Content main.fake; Get-ChildItem", "Set-Content main.fake x", "cat $(touch main.fake)"]) {
		const result = await f.hook("PreToolUse", { session_id: "", tool_name: "exec_command", tool_input: { cmd } });
		assert.equal(result.text, ""); assert(result.ms < 1000, `Shell pre-hook took ${result.ms}ms`);
	}
	assert.equal((await f.records()).length, 0, "Pre hooks did not start a service or analysis");
	await f.configure();
	const start = await f.hook("SessionStart"); assert(start.ms < 1200, `SessionStart took ${start.ms}ms`);
	const waiting = f.pre(); await delay(200);
	assert.equal((await f.hook("PreToolUse", { tool_name: "exec_command", tool_input: { cmd: "rg clean ." } })).text, "");
	const gate = await waiting;
	assert.equal(gate.value.hookSpecificOutput?.permissionDecision, "deny"); assert(gate.ms < 5100, `Write startup wait exceeded its budget: ${gate.ms}`);
	await delay(2400);
	assert.equal((await f.pre()).text, "", "The independently started service and baseline remain reusable");
	const before = (await f.records()).filter((entry) => entry.args?.includes("ls-files")).length;
	const read = await f.read(); assert(read.ms < 1200);
	assert.equal((await f.records()).filter((entry) => entry.args?.includes("ls-files")).length, before, "A read result did not discover files again");
	t.diagnostic(JSON.stringify({ sessionStartMs: Math.round(start.ms), writeWaitMs: Math.round(gate.ms), readPostMs: Math.round(read.ms) }));
});

test("late delivery, acknowledgement retry, stale hashes, Stop repair and session epochs", { timeout: 35000 }, async (t) => {
	const f = await fixture(t, {}, "cold");
	assert.equal((await f.pre()).text, "");
	await f.write("broken\n"); const initial = await f.post();
	assert(!initial.text.includes("broken fixture"), "A cold analysis did not block the hook until completion");
	await until(async () => Object.keys((await f.state()).outbox).length);
	const before = (await f.records()).length;
	const first = await f.consume(), retry = await f.consume();
	assert(first.deliveryId); assert.equal(retry.deliveryId, first.deliveryId);
	assert.match(first.output.context, /automatic diagnostics.*deliveryId=/); assert.match(first.output.context, /broken fixture/);
	assert.equal((await f.records()).length, before, "Consuming completed results starts no processes");
	await f.raw("hook_ack", { session: f.session, deliveryId: first.deliveryId });
	assert.equal((await f.consume()).output.kind, "silent", "Acknowledged results are not repeated");
	assert.equal((await f.hook("Stop")).value.decision, "block");
	assert.notEqual((await f.hook("Stop")).value.decision, "block");
	await f.write("clean\n"); assert.match((await f.post()).text, /repaired/);
	const epoch = (await f.state()).epoch;
	await f.hook("SessionEnd"); assert.notEqual((await f.state()).epoch, epoch);
	assert.equal((await f.consume()).output.kind, "silent");
	const stale = await fixture(t, {}, "cold");
	await stale.pre(); await stale.write("broken old\n"); await stale.post();
	await until(async () => Object.keys((await stale.state()).outbox).length);
	await stale.write("clean\n");
	assert.equal((await stale.consume()).output.kind, "silent", "Changed contents invalidate an unacknowledged result");
	assert((await stale.state()).pending.includes("main.fake"));
	assert.notEqual((await stale.hook("Stop")).value.decision, "block");
	t.diagnostic(JSON.stringify({ coldPostMs: Math.round(initial.ms), deliveryId: first.deliveryId }));
});

test("hidden subprocesses, bounded Windows cleanup, shared startup and failure cooldown", { timeout: 20000 }, async (t) => {
	const f = await fixture(t, {}, "startup-fail");
	await f.hook("SessionStart"); await f.pre();
	const a = f.client(), b = f.client();
	const check = () => a.call("check_diagnostics", { path: "main.fake", source: "lsp", session: f.session });
	await check(); await f.write("clean second\n"); await check(); await f.write("clean third\n"); await check();
	const count = async () => (await readFile(f.lspLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length;
	assert.equal(await count(), 1, "Repeated initialization failures are cooled down");
	await a.call("lsp_status", { path: "main.fake", refresh: true }); await check();
	assert.equal(await count(), 2, "Explicit refresh resets cooldown");
	const statusA = (await a.call("lsp_status", { path: "main.fake" })).structuredContent;
	const statusB = (await b.call("lsp_status", { path: "main.fake" })).structuredContent;
	assert.equal(statusA.service.pid, statusB.service.pid);
	await f.configure({ ...f.config, lsp: { fake: { ...f.config.lsp.fake, env: { CODEX_LSP_TEST_MODE: "slow", CODEX_LSP_TEST_LOG: f.lspLog } } } });
	await check();
	const began = performance.now(); await a.call("lsp_status", { path: "main.fake", refresh: true });
	assert(performance.now() - began < 2500, "Cleanup does not synchronously stall the service");
	const records = await f.records();
	assert(records.length > 0); assert(records.every((entry) => entry.windowsHide === true), "Every production process launch hides its console");
	if (process.platform === "win32") assert(records.some((entry) => basename(entry.file).toLowerCase() === "taskkill"));
	t.diagnostic(JSON.stringify({ launches: records.length, allHidden: true, cooldownStarts: 2 }));
});
