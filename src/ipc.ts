import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { alive, directoryLock } from "./directory-lock.js";

export { alive } from "./directory-lock.js";

import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ToolOutput } from "./engine.js";
import { executionEnvironment } from "./environment.js";
import { hash } from "./files.js";
import { record, WriteFailure } from "./results.js";
import { SERVICE_PROTOCOL, workspaceIdentity } from "./service-identity.js";

export interface Endpoint {
	pid: number;
	token: string;
	identity: string;
	protocol: number;
	address: string;
}
export interface ServiceLocation {
	directory: string;
	endpoint: string;
	address: string;
	identity: string;
}
export async function serviceLocation(root: string): Promise<ServiceLocation> {
	const user = process.getuid?.() ?? hash(homedir()).slice(0, 10);
	const directory = join(tmpdir(), `clsp6-${user}`);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await lstat(directory);
	if (
		info.isSymbolicLink() ||
		(process.platform !== "win32" && (info.uid !== process.getuid?.() || info.mode & 0o077))
	)
		throw new Error("Unsafe service directory permissions");
	const identity = await workspaceIdentity(root);
	const address =
		process.platform === "win32"
			? `\\\\.\\pipe\\codex-lsp-${user}-${identity}`
			: join(directory, `${identity.slice(0, 32)}.sock`);
	return { directory, identity, address, endpoint: join(directory, `${identity}.endpoint`) };
}
export async function readEndpoint(location: ServiceLocation): Promise<Endpoint | undefined> {
	try {
		const info = await lstat(location.endpoint);
		if (
			info.isSymbolicLink() ||
			(process.platform !== "win32" && (info.uid !== process.getuid?.() || info.mode & 0o077))
		)
			throw new Error("Unsafe service endpoint permissions");
		const value: unknown = JSON.parse(await readFile(location.endpoint, "utf8"));
		if (
			!record(value) ||
			value["identity"] !== location.identity ||
			value["protocol"] !== SERVICE_PROTOCOL ||
			typeof value["pid"] !== "number" ||
			typeof value["token"] !== "string" ||
			value["address"] !== location.address
		)
			throw new Error("Invalid service endpoint");
		return value as unknown as Endpoint;
	} catch (error) {
		if (record(error) && error["code"] === "ENOENT") return undefined;
		throw error;
	}
}
export async function exchange(
	endpoint: Endpoint,
	operation: string,
	args: Record<string, unknown>,
	signal: AbortSignal,
): Promise<ToolOutput> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const socket = createConnection(endpoint.address);
		let received = "";
		let settled = false;
		const writes = operation === "lsp_rename" || operation === "lsp_format";
		const finish = (error?: Error, output?: ToolOutput) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", cancel);
			socket.destroy();
			if (error) reject(error);
			else if (output) resolve(output);
			else reject(new Error("Missing service output"));
		};
		const cancel = () => {
			// A write must return the actual completed paths before cancellation resolves.
			if (writes) socket.write(`${JSON.stringify({ cancel: true })}\n`);
			else finish(new Error("Request cancelled while waiting for service; automatic work remains pending"));
		};
		signal.addEventListener("abort", cancel, { once: true });
		socket.once("connect", () => {
			socket.write(
				`${JSON.stringify({
					token: endpoint.token,
					identity: endpoint.identity,
					protocol: SERVICE_PROTOCOL,
					operation,
					args,
					environment: executionEnvironment(),
				})}\n`,
			);
			if (signal.aborted) cancel();
		});
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			received += chunk;
			if (received.length > 8 * 1024 * 1024) {
				finish(new Error("Service response exceeds limit"));
				return;
			}
			const end = received.indexOf("\n");
			if (end < 0) return;
			try {
				const response: unknown = JSON.parse(received.slice(0, end));
				if (!record(response)) throw new Error("Invalid service response");
				if (typeof response["error"] === "string") {
					const paths = response["modifiedPaths"];
					finish(
						Array.isArray(paths)
							? new WriteFailure(
									response["error"],
									paths.filter((path): path is string => typeof path === "string"),
								)
							: new Error(response["error"]),
					);
				} else if (record(response["output"]) && typeof response["output"]["operation"] === "string")
					finish(undefined, response["output"] as ToolOutput);
				else throw new Error("Invalid structured service response");
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
		socket.once("error", (error) => finish(error));
		socket.once("close", () =>
			finish(
				new Error(
					writes
						? "Service connection lost; write outcome unknown; do not replay"
						: "Service connection lost; retry read request",
				),
			),
		);
	});
}
export async function existingService(root: string, signal: AbortSignal): Promise<Endpoint | undefined> {
	const location = await serviceLocation(root);
	const endpoint = await readEndpoint(location);
	if (!endpoint || !alive(endpoint.pid)) return undefined;
	const handshake: unknown = await exchange(
		endpoint,
		"handshake",
		{},
		AbortSignal.any([signal, AbortSignal.timeout(750)]),
	);
	if (
		!record(handshake) ||
		handshake["protocol"] !== SERVICE_PROTOCOL ||
		handshake["identity"] !== location.identity ||
		handshake["pid"] !== endpoint.pid
	)
		throw new Error("Service handshake identity mismatch");
	return endpoint;
}
export async function ensureService(root: string, signal: AbortSignal): Promise<Endpoint> {
	const location = await serviceLocation(root);
	const lock = `${location.endpoint}.lock`;
	const release = await directoryLock(lock, signal, 8000);
	try {
		const connected = await existingService(root, signal);
		if (connected) return connected;
		const previous = await readEndpoint(location);
		if (previous && alive(previous.pid))
			throw new Error("Service process alive but handshake unavailable; retry later");
		await rm(location.endpoint, { force: true });
		if (process.platform !== "win32") await rm(location.address, { force: true });
		const token = randomUUID();
		const cli = fileURLToPath(import.meta.url);
		const child = spawn(process.execPath, [...process.execArgv, cli, "service", root, location.identity, token], {
			cwd: root,
			env: executionEnvironment(),
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		let startupError: Error | undefined;
		child.once("error", (error) => {
			startupError = error;
		});
		child.unref();
		// Keep the published startup owner alive after a short Hook disconnects.
		const startup = AbortSignal.timeout(8000);
		while (!startup.aborted) {
			if (startupError) throw startupError;
			const endpoint = await readEndpoint(location);
			if (endpoint) {
				await exchange(endpoint, "handshake", {}, startup);
				return endpoint;
			}
			if (child.exitCode !== null) throw new Error("Shared service failed to start");
			await delay(25);
		}
		throw new Error("Shared service startup timeout");
	} finally {
		await release();
	}
}
export async function publishEndpoint(location: ServiceLocation, token: string): Promise<void> {
	if (process.platform !== "win32") await chmod(location.address, 0o600);
	const temporary = `${location.endpoint}.${randomUUID()}`;
	await writeFile(
		temporary,
		JSON.stringify({
			pid: process.pid,
			token,
			identity: location.identity,
			protocol: SERVICE_PROTOCOL,
			address: location.address,
		}),
		{ mode: 0o600 },
	);
	await rename(temporary, location.endpoint);
}
