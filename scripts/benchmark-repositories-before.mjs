// Observe the review base's default full Stop on the same repository/tool snapshots.
// Requires the clones prepared for benchmark-review.mjs. Full jobs can remain pending.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { bundleClient } from "../test/bundle-client.mjs";

await mkdir(resolve("docs/history"), { recursive: true });
const dir = await mkdtemp(join(tmpdir(), "codeintel-repo-before-"));
const base = "d49812d", cli = join(dir, "before.mjs");
const originalBundle = spawnSync("git", ["show", `${base}:dist/cli.js`], { maxBuffer: 16 * 1024 * 1024 });
assert.equal(originalBundle.status, 0);
await writeFile(cli, originalBundle.stdout);
const summarize = values => {
	const sorted = [...values].sort((a, b) => a - b);
	return { p50: sorted[Math.floor((sorted.length - 1) * .5)], p95: sorted.at(-1), samples: values };
};
const monitor = join(dir, "monitor.mjs");
await writeFile(monitor, `import fs from 'node:fs/promises';import {writeFileSync} from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';let reads=0,bytes=0,starts=0;const read=fs.readFile,spawn=cp.spawn;fs.readFile=async(...args)=>{const value=await read(...args);if(String(args[0]).startsWith(process.env.BENCH_ROOT+'/')){reads++;bytes+=Buffer.byteLength(value)}return value};cp.spawn=(command,args,...rest)=>{if(['ty','rust-analyzer','typescript-language-server'].includes(String(command).split('/').at(-1))||args?.includes('--lsp'))starts++;return spawn(command,args,...rest)};syncBuiltinESMExports();const save=()=>{try{writeFileSync(process.env.BENCH_COUNTS+'/'+process.pid+'.json',JSON.stringify({reads,bytes,starts}))}catch{}};setInterval(save,50).unref();process.on('exit',save);`);
const report = { base, beforeSHA256: createHash("sha256").update(originalBundle.stdout).digest("hex"), node: process.version, platform: process.platform, iterations: 3, environment: { RAYON_NUM_THREADS: "4", CARGO_BUILD_JOBS: "2" }, semantics: "0.6 defaults: post delta selects files; Stop full scans the workspace. Latencies measure Hook return, not project job completion. No project CLI baseline existed.", repositories: [] };
const tsc = resolve("node_modules/typescript/bin/tsc");
function forceCleanup(pid) {
	const listing = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", env: process.env });
	const entries = listing.stdout.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
	const descendants = parent => entries.filter(([, ppid]) => ppid === parent).flatMap(([child]) => [...descendants(child), child]);
	for (const child of [...descendants(pid), pid]) try { process.kill(child, "SIGKILL"); } catch {}
}
for (const target of [{ name: "vite", root: "/tmp/codeintel-bench-vite", path: "packages/vite/src/node/index.ts", lsp: { typescript: { command: [process.execPath, tsc, "--lsp", "--stdio"], extensions: [".ts", ".tsx"] } } }, { name: "django", root: "/tmp/codeintel-bench-django", path: "django/__init__.py", lsp: { python: "ty" } }, { name: "clap", root: "/tmp/codeintel-bench-clap", path: "src/lib.rs", lsp: { rust: "rust" } }]) {
	const home = join(dir, target.name), counts = join(home, "counts");
	await mkdir(counts, { recursive: true });
	const path = join(target.root, target.path), original = await readFile(path, "utf8");
	await writeFile(join(home, "config.toml"), `[projects.${JSON.stringify(target.root)}]\ntrust_level="trusted"\n`);
	await writeFile(join(home, "lsp-client.json"), JSON.stringify({ schemaVersion: 1, exclude: target.name === "vite" ? ["docs/images/ecosystem-vite4.webp", "docs/public/og-image-announcing-vite4.webp", "docs/public/og-image-announcing-vite5.webp"] : [], lsp: target.lsp, lint: { javascript: "off", python: "off" } }));
	const env = { ...process.env, CODEX_HOME: home, CODEX_LSP_CACHE: join(dir, "cache"), NODE_OPTIONS: `--import=${monitor}`, BENCH_ROOT: target.root, BENCH_COUNTS: counts, RUSTUP_AUTO_INSTALL: "0", RUSTUP_TOOLCHAIN: "stable", RAYON_NUM_THREADS: "4", CARGO_BUILD_JOBS: "2" };
	const count = async () => {
		await delay(70);
		const values = await Promise.all((await readdir(counts)).map(async name => JSON.parse(await readFile(join(counts, name), "utf8"))));
		return values.reduce((sum, value) => ({ reads: sum.reads + value.reads, bytes: sum.bytes + value.bytes, starts: sum.starts + value.starts }), { reads: 0, bytes: 0, starts: 0 });
	};
	const hook = input => new Promise((resolve, reject) => {
		const start = performance.now(), child = spawn(process.execPath, [cli, "hook"], { cwd: target.root, env, stdio: ["pipe", "pipe", "pipe"] });
		let output = "", error = "";
		child.stdout.on("data", part => output += part); child.stderr.on("data", part => error += part);
		child.on("error", reject); child.on("exit", code => code === 0 ? resolve({ ms: performance.now() - start, output: output ? JSON.parse(output) : {} }) : reject(new Error(error)));
		child.stdin.end(JSON.stringify({ cwd: target.root, session_id: "before-repository-benchmark", turn_id: "turn", ...input }));
	});
	const client = bundleClient(target.root, home, env, cli);
	let pid;
	try {
		const start = performance.now(); await hook({ hook_event_name: "SessionStart" }); await hook({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { path: target.path } });
		const snapshotInitializationMs = performance.now() - start;
		pid = (await client.call("lsp_status", { path: target.path })).structuredContent.service.pid;
		const post = [], stop = [], empty = [], reads = [], stopOutputs = [];
		for (let i = 0; i < 3; i++) {
			await writeFile(path, original + (target.name === "django" ? `\n# codeintel benchmark ${i}\n` : `\n// codeintel benchmark ${i}\n`));
			post.push((await hook({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { path: target.path } })).ms);
			const first = await count(); empty.push((await hook({ hook_event_name: "PostToolUse", tool_name: "exec_command", tool_input: { cmd: "git status --short" } })).ms); reads.push((await count()).reads - first.reads);
			const result = await hook({ hook_event_name: "Stop" }); stop.push(result.ms); stopOutputs.push(result.output);
		}
		const result = { ...target, lsp: undefined, commit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: target.root, encoding: "utf8" }).stdout.trim(), snapshotInitializationMs, projectBaseline: "not available in review base", postMs: summarize(post), emptyShellMs: summarize(empty), stopMs: summarize(stop), emptyContentReads: reads, totalInstrumentation: await count(), stopOutputs };
		report.repositories.push(result); console.log(JSON.stringify(result));
	} finally {
		await writeFile(path, original);
		if (pid) try { process.kill(pid, "SIGTERM"); } catch {}
		await client.close(); await delay(1000);
		if (pid) forceCleanup(pid); // The old full job may still be winding down after the Hook returns.
	}
}
await writeFile("docs/history/performance-0.7-repositories-before.json", JSON.stringify(report, null, 2) + "\n");
