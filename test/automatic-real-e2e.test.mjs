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
		const userConfig = join(home, "lsp-client.json");
		await writeFile(userConfig, JSON.stringify({ schemaVersion: 1, automaticDiagnostics: {postToolUse:"delta",stop:"errors"}, lint: { javascript: "off", python: "off" }, ...(language === "native-typescript" ? { lsp: { typescript: "tsc" } } : {}) }));
		let path, clean, broken;
		if (language === "python") { await writeFile(join(root,"pyproject.toml"),"[project]\nname=\"fixture\"\nversion=\"0.1.0\"\n"); path = "main.py"; clean = "value: int = 1\n"; broken = 'value: int = "wrong"\n'; }
		else if (language.includes("typescript")) {
			await symlink(language === "typescript" ? join(tools, "node_modules") : resolve("node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
			await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ["*.ts"] }));
			path = "main.ts"; clean = "export const value: number = 1;\n"; broken = 'export const value: number = "wrong";\n';
		} else if (language === "c" || language === "cpp") {
			path = `main.${language}`; clean = "int main(void) { return 0; }\n"; broken = "int main(void) { return missing_name; }\n";
			await writeFile(join(root, "compile_flags.txt"), language === "c" ? "-std=c17\n" : "-std=c++17\n");
			const cfg = JSON.parse(await readFile(userConfig, "utf8"));
			cfg.projectChecks = [{ name: "compiler", cwd: ".", command: [language === "c" ? "clang" : "clang++", "-fsyntax-only", "-fdiagnostics-format=sarif", "-Wno-sarif-format-unstable", path], parser: "sarif", coverage: [path] }];
			await writeFile(userConfig, JSON.stringify(cfg));
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
			child.stdin.end(JSON.stringify({ cwd: root, session_id: language, hook_event_name: event, tool_name:"Write", tool_input:{path} }));
		});
		await hook("SessionStart");
		const baselineClient = bundleClient(root, home, { CODEX_LSP_CACHE: join(dir, "cache") });
		try {
			for (let attempt = 0; attempt < 60; attempt++) {
				const result = (await baselineClient.call("check_project", { run: "cached" })).structuredContent;
				if (result.state !== "missing" && result.state !== "running") { assert.equal(result.state, "complete", JSON.stringify(result)); break; }
				await delay(200);
			}
		} finally { await baselineClient.close(); }
		const pre = await hook("PreToolUse"); assert(!pre.output || !JSON.parse(pre.output).hookSpecificOutput?.permissionDecision, `${language}: ${pre.output}`);
		await writeFile(join(root, path), broken);
		const cold = await hook("PostToolUse");
		for (let attempt = 0; attempt < 8 && !feedback.some(output => /error \[/.test(output)); attempt++) { await delay(1500); await hook("PostToolUse"); }
		assert(feedback.some(output => /error \[/.test(output)), `${language}: no automatic error: ${feedback.join("\n")}`);
		await writeFile(join(root, path), clean);
		const hot = await hook("PostToolUse");
		for (let attempt = 0; attempt < 8 && !feedback.some(output => /introduced diagnostics repaired/g.test(output)); attempt++) { await delay(1500); await hook("PostToolUse"); }
		assert(feedback.some(output => /introduced diagnostics repaired/g.test(output)), `${language}: no automatic clearing: ${feedback.join("\n")}`);
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
	t.diagnostic(JSON.stringify({bundleSha256, summaries}));
});
function resolveCli() { return resolve("dist/cli.js"); }
test("automatic Cargo baseline refuses a missing Rustup toolchain without downloading", {skip: !enabled, timeout: 20000}, async t => {
	const dir = await mkdtemp(join(tmpdir(), "codeintel-rustup-gate-")), root = join(dir, "project"), home = join(dir, "home");
	await mkdir(join(root, "src"), {recursive: true}); await mkdir(home);
	await writeFile(join(root, "Cargo.toml"), '[package]\nname="no_download_fixture"\nversion="0.1.0"\nedition="2021"\n');
	await writeFile(join(root, "src/main.rs"), "fn main() {}\n");
	await writeFile(join(home, "config.toml"), `[projects.${JSON.stringify(root)}]\ntrust_level="trusted"\n`);
	await writeFile(join(home, "lsp-client.json"), JSON.stringify({schemaVersion: 1, automaticDiagnostics: {postToolUse:"delta",stop:"errors"}, lint: {javascript:"off",python:"off"}}));
	const env = {...process.env, CODEX_HOME:home, CODEX_LSP_CACHE:join(dir,"cache"), RUSTUP_TOOLCHAIN:"1.0.0", RUSTUP_AUTO_INSTALL:"1", RUSTUP_DIST_SERVER:"http://127.0.0.1:9"};
	const c = bundleClient(root,home,env);
	t.after(async () => {try {const status=(await c.call("lsp_status",{path:"src/main.rs"})).structuredContent; if(status.service.pid)process.kill(status.service.pid,"SIGTERM");}finally{await c.close();await delay(100);await rm(dir,{recursive:true,force:true});}});
	const hook = event => {
		const result=spawnSync(process.execPath,[resolveCli(),"hook"],{cwd:root,env,encoding:"utf8",timeout:10000,input:JSON.stringify({cwd:root,hook_event_name:event,session_id:"rustup",tool_name:"Write",tool_input:{path:"src/main.rs"}})});
		assert.equal(result.status,0,result.stderr); return result.stdout?JSON.parse(result.stdout):{};
	};
	hook("SessionStart");
	const gate=hook("PreToolUse"); assert.equal(gate.hookSpecificOutput?.permissionDecision,undefined);
	await delay(700);
	const result=(await c.call("check_project",{run:"cached"})).structuredContent;
	assert.equal(result.state,"failed");
	assert.match(result.checkers[0].note,/not installed/);
	assert.doesNotMatch(result.checkers[0].note,/syncing channel updates|downloading component/);
});
test("automatic Ruff baseline and MCP lint preserve source with fix/fix-only configured", {skip: !enabled, timeout:20000}, async t => {
	const dir=await mkdtemp(join(tmpdir(),"codeintel-ruff-readonly-")),root=join(dir,"project"),home=join(dir,"home");
	await mkdir(root);await mkdir(home);
	await writeFile(join(home,"config.toml"),`[projects.${JSON.stringify(root)}]\ntrust_level="trusted"\n`);
	await writeFile(join(home,"lsp-client.json"),JSON.stringify({schemaVersion:1,automaticDiagnostics:{postToolUse:"delta",stop:"errors"}}));
	await writeFile(join(root,"pyproject.toml"),'[tool.ruff]\nfix=true\nfix-only=true\n[tool.ruff.lint]\nselect=["F401"]\n');
	const original="import os\nvalue: int = 1\n";await writeFile(join(root,"main.py"),original);
	const env={...process.env,CODEX_HOME:home,CODEX_LSP_CACHE:join(dir,"cache")},c=bundleClient(root,home,env);
	t.after(async()=>{try{const status=(await c.call("lsp_status",{path:"main.py"})).structuredContent;if(status.service.pid)process.kill(status.service.pid,"SIGTERM");}finally{await c.close();await delay(100);await rm(dir,{recursive:true,force:true});}});
	for(const event of ["SessionStart","PreToolUse"]){const result=spawnSync(process.execPath,[resolveCli(),"hook"],{cwd:root,env,encoding:"utf8",timeout:10000,input:JSON.stringify({cwd:root,hook_event_name:event,session_id:"ruff-readonly",tool_name:"Write",tool_input:{path:"main.py"}})});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout?JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision:undefined,undefined,result.stdout);}
	assert.equal(await readFile(join(root,"main.py"),"utf8"),original);
	await delay(1000);
	const baseline=(await c.call("check_project",{run:"cached"})).structuredContent;
	assert.equal(baseline.state,"complete",JSON.stringify(baseline));assert(baseline.diagnostics.some(finding=>finding.source.includes("F401")));
	const diagnostic=await c.call("check_diagnostics",{path:"main.py",source:"lint"});
	assert.equal(diagnostic.isError,undefined);assert(diagnostic.structuredContent.errors>0);
	assert.equal(await readFile(join(root,"main.py"),"utf8"),original);
	await writeFile(join(root,"ty.toml"),'[src]\ninclude=["."]\nexclude=["."]\n');
	const excluded=spawnSync(process.execPath,[resolveCli(),"hook"],{cwd:root,env,encoding:"utf8",timeout:10000,input:JSON.stringify({cwd:root,hook_event_name:"PreToolUse",session_id:"ruff-readonly",tool_name:"Write",tool_input:{path:"main.py"}})});
	assert.equal(excluded.status,0,excluded.stderr);assert.equal(excluded.stdout,"",excluded.stdout);
	const excludedBaseline=(await c.call("check_project",{refresh:true})).structuredContent;assert.equal(excludedBaseline.checkers.find(check=>check.name==="python").state,"complete");
});
