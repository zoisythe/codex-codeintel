import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { Automatic } from "./automatic.js";
import { configuration } from "./config.js";
import { Engine } from "./engine.js";
import { withExecution } from "./environment.js";
import { publishEndpoint, readEndpoint, serviceLocation } from "./ipc.js";
import { message, record, text, WriteFailure } from "./results.js";
import { SERVICE_PROTOCOL } from "./service-identity.js";

export async function runService(root: string, identity: string, token: string): Promise<void> {
	const location = await serviceLocation(root);
	if (location.identity !== identity || !token) throw new Error("Invalid service startup identity");
	const engine = new Engine(root);
	const automatic = new Automatic(root, engine);
	const sockets = new Set<Socket>();
	let lastActivity = Date.now();
	let requests = 0;
	let stopping = false;
	const server = createServer((socket) => {
		sockets.add(socket);
		const controller = new AbortController();
		let input = "";
		let started = false;
		let authenticated = false;
		socket.setEncoding("utf8");
		socket.setTimeout(5000, () => {
			if (!authenticated) socket.destroy();
		});
		socket.on("error", () => socket.destroy());
		socket.once("close", () => {
			sockets.delete(socket);
			controller.abort();
		});
		const handle = async (value: unknown): Promise<void> => {
			if (started) {
				if (authenticated && record(value) && value["cancel"] === true) controller.abort();
				return;
			}
			started = true;
			if (
				!record(value) ||
				value["token"] !== token ||
				value["identity"] !== identity ||
				value["protocol"] !== SERVICE_PROTOCOL ||
				!record(value["args"]) ||
				!record(value["environment"]) ||
				!Object.values(value["environment"]).every((entry) => typeof entry === "string")
			) {
				socket.destroy();
				return;
			}
			authenticated = true;
			requests++;
			lastActivity = Date.now();
			const operation = text(value["operation"]);
			const args = value["args"];
			const environment = value["environment"] as NodeJS.ProcessEnv;
			try {
				const output = await withExecution(environment, operation === "automatic", async () => {
					if (operation === "handshake")
						return JSON.stringify({ protocol: SERVICE_PROTOCOL, identity, pid: process.pid });
					if (operation === "session_end") {
						automatic.cancel(text(args["session"]));
						return "";
					}
					if (operation === "automatic") return automatic.request(args, environment, controller.signal);
					if (
						!["lsp_status", "check_diagnostics", "lsp_navigation", "lsp_rename", "lsp_format"].includes(operation)
					)
						throw new Error("Unknown service operation");
					const config = await configuration(root);
					if (!config.trusted) automatic.cancel();
					const output = await engine.dispatch(operation, args, controller.signal);
					if (operation === "lsp_status")
						return JSON.stringify({
							...JSON.parse(output),
							service: { state: "running", pid: process.pid, identity, protocol: SERVICE_PROTOCOL },
							automaticDiagnostics: config.automaticDiagnostics,
							automaticTasks: automatic.status(),
						});
					return output;
				});
				if (!socket.destroyed) socket.end(`${JSON.stringify({ output })}\n`);
			} catch (error) {
				if (!socket.destroyed)
					socket.end(
						`${JSON.stringify({ error: message(error), ...(error instanceof WriteFailure ? { modifiedPaths: error.modifiedPaths } : {}) })}\n`,
					);
			} finally {
				requests--;
				lastActivity = Date.now();
			}
		};
		socket.on("data", (chunk: string) => {
			input += chunk;
			if (Buffer.byteLength(input) > 1024 * 1024) {
				socket.destroy();
				return;
			}
			let end = input.indexOf("\n");
			while (end >= 0) {
				const line = input.slice(0, end);
				input = input.slice(end + 1);
				try {
					void handle(JSON.parse(line));
				} catch {
					socket.destroy();
				}
				end = input.indexOf("\n");
			}
		});
	});
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		clearInterval(idle);
		server.close();
		for (const socket of sockets) socket.destroy();
		await automatic.dispose();
		await engine.dispose();
		if ((await readEndpoint(location).catch(() => undefined))?.token === token)
			await rm(location.endpoint, { force: true });
	};
	const idle = setInterval(() => {
		void automatic.revalidate();
		if (requests || automatic.active) lastActivity = Date.now();
		else if (Date.now() - lastActivity >= 120000) void stop();
	}, 1000);
	process.once("SIGTERM", () => {
		void stop();
	});
	process.once("SIGINT", () => {
		void stop();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(location.address, resolve);
	});
	await publishEndpoint(location, token);
}
