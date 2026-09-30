import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleClient } from "../test/bundle-client.mjs";

await mkdir(resolve("docs/history"), { recursive: true });
const dir = await mkdtemp(join(tmpdir(), "codex-bench-"));
try {
	const baseline = join(dir, "baseline.mjs");
	const baselineRef = process.env.BASELINE_REF ?? "94ba395";
	const previous = spawnSync("git", ["show", `${baselineRef}:dist/cli.js`], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
	if (previous.status !== 0) throw new Error(previous.stderr);
	await writeFile(baseline, previous.stdout);
	const preload = join(dir, "count.mjs");
	await writeFile(preload, 'import fs from "node:fs/promises";import {syncBuiltinESMExports} from "node:module";const original=fs.readFile;let reads=0;fs.readFile=async(...args)=>{if(String(args[0]).includes("/data/"))reads++;return original(...args)};syncBuiltinESMExports();process.on("message",()=>{process.send(reads);reads=0;});');
	const report = { platform: process.platform, node: process.version, iterations: 10, baselineRef, afterBundleSHA256: createHash("sha256").update(await readFile(resolve("dist/cli.js"))).digest("hex"), measurements: [] };
	for (const count of [1000, 10000]) {
		const root = join(dir, `project-${count}`), home = join(dir, `home-${count}`);
		await mkdir(join(root, "data"), { recursive: true }); await mkdir(home);
		for (let i = 0; i < count - 1; i += 100) await Promise.all(Array.from({ length: Math.min(100, count - 1 - i) }, (_, j) => writeFile(join(root, "data", `${i + j}.txt`), "dependency\n")));
		await writeFile(join(root, "a.fake"), "broken\n");
		await writeFile(join(home, "config.toml"), `[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`);
		for (const revision of ["before", "after"]) {
			const config = { trustedWorkspaces: [root], lsp: { fake: { command: [process.execPath, resolve("test/fixtures/fake-lsp.mjs")], extensions: [".fake"] } } };
			if (revision === "after") config.schemaVersion = 1;
			await writeFile(join(home, "lsp-client.json"), JSON.stringify(config));
			const client = bundleClient(root, home, { CODEX_LSP_CACHE: join(dir, "cache") }, revision === "before" ? baseline : resolve("dist/cli.js"), ["--import", pathToFileURL(preload).href]);
			const counts = async () => { const value = once(client.child, "message"); client.child.send("counts"); return (await value)[0]; };
			try {
				const active = revision === "before" ? { mode: "full", path: "a.fake", session: "bench" } : { path: "a.fake", session: "bench", source: "lsp" };
				await client.call("check_diagnostics", active); await counts();
				for (const run of ["active", "cached"]) {
					const ms = [], scans = [];
					for (let i = 0; i < 10; i++) {
						if (run === "active") await writeFile(join(root, "a.fake"), `broken ${i}\n`);
						const start = performance.now();
						const response = await client.call("check_diagnostics", run === "active" ? active : revision === "before" ? { mode: "all", session: "bench" } : { path: "a.fake", session: "bench", source: "lsp", run: "cached" });
						if (response.isError) throw new Error(JSON.stringify(response));
						ms.push(performance.now() - start); scans.push((await counts()) / (count - 1));
					}
					ms.sort((a, b) => a - b);
					report.measurements.push({ count, revision, run, medianMs: (ms[4] + ms[5]) / 2, p95Ms: ms[9], scans });
					console.log(JSON.stringify(report.measurements.at(-1)));
				}
			} finally { await client.close(); }
		}
	}
	await writeFile(resolve("docs/history/performance-0.5.json"), JSON.stringify(report, null, 2) + "\n");
} finally { await rm(dir, { recursive: true, force: true }); }
