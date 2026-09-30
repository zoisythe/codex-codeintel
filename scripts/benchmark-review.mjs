// Reproducible source-index and delivered Hook comparison against the review base.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { bundleClient } from "../test/bundle-client.mjs";

await mkdir(resolve("docs/history"), { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "codeintel-review-bench-"));
const base = process.env.BASELINE_REF ?? "d49812d";
const original = path => {
	const result = spawnSync("git", ["show", `${base}:${path}`], {encoding:"utf8",maxBuffer:16*1024*1024});
	if(result.status !== 0) throw new Error(result.stderr);
	return result.stdout;
};
const summarize = values => {
	const sorted = [...values].sort((a,b)=>a-b);
	return {p50:sorted[Math.floor((sorted.length-1)*0.5)],p95:sorted[Math.ceil((sorted.length-1)*0.95)],samples:values};
};
const retained = process.env.REUSE_BEFORE ? JSON.parse(await readFile("docs/history/performance-0.7.json", "utf8")) : undefined;
if (retained) { assert.equal(retained.base, base); assert.equal(retained.node, process.version); assert.equal(retained.platform, process.platform); }
const revisions = retained ? ["after"] : ["before", "after"];
const report = {base,node:process.version,platform:process.platform,afterSHA256:createHash("sha256").update(await readFile("dist/cli.js")).digest("hex"),iterations:10,...(retained?{baselineReuse:"Before samples retained from the prior same-host d49812d run; after freshly measured."}:{}),index:retained?.index.filter(row=>row.revision==="before")??[],hooks:retained?.hooks.filter(row=>row.revision==="before")??[]};
try {
	for(const revision of ["before","after"]) {
		await build({stdin:{contents:revision==="before"?original("src/files.ts"):await readFile("src/files.ts","utf8"),resolveDir:resolve("src"),loader:"ts"},outfile:join(temporary,`${revision}-index.mjs`),bundle:true,platform:"node",format:"esm",target:"node22.12"});
	}
	const monitor=join(temporary,"monitor.mjs");
	await writeFile(monitor,`import fs from 'node:fs/promises';import {writeFileSync} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=fs.readFile;let reads=0,bytes=0;fs.readFile=async(...args)=>{const result=await original(...args);if(String(args[0]).startsWith(process.env.BENCH_ROOT+'/')){reads++;bytes+=Buffer.byteLength(result)}return result};syncBuiltinESMExports();const save=()=>{try{if(process.env.BENCH_COUNTS)writeFileSync(process.env.BENCH_COUNTS+'/'+process.pid+'.json',JSON.stringify({reads,bytes}))}catch{}};setInterval(save,50).unref();process.on('exit',save);`);
	const worker=join(temporary,"index-worker.mjs");
	await writeFile(worker,`import {readFile,writeFile} from 'node:fs/promises';import {performance} from 'node:perf_hooks';const index=await import(process.argv[2]);const root=process.argv[3];await index.inventory(root,20000);const samples=[];for(let i=0;i<10;i++){const start=performance.now();await index.inventory(root,20000);samples.push(performance.now()-start)}console.log(JSON.stringify({samples,stats:index.indexStatistics?.()}));`);
	const beforeBundle=join(temporary,"before.mjs");await writeFile(beforeBundle,original("dist/cli.js"));
	const afterBundle=join(temporary,"after.mjs");await writeFile(afterBundle,await readFile("dist/cli.js"));
	const roots=[];
	for(const count of [1000,10000]) {
		const root=join(temporary,`sample-${count}`);await mkdir(join(root,"data"),{recursive:true});
		for(let i=0;i<count-1;i+=100)await Promise.all(Array.from({length:Math.min(100,count-1-i)},(_,j)=>writeFile(join(root,"data",`${i+j}.txt`),"dependency content\n")));
		await writeFile(join(root,"main.fake"),"clean");roots.push({name:`sample-${count}`,root,count});
	}
	for(const [name,root] of [["vite","/tmp/codeintel-bench-vite"],["django","/tmp/codeintel-bench-django"],["clap","/tmp/codeintel-bench-clap"]]) {
		const info=spawnSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"});if(info.status!==0)throw new Error(`${name}: clone unavailable`);
		roots.push({name,root,commit:info.stdout.trim()});
	}
	for(const target of roots) for(const revision of revisions) {
		const counts=join(temporary,`counts-${target.name}-${revision}`);await mkdir(counts);
		const result=spawnSync(process.execPath,["--import",monitor,worker,pathToFileURL(join(temporary,`${revision}-index.mjs`)).href,target.root],{encoding:"utf8",env:{...process.env,BENCH_ROOT:target.root,BENCH_COUNTS:counts},maxBuffer:4*1024*1024});
		if(result.status!==0)throw new Error(result.stderr);
		const values=JSON.parse(result.stdout);const readCounts=JSON.parse(await readFile(join(counts,`${result.pid}.json`),"utf8"));
		if(revision==="after")assert.equal(values.stats.contentReads,readCounts.reads/1,"index instrumentation agrees");
		const row={...target,revision,warmInventoryMs:summarize(values.samples),totalContentReadsIncludingCold:readCounts.reads,bytes:readCounts.bytes,...(values.stats?{stats:values.stats}:{})};
		report.index.push(row);console.log(JSON.stringify(row));
	}
	for(const target of roots.filter(target=>target.count))for(const revision of revisions) {
		const home=join(temporary,`home-${target.count}-${revision}`);await mkdir(home);
		const counts=join(temporary,`hook-counts-${target.count}-${revision}`);await mkdir(counts);
		const spawns=join(temporary,`spawns-${target.count}-${revision}`);
		await writeFile(join(home,"config.toml"),`[projects.${JSON.stringify(target.root)}]\ntrust_level="trusted"\n`);
		await writeFile(join(home,"lsp-client.json"),JSON.stringify({schemaVersion:1,lint:{javascript:"off",python:"off"},...(revision==="after"?{projectChecks:[{name:"fake",cwd:".",command:[process.execPath,resolve("test/fixtures/project-checker.mjs")],parser:"json",coverage:["**/*.fake"]}]}:{}),lsp:{fake:{command:[process.execPath,resolve("test/fixtures/fake-lsp.mjs")],extensions:[".fake"],env:{CODEX_LSP_TEST_LOG:spawns}}}}));
		const cli=revision==="before"?beforeBundle:afterBundle;
		const env={...process.env,CODEX_HOME:home,CODEX_LSP_CACHE:join(temporary,"cache"),NODE_OPTIONS:`--import=${monitor}`,BENCH_ROOT:target.root,BENCH_COUNTS:counts};
		const count=async()=>{await delay(60);const values=await Promise.all((await readdir(counts)).map(async name=>JSON.parse(await readFile(join(counts,name),"utf8"))));return values.reduce((a,b)=>a+b.reads,0)};
		const hook=input=>new Promise((resolve,reject)=>{const start=performance.now(),child=spawn(process.execPath,[cli,"hook"],{cwd:target.root,env,stdio:["pipe","pipe","pipe"]});let output="",error="";child.stdout.on("data",part=>output+=part);child.stderr.on("data",part=>error+=part);child.on("error",reject);child.on("exit",code=>code===0?resolve({ms:performance.now()-start,output:output?JSON.parse(output):{}}):reject(new Error(error)));child.stdin.end(JSON.stringify({cwd:target.root,session_id:"benchmark",turn_id:"turn",...input}));});
		const client=bundleClient(target.root,home,env,cli);
		let servicePid;
		try {
			await writeFile(join(target.root,"main.fake"),"clean");
			const start=performance.now();await hook({hook_event_name:"SessionStart"});const gate=await hook({hook_event_name:"PreToolUse",tool_name:"Write",tool_input:{path:"main.fake"}});assert.notEqual(gate.output.hookSpecificOutput?.permissionDecision,"deny",JSON.stringify(gate.output));
			servicePid=(await client.call("lsp_status",{path:"main.fake"})).structuredContent?.service?.pid;
			const baselineMs=performance.now()-start,post=[],empty=[],stop=[],emptyReads=[];
			for(let iteration=0;iteration<10;iteration++) {
				await writeFile(join(target.root,"main.fake"),`clean ${iteration}`);
				const update = await hook({hook_event_name:"PostToolUse",tool_name:"Write",tool_input:{path:"main.fake"}});
				assert(!/Pre-edit baseline missing|Change discovery incomplete/.test(JSON.stringify(update.output)),"benchmark has a reliable baseline");
				post.push(update.ms);
				const before=await count();empty.push((await hook({hook_event_name:"PostToolUse",tool_name:"exec_command",tool_input:{cmd:"git status --short"}})).ms);emptyReads.push((await count())-before);
				stop.push((await hook({hook_event_name:"Stop"})).ms);
			}
			const launches=(await readFile(spawns,"utf8").catch(()=>"")).trim().split("\n").filter(Boolean).length;
			if(revision==="after"){assert(emptyReads.every(count=>count===0),"empty shell reads no workspace bodies");assert.equal(launches,1,"hot LSP survives all batches");}
			const row={count:target.count,revision,baselineMs,postMs:summarize(post),emptyShellMs:summarize(empty),stopMs:summarize(stop),emptyContentReads:emptyReads,lspStarts:launches};report.hooks.push(row);console.log(JSON.stringify(row));
		}finally{if(servicePid) {try{process.kill(servicePid,"SIGTERM")}catch{}} await client.close();await delay(800);}
	}
	await writeFile("docs/history/performance-0.7.json",JSON.stringify(report,null,2)+"\n");
}finally{await delay(200);await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
