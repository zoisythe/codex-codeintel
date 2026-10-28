import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const fixture = resolve(import.meta.dirname, "../test/fixtures/legacy-typescript");
const installed = JSON.parse(await readFile(join(fixture, "node_modules/typescript/package.json"), "utf8").catch(() => "null"));
if (installed?.version !== "5.9.3") {
	const npm = process.env.npm_execpath;
	if (!npm) throw new Error("Run npm run test:features to prepare the isolated legacy TypeScript fixture");
	execFileSync(process.execPath, [npm, "ci", "--prefix", fixture, "--ignore-scripts", "--no-audit", "--no-fund"], { stdio: "inherit", windowsHide: true });
}
