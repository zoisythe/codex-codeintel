import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configurationImpact } from "../src/config-files.js";
import { addedFindings, retainedFindings } from "../src/diagnostic-delta.js";
import { indexStatistics, inventory } from "../src/files.js";
import { lintBatch } from "../src/runners.js";
import { writeIntent } from "../src/write-intent.js";

const temps: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
it("classifies exact configuration basenames and separates formatting effects", () => {
	for (const path of [
		"src/config.ts",
		"clock.py",
		"blocklist.ts",
		"deadlock_test.rs",
		"manifesto.md",
		"pretty.toml.ts",
	])
		expect(configurationImpact(path)).toEqual([]);
	expect(configurationImpact("tsconfig.app.json")).toEqual(["types"]);
	expect(configurationImpact("eslint.config.mjs")).toEqual(["lint"]);
	expect(configurationImpact(".clang-format")).toEqual(["format"]);
});
it("compares duplicate diagnostic counts independently from line shifts and normalizes CLI/LSP rule ids", () => {
	const old = {
		path: "a.ts",
		line: 1,
		column: 4,
		severity: "error" as const,
		source: "ts/TS2322",
		message: "Wrong  type",
	};
	const moved = { ...old, line: 12, source: "typescript/2322", message: "Wrong type" };
	expect(addedFindings([old], [moved])).toEqual([]);
	expect(addedFindings([old], [moved, moved])).toEqual([moved]);
	expect(retainedFindings([old], [moved])).toEqual([moved]);
	expect(retainedFindings([old], [])).toEqual([]);
});
it("empty discovery reads zero bodies and same-size replacement is verified", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "codeintel-index-")));
	temps.push(root);
	await writeFile(join(root, "a.ts"), "one");
	const first = await inventory(root);
	const before = indexStatistics();
	expect((await inventory(root)).version).toBe(first.version);
	expect(indexStatistics().contentReads).toBe(before.contentReads);
	const stamp = await stat(join(root, "a.ts"));
	await writeFile(join(root, "a.ts"), "two");
	// Coarse filesystem timestamps can remain identical across fast writes. Make
	// the metadata change deterministic, then separately test forced content reads.
	await utimes(join(root, "a.ts"), stamp.atime, new Date(stamp.mtimeMs + 1000));
	const second = await inventory(root);
	expect(second.version).not.toBe(first.version);
	await writeFile(join(root, "a.ts"), "tri");
	const forced = indexStatistics();
	expect((await inventory(root, 10000, undefined, [], root, false, ["a.ts"])).version).not.toBe(second.version);
	expect(indexStatistics().contentReads).toBe(forced.contentReads + 1);
});
it("batch lint executes once and splits each output file correctly", async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "codeintel-lint-batch-")));
	temps.push(dir);
	const root = join(dir, "project"),
		home = join(dir, "home"),
		bin = join(root, "node_modules/@biomejs/biome/bin"),
		log = join(dir, "launches");
	await mkdir(bin, { recursive: true });
	await mkdir(home);
	vi.stubEnv("CODEX_HOME", home);
	await writeFile(join(home, "config.toml"), `[projects.${JSON.stringify(root)}]\ntrust_level="trusted"\n`);
	await writeFile(join(root, "biome.json"), "{}");
	await writeFile(
		join(bin, "biome"),
		`require("node:fs").appendFileSync(${JSON.stringify(log)},"run\\n"); console.log(JSON.stringify({diagnostics:process.argv.slice(5).map(path=>({severity:"error",description:path,category:"test",location:{path:{file:path}}}))}));`,
	);
	await writeFile(join(root, "a.ts"), "a");
	await writeFile(join(root, "b.ts"), "b");
	const results = await lintBatch(root, ["a.ts", "b.ts"], new AbortController().signal);
	expect(await readFile(log, "utf8")).toBe("run\n");
	expect(results.get("a.ts")?.findings[0]?.path).toBe("a.ts");
	expect(results.get("b.ts")?.findings[0]?.path).toBe("b.ts");
});
it("shell reads are fast, substitutions and unknown writes require all-project coverage", () => {
	expect(writeIntent("/workspace", { tool_name: "Bash", tool_input: { cmd: "git status --short" } })).toEqual({
		kind: "read",
	});
	expect(writeIntent("/workspace", { tool_name: "Bash", tool_input: { cmd: "cat $(touch a.ts)" } })).toEqual({
		kind: "write",
	});
	expect(writeIntent("/workspace", { tool_name: "apply_patch", tool_input: { path: "tsconfig.json" } }).kind).toBe(
		"configuration",
	);
	expect(writeIntent("/workspace", { tool_name: "Write", tool_input: { path: "config.ts" } }).kind).toBe("write");
});
