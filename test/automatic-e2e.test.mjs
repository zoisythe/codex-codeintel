import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { bundleClient } from "./bundle-client.mjs";
const cli = resolve("dist/cli.js");
const checker = resolve("test/fixtures/project-checker.mjs");
async function fixture(t, mode = "pull", extra = {}) {
	const dir = await mkdtemp(join(tmpdir(), "codeintel-auto-")), root = join(dir, "project"), home = join(dir, "home"), log = join(dir, "spawns");
	await mkdir(root); await mkdir(home);
	const env = { ...process.env, CODEX_HOME: home, CODEX_LSP_CACHE: join(dir, "cache"), ...extra };
	const config = { schemaVersion: 1, projectChecks: [{name: "fake", cwd: ".", command: [process.execPath, checker], parser: "json", coverage: ["**/*.fake"]}], lsp: { fake: { command: [process.execPath, resolve("test/fixtures/fake-lsp.mjs")], extensions: [".fake"], env: {CODEX_LSP_TEST_MODE: mode, CODEX_LSP_TEST_LOG: log} } } };
	const configure = value => writeFile(join(home, "lsp-client.json"), JSON.stringify(value));
	await configure(config); await writeFile(join(home, "config.toml"), `[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`);
	const clients = [];
	const client = (environment = {}, script = cli) => { const instance = bundleClient(root, home, { ...env, ...environment }, script); clients.push(instance); return instance; };
	const hook = (event = "PostToolUse", session = "s", input = {}) => new Promise((resolve, reject) => {
		const began = performance.now(); const child = spawn(process.execPath, [cli, "hook"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "", stderr = ""; child.stdout.setEncoding("utf8").on("data", part => {stdout += part;}); child.stderr.setEncoding("utf8").on("data", part => {stderr += part;});
		child.on("error", reject); child.on("exit", code => code === 0 ? resolve({text: stdout, value: stdout ? JSON.parse(stdout) : {}, elapsed: performance.now() - began}) : reject(new Error(stderr)));
		child.stdin.end(JSON.stringify({cwd: root, hook_event_name: event, session_id: session, turn_id: "turn-1", ...input}));
	});
	const pre = (path = "main.fake", session = "s") => hook("PreToolUse", session, {tool_name: "Write", tool_input: {path}});
	const start = async (session = "s") => {await hook("SessionStart", session); const gate = await pre("main.fake", session); assert.equal(gate.value.hookSpecificOutput?.permissionDecision, undefined, gate.text);};
	const launches = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
	const state = async () => {
		const paths = (await readdir(env.CODEX_LSP_CACHE, {recursive: true})).filter(path => path.endsWith(".json"));
		return (await Promise.all(paths.map(async path => JSON.parse(await readFile(join(env.CODEX_LSP_CACHE, path), "utf8"))))).find(entry => entry.id === "s");
	};
	t.after(async () => { const c = client(); try { const status = (await c.call("lsp_status", {path: "main.fake"})).structuredContent; if (status.service?.pid) process.kill(status.service.pid, "SIGTERM"); } catch {} await Promise.all(clients.map(c => c.close())); await delay(150); await rm(dir, {recursive: true, force: true}); });
	return {dir,root,home,env,config,configure,client,hook,pre,start,launches,state};
}
test("pre-edit historical diagnostics, delta, repair/reintroduction, Stop continuation once, shared cached results", {timeout: 30000}, async t => {
	const f = await fixture(t); await writeFile(join(f.root,"main.fake"),"broken historical"); await f.start();
	assert.equal((await f.hook("SessionStart")).text, ""); assert.equal((await f.launches()).length,0);
	await writeFile(join(f.root,"main.fake"),"broken historical\n\n"); assert.equal((await f.hook()).text, "", "historical finding suppressed");
	await writeFile(join(f.root,"main.fake"),"clean"); await f.hook();
	await writeFile(join(f.root,"new.fake"),"broken new"); assert.match((await f.hook()).text,/pull broken/);
	const c = f.client(); assert.equal((await c.call("check_diagnostics",{run:"cached",scope:"session",session:"s"})).structuredContent.errors,1);
	const first = await f.hook("Stop"); assert.equal(first.value.decision,"block"); assert.match(first.value.reason,/new.fake/);
	assert.equal((await f.hook("Stop", "s", {stop_hook_active:true})).text, ""); assert.notEqual((await f.hook("Stop")).value.decision,"block");
	await writeFile(join(f.root,"new.fake"),"clean"); assert.match((await f.hook()).text,/repaired/);
	await writeFile(join(f.root,"new.fake"),"broken again"); assert.match((await f.hook()).text,/pull broken/);
	assert.equal((await f.launches()).length,1); assert.equal((await f.hook()).text,"");
});
test("missing SessionStart starts before first edit; missing Post baseline cannot be fabricated", {timeout:10000}, async t => {
	const f=await fixture(t); await writeFile(join(f.root,"main.fake"),"clean"); assert.equal((await f.pre()).text,"");
	await writeFile(join(f.root,"main.fake"),"broken"); assert.match((await f.hook()).text,/pull broken/);
	assert.match((await f.hook("PostToolUse","late-session")).text,/Pre-edit baseline missing/);
});
test("failed/missing checker denies edits; reads and configuration repair pass; off removes gate", {timeout:15000}, async t => {
	const f=await fixture(t,"pull",{CHECK_FAIL:"1"}); await writeFile(join(f.root,"main.fake"),"clean"); await f.hook("SessionStart");
	assert.equal((await f.pre()).value.hookSpecificOutput.permissionDecision,"deny");
	assert.equal((await f.hook("PreToolUse","s",{tool_name:"exec_command",tool_input:{cmd:"git status --short"}})).text,"");
	assert.equal((await f.hook("PreToolUse","s",{tool_name:"Write",tool_input:{path:"tsconfig.json"}})).text,"");
	assert.equal((await f.hook("PreToolUse","s",{tool_name:"exec_command",tool_input:{cmd:"echo x > main.fake"}})).value.hookSpecificOutput.permissionDecision,"deny");
	await f.configure({...f.config,automaticDiagnostics:{postToolUse:"off",stop:"off"}}); assert.equal((await f.pre()).text,""); assert.equal((await f.hook()).text,"");
});
test("parallel project failures are isolated and uncovered files are denied",{timeout:15000},async t=>{
	const f=await fixture(t); await mkdir(join(f.root,"good")); await mkdir(join(f.root,"bad"));
	const localCommand=process.platform==="win32"?"node_modules/.bin/checker.cmd":"node_modules/.bin/checker";
	await mkdir(join(f.root,"good","node_modules/.bin"),{recursive:true});
	await writeFile(join(f.root,"good",localCommand),process.platform==="win32"?`@echo off\r\n"${process.execPath}" "${checker}" %*\r\n`:`#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(checker).href)});\n`);
	await chmod(join(f.root,"good",localCommand),0o755);
	await writeFile(join(f.root,"good/a.fake"),"clean");
	await f.configure({...f.config, projectChecks:[{...f.config.projectChecks[0],cwd:"good",command:[localCommand]},{name:"bad",cwd:"bad",command:[join(f.dir,"missing")],parser:"json",coverage:["**/*.fake"]}]});
	await f.hook("SessionStart"); assert.equal((await f.pre("good/a.fake")).text,"");
	assert.equal((await f.pre("bad/a.fake")).value.hookSpecificOutput.permissionDecision,"deny");
	assert.equal((await f.pre("uncovered.fake")).value.hookSpecificOutput.permissionDecision,"deny");
	const c=f.client(); const check=(await c.call("check_project")).structuredContent; assert.equal(check.state,"failed"); assert(check.checkers.some(check=>check.name==="fake"&&check.state==="complete"));
});
test("project active background and cached paging do not start analysis, strict wait then success", {timeout:15000},async t=>{
	const f=await fixture(t,"pull",{CHECK_DELAY:"4200"}); await writeFile(join(f.root,"main.fake"),"clean"); const c=f.client();
	assert.equal((await c.call("check_project",{run:"cached"})).structuredContent.state,"missing");
	await f.hook("SessionStart"); const gate=await f.pre(); assert.equal(gate.value.hookSpecificOutput.permissionDecision,"deny"); await delay(800); assert.equal((await f.pre()).text,"");
	const check=(await c.call("check_project",{refresh:true})).structuredContent; assert.equal(check.state,"running"); assert(check.next); await delay(1000); const cached=(await c.call("check_project",check.next)).structuredContent; assert.equal(cached.job,check.job);
});
test("service recovery retains reliable baseline and diagnostic generations stay isolated",{timeout:20000},async t=>{
	const f=await fixture(t); await writeFile(join(f.root,"main.fake"),"clean"); await f.start("s"); await f.start("other");
	await writeFile(join(f.root,"main.fake"),"broken"); assert.match((await f.hook()).text,/pull broken/);
	const c=f.client(); const old=(await c.call("lsp_status",{path:"main.fake"})).structuredContent; process.kill(old.service.pid,"SIGKILL"); await delay(250);
	assert.equal((await f.pre()).text,""); await writeFile(join(f.root,"main.fake"),"broken recovered"); await f.hook(); assert.equal((await f.hook("Stop")).value.decision,"block");
	await f.hook("SessionEnd"); assert.equal((await f.state()).turn,"__ended__"); assert.equal((await f.hook()).text,"");
});
test("ordinary config/clock/blocklist edits retain hot LSP; rename/delete and unchanged shell avoid content reads",{timeout:15000},async t=>{
	const f=await fixture(t); await writeFile(join(f.root,"main.fake"),"clean"); await f.start(); await writeFile(join(f.root,"main.fake"),"broken"); await f.hook();
	for(const name of ["config.fake","clock.fake","blocklist.fake"]) {await writeFile(join(f.root,name),"clean"); await f.hook();} assert.equal((await f.launches()).length,1);
	await rename(join(f.root,"main.fake"),join(f.root,"moved.fake")); await f.hook(); assert.match((await f.hook("Stop")).value.reason,/moved.fake/); await rm(join(f.root,"moved.fake")); await f.hook();
	const c=f.client(); const before=(await c.call("lsp_status",{path:"config.fake"})).structuredContent.index;
	assert.equal((await f.hook("PostToolUse","s",{tool_name:"exec_command",tool_input:{cmd:"git status --short"}})).text,"");
	const after=(await c.call("lsp_status",{path:"config.fake"})).structuredContent.index; assert.equal(after.contentReads,before.contentReads);
});
test("project CLI detects an unmodified TypeScript caller while Stop only considers touched files",{timeout:20000},async t=>{
	const f=await fixture(t); await symlink(resolve("node_modules"),join(f.root,"node_modules"),process.platform==="win32"?"junction":"dir");
	await f.configure({schemaVersion:1,lsp:{typescript:"tsc"},lint:{javascript:"off"}});
	await writeFile(join(f.root,"tsconfig.json"),JSON.stringify({compilerOptions:{strict:true,noEmit:true,types:[]},include:["*.ts"]}));
	await writeFile(join(f.root,"defs.ts"),"export function value(): number {return 1;}\n"); await writeFile(join(f.root,"caller.ts"),'import {value} from "./defs";\nconst answer: number = value();\n');
	await f.hook("SessionStart"); assert.equal((await f.pre("defs.ts")).text,""); await writeFile(join(f.root,"defs.ts"),'export function value(): string {return "one";}\n');
	const delta=await f.hook(); assert(!delta.text.includes("caller.ts:"),delta.text); assert.notEqual((await f.hook("Stop")).value.decision,"block");
	const c=f.client(); const project=(await c.call("check_project")).structuredContent; assert.equal(project.state,"complete"); assert(project.diagnostics.some(finding=>finding.path==="caller.ts"));
	assert.match((await c.call("check_diagnostics",{})).content[0].text,/check_project/);
});
test("identical installed bundles share service without dependencies, full mode migration is explicit",{timeout:10000},async t=>{
	const f=await fixture(t); await writeFile(join(f.root,"main.fake"),"clean"); await f.start(); const copy=join(f.dir,"installed.mjs"); await cp(cli,copy);
	const a=f.client(),b=f.client({},copy); assert.equal((await a.call("lsp_status",{path:"main.fake"})).structuredContent.service.pid,(await b.call("lsp_status",{path:"main.fake"})).structuredContent.service.pid);
	await f.configure({...f.config,automaticDiagnostics:{stop:"full"}}); assert.match((await a.call("lsp_status")).content[0].text,/Migration required/);
});

test("read-only diagnostics before the first MCP write do not masquerade as prior edits", {timeout:15000},async t=>{
	const f=await fixture(t);await writeFile(join(f.root,"main.fake"),"clean text");const c=f.client();
	assert.equal((await c.call("check_diagnostics",{path:"main.fake",source:"lsp"})).isError,undefined);
	const write=await c.call("lsp_format",{path:"main.fake"});assert.equal(write.isError,undefined,JSON.stringify(write));assert(write.structuredContent.modifiedPaths.includes("main.fake"));
	await f.hook("PostToolUse","late");assert.equal((await f.pre("main.fake","late")).value.hookSpecificOutput.permissionDecision,"deny","a late Post cannot be promoted into pre-edit baseline");
});

test("line shifts, duplicate diagnostic counts and late cancelled responses keep an exact unresolved ledger",{timeout:70000},async t=>{
	const f=await fixture(t);await writeFile(join(f.root,"main.fake"),"broken historical\n");await f.start();
	await writeFile(join(f.root,"main.fake"),"\n\nbroken historical\n");assert.equal((await f.hook()).text,"");
	await writeFile(join(f.root,"main.fake"),"broken historical\nbroken duplicate\n");assert.match((await f.hook()).text,/introduced=1/);assert.equal((await f.state()).unresolved["main.fake"].length,1);
	await writeFile(join(f.root,"main.fake"),"broken historical\nbroken duplicate\ndelayed-reply\n");assert.match((await f.hook()).text,/pending=1/);
	assert.equal((await f.state()).unresolved["main.fake"].length,1);assert.notEqual((await f.hook("Stop")).value.decision,"block","a pending empty response cannot confirm an error or a repair");
	await writeFile(join(f.root,"main.fake"),"broken historical\nbroken duplicate\n");await f.hook();assert.equal((await f.state()).unresolved["main.fake"].length,1);assert.equal((await f.hook("Stop")).value.decision,"block");
	await writeFile(join(f.root,"main.fake"),"clean\n");assert.match((await f.hook()).text,/repaired/);await delay(8300);assert.equal((await f.hook()).text,"");assert.equal((await f.state()).unresolved["main.fake"].length,0);assert.equal((await f.launches()).length,1);
});

test("auto type coverage exclusions and a missing configured lint checker fail closed",{timeout:20000},async t=>{
	const f=await fixture(t);await symlink(resolve("node_modules"),join(f.root,"node_modules"),process.platform==="win32"?"junction":"dir");
	await writeFile(join(f.root,"tsconfig.json"),JSON.stringify({compilerOptions:{noEmit:true,types:[]},files:["included.ts"]}));await writeFile(join(f.root,"included.ts"),"export const value = 1;\n");await writeFile(join(f.root,"excluded.ts"),"export const value = 1;\n");await writeFile(join(f.root,"unchecked.js"),"export const value = 1;\n");
	await f.configure({schemaVersion:1,lsp:{typescript:"tsc"},lint:{javascript:"off"}});await f.hook("SessionStart");assert.equal((await f.pre("unchecked.js")).value.hookSpecificOutput.permissionDecision,"deny");assert.equal((await f.pre("included.ts")).text,"");assert.equal((await f.pre("excluded.ts")).value.hookSpecificOutput.permissionDecision,"deny");
	await mkdir(join(f.root,"src/generated"),{recursive:true});await writeFile(join(f.root,"src/good.ts"),"export const value = 1;\n");await writeFile(join(f.root,"src/generated/ignored.ts"),'export const value: number = "wrong";\n');
	await writeFile(join(f.root,"tsconfig.json"),JSON.stringify({compilerOptions:{noEmit:true,types:[]},include:["./src"],exclude:["./src/generated"]}));assert.equal((await f.pre("src/good.ts")).text,"");assert.equal((await f.pre("src/generated/ignored.ts")).value.hookSpecificOutput.permissionDecision,"deny");
	await writeFile(join(f.root,"tsconfig.json"),JSON.stringify({compilerOptions:{noEmit:true,types:[]},include:["."],exclude:["./src/generated"]}));assert.equal((await f.pre("included.ts")).text,"");
	await writeFile(join(f.root,"eslint.config.js"),"export default [];\n");await f.configure({schemaVersion:1,lsp:{typescript:"tsc"},lint:{javascript:"eslint"}});const gate=await f.pre("included.ts");assert.equal(gate.value.hookSpecificOutput.permissionDecision,"deny");assert.match(gate.text,/eslint/i);
});
