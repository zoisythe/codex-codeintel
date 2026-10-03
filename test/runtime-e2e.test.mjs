import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// This suite also runs in CI's no-submodule/no-node_modules delivery job.
test("shared MCP and Hook reuse, explicit writes and connection cleanup", { timeout: 60000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "codex-isolated-"));
	const root = join(dir, "project");
	const home = join(dir, "home");
	await mkdir(root); await mkdir(home);
	const cli = join(dir, "cli.mjs");
	await cp(resolve("dist/cli.js"), cli);
	const log = join(dir, "spawns");
	const config = join(home, "lsp-client.json");
	await writeFile(join(home, "config.toml"), `[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`);
	await writeFile(config, JSON.stringify({ schemaVersion: 1, automaticDiagnostics: { postToolUse: "off", stop: "off" }, lsp: { fake: { command: [process.execPath, resolve("test/fixtures/fake-lsp.mjs")], extensions: [".fake"], env: { CODEX_LSP_TEST_LOG: log } } } }));
	await writeFile(join(root, "main.fake"), "broken\n");
	const env = { ...process.env, CODEX_HOME: home, CODEX_LSP_CACHE: join(dir, "cache") };
	const children = [];
	let servicePid;
	t.after(async () => {
		for (const child of children) if (child.exitCode === null) child.kill();
		if (servicePid) {
			if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(servicePid), "/f", "/t"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
			else try { process.kill(servicePid, "SIGTERM"); } catch { /* The fixture service may already have exited. */ }
		}
		await delay(200);
		await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});
	const client = async () => {
		const child = spawn(process.execPath, [cli, "mcp"], {cwd: root, env, stdio: ["pipe", "pipe", "pipe"]});
		children.push(child);
		const exit = once(child, "exit");
		const responses = new Map();
		createInterface({input: child.stdout}).on("line", (line) => { const value = JSON.parse(line); responses.set(value.id, value); });
		let id = 0;
		const request = async (method, params) => {
			const key = ++id;
			child.stdin.write(`${JSON.stringify({jsonrpc: "2.0", id: key, method, params})}\n`);
			const deadline = performance.now() + 50000;
			while (performance.now() < deadline) {
				t.signal.throwIfAborted();
				if (responses.has(key)) return responses.get(key).result;
				assert.equal(child.exitCode, null, "MCP exited before responding");
				await delay(5, undefined, {signal: t.signal});
			}
			assert.fail(`MCP request timed out: ${method} ${params?.name ?? ""}`);
		};
		const init = await request("initialize", {});
		assert.equal(init.serverInfo.name, "codex-codeintel");
		assert.equal(init.serverInfo.version, "0.9.0");
		return {request, async call(name, args = {}) { const result = await request("tools/call", {name, arguments: {workspace: root, session: "test", ...args}}); assert(!result.isError, JSON.stringify(result)); return result.content[0].text; }, async close() { child.stdin.end(); assert.deepEqual(await exit, [0, null]); }};
	};
	const hook = (event) => {
		const child = spawnSync(process.execPath, [cli, "hook"], { cwd: root, env, encoding: "utf8", timeout: 10000, input: JSON.stringify({ cwd: root, session_id: "test", turn_id: "t1", hook_event_name: event }) });
		assert.equal(child.status, 0, child.stderr);
		return child.stdout;
	};
	const first = await client();
	assert.equal(await readFile(log, "utf8").catch(() => ""), "", "initialize is lazy");
	assert.equal(hook("SessionStart"), "");
	await writeFile(join(root, "main.fake"), "broken again\n");
	assert.equal(hook("PostToolUse"), "");
	assert.match(await first.call("check_diagnostics", {path: "main.fake"}), /fake\/E1/);
	const serviceStatus = await first.request("tools/call", {name: "lsp_status", arguments: {workspace: root, path: "main.fake"}});
	servicePid = serviceStatus.structuredContent.service.pid;
	assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1, "Hook owns a shared LSP through the service");
	assert.match(await first.call("check_diagnostics", {scope: "session", run: "cached"}), /fake\/E1/);
	assert.match(await first.call("check_diagnostics", {path: "main.fake"}), /fake\/E1/);
	assert.match(await first.call("check_diagnostics", {path: "main.fake"}), /fake\/E1/);
	assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1);
	const second = await client();
	assert.match(await second.call("check_diagnostics", {scope: "session", run: "cached"}), /fake\/E1/);
	await second.call("check_diagnostics", {path: "main.fake"});
	assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1);
	await second.close();
	assert.match(await first.call("lsp_format", {path: "main.fake"}), /Formatted/);
	assert.equal(await readFile(join(root, "main.fake"), "utf8"), "fixed! again\n");
	assert.match(await first.call("lsp_rename", {path: "main.fake", newName: "renamed"}), /Renamed/);
	assert.equal(await readFile(join(root, "main.fake"), "utf8"), "renamed again\n");
	const count = (await readFile(log, "utf8")).trim().split("\n").length;
	await first.call("check_diagnostics", {path: "main.fake", refresh: true});
	assert.equal((await readFile(log, "utf8")).trim().split("\n").length, count + 1);
	await Promise.all(Array.from({length: 201}, (_,i) => writeFile(join(root, `page-${i}.fake`), "x")));
	const page = await first.call("check_diagnostics", {paths: Array.from({length: 100}, (_, i) => `page-${i}.fake`)});
	assert.match(page, /checked=/);
	const paged = await first.request("tools/call", {name: "check_diagnostics", arguments: {workspace: root, session: "test", paths: Array.from({length: 100}, (_, i) => `page-${i}.fake`)}});
	assert(paged.structuredContent.next?.cursor);
	assert(!(await first.request("tools/call", {name: "check_diagnostics", arguments: paged.structuredContent.next})).isError);
	await first.close();
	const last = Number((await readFile(log, "utf8")).trim().split("\n").at(-1)); assert.doesNotThrow(() => process.kill(last, 0), "MCP EOF does not kill shared clients");
});

