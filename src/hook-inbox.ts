import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUDGET } from "./budgets.js";
import { configuration } from "./config.js";
import { executionEnvironment } from "./environment.js";
import { hash, inventory } from "./files.js";
import { hookSession } from "./hook-events.js";
import { serviceLocation } from "./ipc.js";
import { Metadata } from "./metadata.js";
import { record, text } from "./results.js";
import { SERVICE_PROTOCOL } from "./service-identity.js";

export interface RegisteredHook {
	path: string;
	id: string;
	created: number;
	session: string;
	epoch: string;
	input: Record<string, unknown>;
	environment: NodeJS.ProcessEnv;
}

export async function registerHook(
	root: string,
	input: Record<string, unknown>,
	signal: AbortSignal,
): Promise<{ id: string; session: string } | undefined> {
	const location = await serviceLocation(root);
	const parent = text(input["session_id"]);
	const session = hookSession(input);
	const store = new Metadata(root);
	const event = text(input["hook_event_name"]);
	if (event === "SessionStart") {
		const previous = await store.read(parent);
		if (input["source"] !== "resume" || previous.turn === "__ended__" || !previous.baselineAttempted)
			await store.start(parent, signal);
		if (input["source"] === "resume" && (previous.turn === "__ended__" || !previous.baselineAttempted))
			await store.update(parent, signal, (current) => {
				current.baselineAttempted = true;
				current.edited = true;
			});
	}
	let state = await store.update(parent, signal, () => undefined);
	if (state.turn === "__ended__") return;
	if (event === "SessionStart" && !state.baselineAttempted) {
		// Capture the pre-edit image in the thin entry, never in a late background registration.
		let reference: string | null = null;
		try {
			const config = await configuration(root);
			const snapshot = await inventory(
				root,
				BUDGET.files,
				AbortSignal.any([signal, AbortSignal.timeout(200)]),
				config.exclude,
			);
			if (snapshot.complete) reference = await store.shared(Object.fromEntries(snapshot.files));
		} catch {
			/* A missing pre-edit image remains unattributed. */
		}
		state = await store.update(parent, signal, (current) => {
			if (current.epoch !== state.epoch) return false;
			current.baselineAttempted = true;
			current.baseline ??= reference;
			if (!reference) current.edited = true;
			return true;
		});
	}
	if (event === "PostToolUse")
		await store.update(parent, signal, (current) => {
			if (current.epoch !== state.epoch) return false;
			current.edited = true; // No checker first started after a write may claim a pre-edit baseline.
			return true;
		});
	await store.actor(session, signal);
	const call = text(input["tool_use_id"]);
	const id = hash(
		JSON.stringify([state.epoch, session, event, event === "PostToolUse" && call ? call : randomUUID()]),
	);
	let terminal = false;
	await store.update(session, signal, (current) => {
		if (current.epoch !== state.epoch || current.turn === "__ended__") {
			terminal = true;
			return false;
		}
		const previous = current.hookEvents[id];
		if (previous) {
			terminal = previous.state !== "queued" && previous.state !== "running";
			return false;
		}
		current.hookEvents[id] = { turn: text(input["turn_id"]), state: "queued" };
		return true;
	});
	if (terminal) return { id, session };
	const path = join(location.directory, `${location.identity}.${id}.hook`);
	await writeFile(
		path,
		JSON.stringify({
			protocol: SERVICE_PROTOCOL,
			identity: location.identity,
			id,
			created: Date.now(),
			session,
			epoch: state.epoch,
			input,
			environment: executionEnvironment(),
		}),
		{ mode: 0o600, flag: "wx", signal },
	).catch((error: unknown) => {
		if (!record(error) || error["code"] !== "EEXIST") throw error;
	});
	return { id, session };
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
				typeof value["id"] !== "string" ||
				typeof value["created"] !== "number" ||
				typeof value["session"] !== "string" ||
				!record(value["input"]) ||
				!record(value["environment"]) ||
				!Object.values(value["environment"]).every((entry) => typeof entry === "string")
			)
				throw new Error("Invalid hook registration");
			result.push({
				path,
				id: value["id"],
				created: value["created"],
				session: value["session"],
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
