import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
const diagnostics = [];
for (const path of await readdir(process.cwd())) {
	if (!path.endsWith(".fake")) continue;
	const content = await readFile(join(process.cwd(), path), "utf8");
	for (const [line,text] of content.split("\n").entries()) if (text.includes("broken")) diagnostics.push({path, line: line + 1, column: 1, severity: "error", source: "fake", message: "pull broken"});
}
if (process.env.CHECK_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.CHECK_DELAY)));
if (process.env.CHECK_FAIL) { console.error("checker unavailable"); process.exit(2); }
console.log(JSON.stringify({diagnostics}));
process.exitCode = diagnostics.length ? 1 : 0;