test("MCP cancellation, partial writes, schema errors and recovery through the delivered bundle", {timeout: 30000}, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "codex-cancel-e2e-"));
	const root = join(dir, "project"); await mkdir(root);
	const cli = join(dir, "cli.mjs"); await cp(resolve("dist/cli.js"), cli);
	const log = join(dir, "spawns");
	await writeFile(join(dir, "config.toml"), `[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`);
	const config = join(dir, "lsp-client.json");
	const configure = (mode) => writeFile(config, JSON.stringify({schemaVersion:1,automaticDiagnostics:{postToolUse:"off",stop:"off"},lsp: {fake: {command: [process.execPath, resolve("test/fixtures/fake-lsp.mjs")], extensions: [".fake"], env: {CODEX_LSP_TEST_LOG: log, CODEX_LSP_TEST_MODE: mode}}}}));
	await configure("slow");
	await writeFile(join(root, "a.fake"), "broken\n");
	await writeFile(join(root, "b.fake"), "broken\n");
	const preload = join(dir, "delay-write.mjs");
	await writeFile(preload, 'import fs from "node:fs/promises";import {syncBuiltinESMExports} from "node:module";const original=fs.writeFile;fs.writeFile=async (...args)=>{await original(...args);if(String(args[0]).endsWith("a.fake")) await new Promise(r=>setTimeout(r,400));};syncBuiltinESMExports();');
	const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, cli, "mcp"], {cwd: root, env: {...process.env, CODEX_HOME: dir, CODEX_LSP_CACHE: join(dir, "cache")}, stdio: ["pipe", "pipe", "pipe"]});
	const exited = once(child, "exit");
	t.after(async () => {if(child.exitCode === null) {child.kill(); await exited;} await rm(dir, {recursive: true, force: true});});
	const results = new Map();
	let stderr = ""; child.stderr.setEncoding("utf8").on("data", chunk => {stderr += chunk;});
	createInterface({input: child.stdout}).on("line", (line) => {const value = JSON.parse(line); results.set(value.id, value.result);});
	const until = async (condition) => {for(let i=0;i<2000;i++){if(await condition())return;await delay(5);}assert.fail(`Timed out; exit=${child.exitCode}; responses=${JSON.stringify([...results])}; stderr=${stderr}`);};
	let sequence = 0;
	const send = (method, params, id) => child.stdin.write(`${JSON.stringify({jsonrpc:"2.0", ...(id === undefined ? {} : {id}), method, params})}\n`);
	const begin = (name, args) => {const id=++sequence;send("tools/call", {name,arguments:{workspace:root,session:"s",...args}},id);return id;};
	const result = async (id) => {await until(()=>results.has(id));return results.get(id);};
	const cancel = (id) => send("notifications/cancelled", {requestId:id});
	const pids = async () => (await readFile(log,"utf8").catch(()=>"")).trim().split("\n").filter(Boolean).map(Number);
	const alive = (pid) => {try{process.kill(pid,0);return true;}catch{return false;}};
	for (const args of [{mode:"all",refresh:true},{mode:"status",refresh:false},{mode:"full",refresh:"yes"}]) {
		assert.equal((await result(begin("check_diagnostics", args))).isError,true);
	}
	const first = begin("check_diagnostics", {path:"a.fake"});
	await until(async ()=>(await pids()).length===1);
	const queued = begin("check_diagnostics", {path:"b.fake"});
	cancel(queued);
	assert.match((await result(queued)).content[0].text,/cancelled|aborted/i);
	assert(alive((await pids())[0]),"queued cancellation cannot kill the active LSP");
	cancel(first);
	assert.equal((await result(first)).isError,true);
	assert((await pids()).every(alive), "executing request cancellation preserves the service clients");
	assert.equal((await pids()).length,1,"cancelled queued request never starts a client");

	await configure("slow-second");
	const formatting=begin("lsp_format",{paths:["a.fake","b.fake"]});
	await until(async ()=>(await readFile(join(root,"a.fake"),"utf8")).startsWith("fixed!"));
	cancel(formatting);
	const partial=await result(formatting);
	assert.equal(partial.isError,true);
	assert.match(partial.content[0].text,/formatted.*a.fake/);
	assert.deepEqual(partial.structuredContent.modifiedPaths, ["a.fake"]);
	assert.equal(await readFile(join(root,"b.fake"),"utf8"),"broken\n");

	await writeFile(join(root,"a.fake"),"broken\n");
	await configure("two-files");
	const rename=begin("lsp_rename",{path:"a.fake",newName:"renamed"});
	await until(async ()=>(await readFile(join(root,"a.fake"),"utf8")).startsWith("renamed"));
	cancel(rename);
	const partialRename=await result(rename);
	assert.equal(partialRename.isError,true);
	assert.deepEqual(partialRename.structuredContent.modifiedPaths, ["a.fake"]);
	assert.equal(await readFile(join(root,"b.fake"),"utf8"),"broken\n");

	await configure("");
	const checked=await result(begin("check_diagnostics",{path:"b.fake",refresh:true}));
	assert(!checked.isError,JSON.stringify(checked));
	assert.match(checked.content[0].text,/fake\/E1/);
	child.stdin.end();
	assert.deepEqual(await exited,[0,null]);
	assert(alive((await pids()).at(-1)),"EOF preserves shared analysis process");
});

