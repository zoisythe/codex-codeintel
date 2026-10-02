import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { Automatic } from "./automatic.js";
import { BUDGET } from "./budgets.js";
import { configuration } from "./config.js";
import { directoryLock } from "./directory-lock.js";
import { Engine } from "./engine.js";
import { executionEnvironment, withExecution } from "./environment.js";
import { HookCoordinator } from "./hook-coordinator.js";
import { acknowledgeDelivery } from "./hook-delivery.js";
import { HookEngine } from "./hook-engine.js";
import { alive, existingService, publishEndpoint, readEndpoint, serviceLocation } from "./ipc.js";
import { ProjectChecks } from "./project-checks.js";
import { message, record, text, WriteFailure } from "./results.js";
import { SERVICE_PROTOCOL } from "./service-identity.js";

export async function runService(root: string, identity: string, token: string): Promise<void> {
	const location = await serviceLocation(root);
	if (location.identity !== identity || !token) throw new Error("Invalid service startup identity");
	const startup = AbortSignal.timeout(8000);
	const release = await directoryLock(`${location.endpoint}.lock`, startup, 8000);
	try {
		if (await existingService(root, startup)) return;
		const previous = await readEndpoint(location);
		if (previous && alive(previous.pid)) throw new Error("Service alive but unavailable; refusing duplicate startup");
		await rm(location.endpoint, { force: true });
		if (process.platform !== "win32") await rm(location.address, { force: true });
		await serve(root, identity, token);
	} finally {
		await release();
	}
}

async function serve(root: string, identity: string, token: string): Promise<void> {
	const location = await serviceLocation(root);
	const projects = new ProjectChecks(root);
	const engine = new Engine(root, undefined, projects);
	const automatic = new Automatic(root, engine);
	const hooks = new HookEngine(root, {
		projects,
		check: async (paths, session, turn, generation, waitMs, signal) =>
			automatic.request(
				{ paths, session, turn, generation, waitMs, scope: "delta" },
				executionEnvironment(),
				signal,
			),
		end: (session) => {
			automatic.cancel(session);
			projects.cancelSession(session);
		},
	});
	let warmupTimer: NodeJS.Timeout | undefined;
	let warmed = false;
	let warming = false;
	let warmupTask: Promise<void> | undefined;
	let warmupSession = "";
	const warmupController = new AbortController();
	const coordinator = new HookCoordinator(root, hooks, (entry) => {
		if (warmed) return;
		warmed = true;
		warmupSession = text(entry.input["session_id"]);
		warmupTimer = setTimeout(() => {
			warming = true;
			warmupTask = withExecution(entry.environment, true, () => engine.warmup(warmupController.signal))
				.catch(() => undefined)
				.finally(() => {
					warming = false;
				});
		}, BUDGET.warmupDelay);
	});
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
				const output = await withExecution(
					environment,
					operation === "automatic" || operation === "hook",
					async () => {
						if (operation === "handshake")
							return { operation, protocol: SERVICE_PROTOCOL, identity, pid: process.pid };
						if (operation === "session_end") {
							automatic.cancel(text(args["session"]));
							return { operation };
						}
						if (operation === "hook_ack") {
							await acknowledgeDelivery(
								root,
								text(args["session"]),
								text(args["deliveryId"]),
								controller.signal,
							);
							return { operation };
						}
						if (operation === "automatic")
							return { operation, ...(await automatic.request(args, environment, controller.signal)) };
						if (operation === "check_project")
							return { ...(await projects.request(args, environment, controller.signal)) };
						if (operation === "hook") {
							if (args["hook_event_name"] === "SessionEnd" && text(args["session_id"]) === warmupSession) {
								if (warmupTimer) clearTimeout(warmupTimer);
								warmupTimer = undefined;
								warmupController.abort();
								warmupSession = "";
							}
							return { operation, ...(await coordinator.request(args, controller.signal)) };
						}
						if (
							!["lsp_status", "check_diagnostics", "lsp_navigation", "lsp_rename", "lsp_format"].includes(
								operation,
							)
						)
							throw new Error("Unknown service operation");
						const config = await configuration(root);
						if (!config.trusted) automatic.cancel();
						const output = await engine.dispatch(operation, args, controller.signal);
						if (operation === "lsp_status")
							return {
								...output,
								service: { state: "running", pid: process.pid, identity, protocol: SERVICE_PROTOCOL },
								automaticDiagnostics: config.automaticDiagnostics,
								automaticTasks: automatic.status(),
								hookTasks: coordinator.status(),
							};
						return output;
					},
				);
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
		if (warmupTimer) clearTimeout(warmupTimer);
		warmupController.abort();
		server.close();
		for (const socket of sockets) socket.destroy();
		await coordinator.dispose();
		await automatic.dispose();
		await warmupTask;
		await projects.dispose();
		await engine.dispose();
		if ((await readEndpoint(location).catch(() => undefined))?.token === token)
			await rm(location.endpoint, { force: true });
	};
	let revalidation: Promise<void> | undefined;
	const idle = setInterval(() => {
		void coordinator.ingest().catch(() => undefined);
		if (!revalidation)
			revalidation = automatic
				.revalidate()
				.catch(() => undefined)
				.finally(() => {
					revalidation = undefined;
				});
		if (
			requests ||
			coordinator.active ||
			automatic.active ||
			projects.active ||
			warming ||
			(warmupTimer && !warmupTask)
		)
			lastActivity = Date.now();
		else if (Date.now() - lastActivity >= BUDGET.idle) void stop();
	}, 250);
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
	await coordinator.ingest();
}
