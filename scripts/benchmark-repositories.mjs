// CLI baseline and Hook measurements in the same real source repositories as benchmark-review.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { bundleClient } from "../test/bundle-client.mjs";
await mkdir(resolve("docs/history"), { recursive: true });
const dir=await mkdtemp(join(tmpdir(),"codeintel-repo-perf-")),cli=join(dir,"after.mjs");
const bundle=await readFile("dist/cli.js");await writeFile(cli,bundle);
const summarize=values=>{const sorted=[...values].sort((a,b)=>a-b);return {p50:sorted[Math.floor((sorted.length-1)*.5)],p95:sorted.at(-1),samples:values}};
const results={node:process.version,platform:process.platform,bundleSHA256:createHash("sha256").update(bundle).digest("hex"),iterations:5,environment:{RAYON_NUM_THREADS:"4",CARGO_BUILD_JOBS:"2"},typescriptScope:"558 tracked TS/TSX source/test files outside intentionally invalid fixture directories, using an explicit no-emit config; missing package imports remain historical located diagnostics",repositories:[]};
const tsc=resolve("node_modules/typescript/bin/tsc");
for(const target of [{name:"vite",root:"/tmp/codeintel-bench-vite",path:"packages/vite/src/node/index.ts",parser:"tsc",lsp:{typescript:{command:[process.execPath,tsc,"--lsp","--stdio"],extensions:[".ts",".tsx"]}}},{name:"django",root:"/tmp/codeintel-bench-django",path:"django/__init__.py",parser:"ty",lsp:{python:"ty"}},{name:"clap",root:"/tmp/codeintel-bench-clap",path:"src/lib.rs",parser:"cargo",lsp:{rust:"rust"}}].filter(target => !process.env.REPO_FILTER || target.name === process.env.REPO_FILTER)) {
	const home=join(dir,target.name);await mkdir(home);
	const path=join(target.root,target.path),original=await readFile(path,"utf8");
	const command=target.parser==="tsc"?[process.execPath,tsc,"--noEmit","--pretty","false","-p",".codeintel-benchmark-tsconfig.json"]:target.parser==="ty"?["ty","check","--output-format","concise","--color","never"]:["cargo","+stable","check","--offline","--workspace","--all-targets","--message-format=json"];
	const coverage=target.parser==="tsc"?spawnSync("git",["ls-files","-co","--exclude-standard"],{cwd:target.root,encoding:"utf8"}).stdout.trim().split("\n").filter(path=>/\.tsx?$/.test(path)&&!path.split("/").includes("fixtures")):[target.parser==="ty"?"**/*.{py,pyi}":"**/*.rs"];
	if(target.parser==="tsc")await writeFile(join(target.root,".codeintel-benchmark-tsconfig.json"),JSON.stringify({compilerOptions:{strict:true,noEmit:true,target:"ESNext",module:"ESNext",moduleResolution:"Bundler",skipLibCheck:true,types:[]},files:coverage}));
	await writeFile(join(home,"config.toml"),`[projects.${JSON.stringify(target.root)}]\ntrust_level="trusted"\n`);
	await writeFile(join(home,"lsp-client.json"),JSON.stringify({schemaVersion:1,exclude:target.name==="vite"?["docs/images/ecosystem-vite4.webp","docs/public/og-image-announcing-vite4.webp","docs/public/og-image-announcing-vite5.webp"]:[],lsp:target.lsp,lint:{javascript:"off",python:"off"},projectChecks:[{name:target.name,cwd:".",command,parser:target.parser,coverage}]}));
	const env={...process.env,CODEX_HOME:home,CODEX_LSP_CACHE:join(dir,"cache"),RUSTUP_AUTO_INSTALL:"0",RUSTUP_TOOLCHAIN:"stable",RAYON_NUM_THREADS:"4",CARGO_BUILD_JOBS:"2"};
	const client=bundleClient(target.root,home,env,cli);
	const hook=input=>new Promise((resolve,reject)=>{const start=performance.now(),child=spawn(process.execPath,[cli,"hook"],{cwd:target.root,env,stdio:["pipe","pipe","pipe"]});let out="",err="";child.stdout.on("data",part=>out+=part);child.stderr.on("data",part=>err+=part);child.on("error",reject);child.on("exit",code=>code===0?resolve({ms:performance.now()-start,value:out?JSON.parse(out):{}}):reject(new Error(err)));child.stdin.end(JSON.stringify({cwd:target.root,session_id:"repository-benchmark",turn_id:"turn",...input}));});
	let servicePid;
	try {
		const before=performance.now();await hook({hook_event_name:"SessionStart"});let gate;
		for(let i=0;i<100;i++){gate=await hook({hook_event_name:"PreToolUse",tool_name:"Write",tool_input:{path:target.path}});if(!gate.value.hookSpecificOutput?.permissionDecision)break;await delay(500);}
		assert.equal(gate.value.hookSpecificOutput?.permissionDecision,undefined,JSON.stringify(gate.value));
		const baselineMs=performance.now()-before;
		const project=(await client.call("check_project")).structuredContent;
		const status=(await client.call("lsp_status",{path:target.path})).structuredContent;servicePid=status.service.pid;
		const post=[],empty=[],stop=[],reads=[],scans=[];
		for(let i=0;i<5;i++){
			await writeFile(path,original+(target.parser==="ty"?`\n# codeintel benchmark ${i}\n`:`\n// codeintel benchmark ${i}\n`));
			const update=await hook({hook_event_name:"PostToolUse",tool_name:"Write",tool_input:{path:target.path}});assert(!/baseline missing|discovery incomplete/.test(JSON.stringify(update.value)));post.push(update.ms);
			stop.push((await hook({hook_event_name:"Stop"})).ms);
			const first=(await client.call("lsp_status",{path:target.path})).structuredContent.index;
			empty.push((await hook({hook_event_name:"PostToolUse",tool_name:"exec_command",tool_input:{cmd:"git status --short"}})).ms);
			const second=(await client.call("lsp_status",{path:target.path})).structuredContent.index;reads.push(second.contentReads-first.contentReads);scans.push(second.scans-first.scans);
		}
		const final=(await client.call("lsp_status",{path:target.path})).structuredContent;
		assert(reads.every(read=>read===0));if(final.clients.processStarts!==1) console.log(JSON.stringify({name:target.name,status:final,pending:(await client.call("check_diagnostics",{path:target.path,run:"cached"})).structuredContent}));
		assert.equal(final.clients.processStarts,1);
		const result={...target,lsp:undefined,commit:spawnSync("git",["rev-parse","HEAD"],{cwd:target.root,encoding:"utf8"}).stdout.trim(),command,...(target.parser==="tsc"?{sourceFiles:coverage.length}:{}),baselineMs,projectState:project.state,projectErrors:project.errors,postMs:summarize(post),emptyShellMs:summarize(empty),stopMs:summarize(stop),emptyContentReads:reads,emptyScans:scans,lspStarts:final.clients.processStarts,unresolvedScope:final.automaticTasks};results.repositories.push(result);console.log(JSON.stringify(result));
	}finally{await writeFile(path,original);if(servicePid)try{process.kill(servicePid,"SIGTERM")}catch{}await client.close();await delay(800);}
}
await writeFile(process.env.REPO_FILTER ? `docs/history/performance-0.7-repository-${process.env.REPO_FILTER}.json` : "docs/history/performance-0.7-repositories.json",JSON.stringify(results,null,2)+"\n");