test("disabled automatic diagnostics establish no baseline and full mode requires migration", {timeout: 10000}, async t => {
	const dir = await mkdtemp(join(tmpdir(), "codeintel-disabled-"));
	t.after(() => rm(dir, {recursive: true, force: true}));
	await writeFile(join(dir,"lsp-client.json"), JSON.stringify({schemaVersion:1, automaticDiagnostics:{postToolUse:"off",stop:"off"}}));
	for (const event of ["SessionStart","PreToolUse","PostToolUse","Stop"]) {
		const child=spawnSync(process.execPath,[resolve("dist/cli.js"),"hook"],{cwd:dir,env:{...process.env,CODEX_HOME:dir,CODEX_LSP_CACHE:join(dir,"cache")},encoding:"utf8",input:JSON.stringify({cwd:dir,session_id:"s",hook_event_name:event,tool_name:"Write",tool_input:{path:"missing.ts"}})});
		assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,"");
	}
	await writeFile(join(dir,"lsp-client.json"),JSON.stringify({schemaVersion:1,automaticDiagnostics:{stop:"full"}}));
	const child=spawnSync(process.execPath,[resolve("dist/cli.js"),"hook"],{cwd:dir,env:{...process.env,CODEX_HOME:dir,CODEX_LSP_CACHE:join(dir,"cache")},encoding:"utf8",input:JSON.stringify({cwd:dir,session_id:"s",hook_event_name:"PreToolUse",tool_name:"Write",tool_input:{path:"new.ts"}})});
	assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,"");
});
