import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { record } from "./results.js";

// Executable discovery metadata only; never diagnostic state or a shared process.
function directory(): string {
	return join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "cache", "codex-lsp-v5", "tools");
}
export async function preparedRuff(): Promise<string | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(join(directory(), "ruff.json"), "utf8"));
		if (!record(value) || typeof value["executable"] !== "string" || !isAbsolute(value["executable"]))
			return undefined;
		await access(value["executable"], constants.X_OK);
		return value["executable"];
	} catch {
		return undefined;
	}
}
export async function rememberRuff(executable: string): Promise<void> {
	if (!isAbsolute(executable)) throw new Error("Invalid prepared Ruff path");
	await access(executable, constants.X_OK);
	const dir = directory();
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const info = await lstat(dir);
	if (
		info.isSymbolicLink() ||
		(process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
	)
		throw new Error("Unsafe prepared-tool directory");
	const temporary = join(dir, `${randomUUID()}.tmp`);
	await writeFile(temporary, JSON.stringify({ executable }), { mode: 0o600 });
	await rename(temporary, join(dir, "ruff.json"));
}
