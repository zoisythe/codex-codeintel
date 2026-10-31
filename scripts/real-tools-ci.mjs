import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const llvm = resolve(".cache/ci-llvm-23.1.4");
const output = resolve(process.env.CODEX_LSP_ARTIFACTS ?? "test-results/real-tools");
await mkdir(output, { recursive: true });
const versions = [
	[process.execPath, ["--version"], "v26.13.0"],
	["uv", ["--version"], "uv 0.13.6"],
	["go", ["version"], "go1.27.3"],
	["gopls", ["version"], "v0.24.0"],
	["ruff", ["--version"], "ruff 0.17.3"],
	["ty", ["--version"], "ty 0.0.95"],
	["clangd", ["--version"], "clangd version 23.1.4"],
];
if (process.argv[2] === "prepare") {
	assert(process.env.GITHUB_PATH, "prepare is a CI-only installer");
	assert(["win32", "linux"].includes(process.platform) && process.arch === "x64");
	const binary = join(llvm, "bin", process.platform === "win32" ? "clangd.exe" : "clangd");
	if (!(await stat(binary).catch(() => undefined))?.isFile()) {
		const asset = process.platform === "win32" ? "clang+llvm-23.1.4-x86_64-pc-windows-msvc.tar.xz" : "LLVM-23.1.4-Linux-X64.tar.xz";
		const digest = process.platform === "win32" ? "854bffcfc84528e0ee92490ff5c178920abd358a79c3e98f053e41e3e8e4c6d2" : "25d814fda50d5fb0084b42be09605d8b1595d49d5e2e03a3345d7e112ff6f9f3";
		const archive = resolve(".cache", asset);
		await mkdir(dirname(archive), { recursive: true });
		const url = `https://github.com/llvm/llvm-project/releases/download/llvmorg-23.1.4/${encodeURIComponent(asset)}`;
		await writeFile(join(output, "llvm-source.json"), `${JSON.stringify({ asset, sha256: digest, url }, null, 2)}\n`);
		const response = await fetch(url, { signal: AbortSignal.timeout(600000) });
		assert(response.ok && response.body, `LLVM download failed: ${response.status}`);
		await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(archive)) hash.update(chunk);
		assert.equal(hash.digest("hex"), digest, "LLVM archive integrity");
		await mkdir(llvm, { recursive: true });
		const members = execFileSync("tar", ["-tf", archive], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).split(/\r?\n/).filter((name) => /\/bin\/clangd(?:\.exe)?$|\/bin\/[^/]+\.dll$|\/lib\/(?:libLLVM|libclang|libc\+\+|libunwind)[^/]*\.so[^/]*$/.test(name));
		assert(members.some((name) => /\/bin\/clangd(?:\.exe)?$/.test(name)), "clangd missing from LLVM archive");
		execFileSync("tar", ["-xf", archive, "-C", llvm, "--strip-components=1", ...members], { stdio: "inherit", timeout: 300000 });
		await unlink(archive);
	}
	await appendFile(process.env.GITHUB_PATH, `${join(llvm, "bin")}\n`);
	await appendFile(process.env.GITHUB_PATH, `${execFileSync("uv", ["tool", "dir", "--bin"], { encoding: "utf8" }).trim()}\n`);
	await appendFile(process.env.GITHUB_PATH, `${join(execFileSync("go", ["env", "GOPATH"], { encoding: "utf8" }).trim(), "bin")}\n`);
} else if (process.argv[2] === "test") {
	assert.equal(process.env.CODEX_LSP_REAL_TOOLS, "1", "Real tools must be explicitly enabled");
	const recorded = [];
	for (const [command, args, expected] of versions) {
		const text = execFileSync(command, args, { encoding: "utf8", windowsHide: true }).trim();
		recorded.push(text);
		await writeFile(join(output, "versions.txt"), `${recorded.join("\n")}\n`);
		assert(text.includes(expected), `${command}: expected ${expected}; got ${text}`);
	}
	const junit = join(output, "features.xml");
	const features = spawnSync(process.execPath, ["--test", "--test-reporter=junit", `--test-reporter-destination=${junit}`, "test/features-e2e.test.mjs"], { stdio: "inherit", windowsHide: true });
	assert.equal(features.status, 0, "Real feature tests failed");
	const report = await readFile(junit, "utf8");
	assert(!/<skipped\b/.test(report) && /<testcase\b/.test(report), "Real feature tests were skipped or absent");
	const validation = join(output, "validation.json");
	const checks = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "test/plan-validation.test.ts", "test/plan-validation-real.test.ts", "--reporter=json", `--outputFile=${validation}`], { stdio: "inherit", windowsHide: true });
	assert.equal(checks.status, 0, "Plan validation acceptance failed");
	const result = JSON.parse(await readFile(validation, "utf8"));
	assert.equal(result.numPendingTests, 0, "Plan validation acceptance skipped tests");
	assert(result.numPassedTests > 0);
} else throw new Error("Usage: node scripts/real-tools-ci.mjs prepare|test");
