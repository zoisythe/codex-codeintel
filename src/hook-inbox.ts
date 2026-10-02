import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executionEnvironment } from "./environment.js";
import { serviceLocation } from "./ipc.js";
import { Metadata } from "./metadata.js";
import { record, text } from "./results.js";
import { SERVICE_PROTOCOL } from "./service-identity.js";

export interface RegisteredHook {
	path: string;
	epoch: string;
	input: Record<string, unknown>;
	environment: NodeJS.ProcessEnv;
}

export async function registerHook(root: string, input: Record<string, unknown>, signal: AbortSignal): Promise<void> {
	const location = await serviceLocation(root);
	const session = text(input["session_id"]);
	// Persist the epoch before handing work to another process.
	const state = await new Metadata(root).update(session, signal, () => undefined);
	const path = join(location.directory, `${location.identity}.${Date.now()}.${randomUUID()}.hook`);
	await writeFile(
		path,
		JSON.stringify({
			protocol: SERVICE_PROTOCOL,
			identity: location.identity,
			epoch: state.epoch,
			input,
			environment: executionEnvironment(),
		}),
		{ mode: 0o600, flag: "wx", signal },
	);
}

export async function registeredHooks(root: string): Promise<RegisteredHook[]> {
	const location = await serviceLocation(root);
	const result: RegisteredHook[] = [];
	for (const name of (await readdir(location.directory)).sort()) {
		if (!name.startsWith(`${location.identity}.`) || !name.endsWith(".hook")) continue;
		const path = join(location.directory, name);
		try {
			const info = await lstat(path);
			if (
				info.isSymbolicLink() ||
				info.size > 1024 * 1024 ||
				(process.platform !== "win32" && (info.uid !== process.getuid?.() || info.mode & 0o077))
			)
				throw new Error("Unsafe hook registration");
			const value: unknown = JSON.parse(await readFile(path, "utf8"));
			if (
				!record(value) ||
				value["identity"] !== location.identity ||
				value["protocol"] !== SERVICE_PROTOCOL ||
				typeof value["epoch"] !== "string" ||
				!record(value["input"]) ||
				!record(value["environment"]) ||
				!Object.values(value["environment"]).every((entry) => typeof entry === "string")
			)
				throw new Error("Invalid hook registration");
			result.push({
				path,
				epoch: value["epoch"],
				input: value["input"],
				environment: value["environment"] as NodeJS.ProcessEnv,
			});
		} catch {
			await rm(path, { force: true });
		}
	}
	return result;
}
