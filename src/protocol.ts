import { createInterface } from "node:readline";
import { type FileResult, failureKind, message, record, render, text, WriteFailure } from "./results.js";
import { Runtime } from "./runtime.js";

const string = { type: "string" };
const scope = {
	workspace: { type: "string", description: "Absolute user repository path, never the plugin directory." },
	session: {
		type: "string",
		description: "Codex session id for turn/session scopes; required when multiple sessions share this workspace.",
	},
	path: string,
	paths: { type: "array", items: string, maxItems: 200 },
};
const paging = { cursor: string, refresh: { type: "boolean", description: "Force tool and client revalidation" } };

function tool(
	name: string,
	description: string,
	properties: Record<string, unknown>,
	required: string[],
	readOnly: boolean,
) {
	return {
		name,
		description,
		inputSchema: { type: "object", properties, required: ["workspace", ...required], additionalProperties: false },
		annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false },
	};
}
export const TOOLS = [
	tool(
		"check_project",
		"Run project CLI checkers; active starts background checks, cached reads a job without launching tools. Use for workspace checks.",
		{ workspace: scope.workspace, run: { type: "string", enum: ["active", "cached"] }, job: string, ...paging },
		[],
		true,
	),
	tool(
		"check_diagnostics",
		"Check paths (explicit paths), current turn or session. Active runs LSP/lint; cached never starts analysis and shares automatic Hook results. Continue with complete next arguments.",
		{
			...scope,
			...paging,
			scope: { type: "string", enum: ["paths", "turn", "session"] },
			source: { type: "string", enum: ["lsp", "lint", "both"] },
			run: { type: "string", enum: ["active", "cached"] },
		},
		[],
		true,
	),
	tool(
		"lsp_status",
		"Explain configuration, trust, local tool selection, launchability and running clients without starting LSP. Refresh clears failures and clients.",
		{ workspace: scope.workspace, path: string, refresh: { type: "boolean" } },
		[],
		true,
	),
	tool(
		"lsp_navigation",
		"Read-only LSP navigation. Positions are 1-based; unsupported capabilities are reported explicitly.",
		{
			...scope,
			operation: {
				type: "string",
				enum: [
					"definition",
					"references",
					"symbols",
					"prepare_rename",
					"hover",
					"typeDefinition",
					"implementation",
					"signatureHelp",
				],
			},
			line: { type: "integer", minimum: 1 },
			column: { type: "integer", minimum: 1 },
			query: string,
		},
		["path", "operation"],
		true,
	),
	tool(
		"lsp_rename",
		"Rename across workspace files. Preflight all targets, detect conflicts, write sequentially; never replay partial writes.",
		{ ...scope, line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 1 }, newName: string },
		["path", "newName"],
		false,
	),
	tool(
		"lsp_format",
		"Format explicit paths using Ruff for Python or project formatter/LSP. Preflight before writes.",
		scope,
		[],
		false,
	),
];

function validateArguments(name: string, args: Record<string, unknown>): void {
	if (
		args["refresh"] !== undefined &&
		!(name === "lsp_status" || (["check_diagnostics", "check_project"].includes(name) && args["run"] !== "cached"))
	)
		throw new Error("refresh requires active diagnostics or lsp_status");
	const definition = TOOLS.find((entry) => entry.name === name);
	if (!definition) throw new Error("Unknown tool");
	for (const key of definition.inputSchema.required) if (args[key] === undefined) throw new Error(`${key} required`);
	for (const [key, value] of Object.entries(args)) {
		const schema = definition.inputSchema.properties[key];
		if (!record(schema))
			throw new Error(
				["mode", "start", "offset", "revision"].includes(key)
					? "Migration required: use scope/source/run/cursor; see docs/usage.md#upgrade"
					: `Unknown argument: ${key}`,
			);
		if (schema["type"] === "boolean" && typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
		if (schema["type"] === "string" && typeof value !== "string") throw new Error(`${key} must be a string`);
		if (schema["type"] === "integer") {
			if (
				typeof value !== "number" ||
				!Number.isInteger(value) ||
				(typeof schema["minimum"] === "number" && value < schema["minimum"]) ||
				(typeof schema["maximum"] === "number" && value > schema["maximum"])
			)
				throw new Error(`Invalid integer: ${key}`);
		}
		if (
			schema["type"] === "array" &&
			(!Array.isArray(value) || value.length > 200 || !value.every((item) => typeof item === "string"))
		)
			throw new Error(`${key} must contain at most 200 strings`);
		if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) throw new Error(`Invalid ${key}`);
	}
}
export async function runMcp(
	input: NodeJS.ReadableStream = process.stdin,
	output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
	const runtime = new Runtime();
	const controllers = new Map<string | number, AbortController>();
	const pending = new Set<Promise<void>>();
	const send = (value: unknown) => output.write(`${JSON.stringify(value)}\n`);
	const handle = async (value: unknown): Promise<void> => {
		if (!record(value)) {
			send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
			return;
		}
		const id = value["id"];
		const method = value["method"];
		const params = record(value["params"]) ? value["params"] : {};
		if (method === "notifications/cancelled") {
			const target = params["requestId"];
			if (typeof target === "string" || typeof target === "number") controllers.get(target)?.abort();
			return;
		}
		if (id === undefined) return;
		if (typeof id !== "string" && typeof id !== "number") {
			send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid id" } });
			return;
		}
		const ok = (result: unknown) => send({ jsonrpc: "2.0", id, result });
		if (method === "initialize") {
			ok({
				protocolVersion: text(params["protocolVersion"], "2024-11-05"),
				serverInfo: { name: "codex-codeintel", version: "0.8.0" }, // keep in sync with package.json
				capabilities: { tools: { listChanged: false } },
			});
			return;
		}
		if (method === "ping") {
			ok({});
			return;
		}
		if (method === "tools/list") {
			ok({ tools: TOOLS });
			return;
		}
		if (method === "resources/list") {
			ok({ resources: [] });
			return;
		}
		if (method === "resources/templates/list") {
			ok({ resourceTemplates: [] });
			return;
		}
		if (method !== "tools/call") {
			send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
			return;
		}
		if (controllers.size >= 16 || controllers.has(id)) {
			send({ jsonrpc: "2.0", id, error: { code: -32600, message: "Too many or duplicate requests" } });
			return;
		}
		const controller = new AbortController();
		controllers.set(id, controller);
		try {
			const name = text(params["name"]);
			if (name === "lsp_diagnostics")
				throw new Error("Migration required: use check_diagnostics source=lsp; see docs/usage.md#upgrade");
			if (!TOOLS.some((entry) => entry.name === name)) throw new Error("Unknown tool");
			if (!record(params["arguments"])) throw new Error("Tool arguments required");
			const args = params["arguments"];
			validateArguments(name, args);
			const result = await runtime.request(text(args["workspace"]), name, args, controller.signal);
			const structured = result;
			const rendered =
				name === "check_diagnostics" && Array.isArray(result["results"])
					? `${render(result["results"] as FileResult[])}${result["next"] ? "\nMore results: follow structured next arguments." : ""}${result["inventoryComplete"] === false ? "\nDependency inventory incomplete; workspace dependency freshness unverified" : ""}`
					: name === "lsp_format" && Array.isArray(result["results"])
						? result["results"]
								.map((item: unknown) =>
									record(item)
										? `${item["status"] === "formatted" ? "Formatted" : "Unchanged"}: ${item["path"]}`
										: "",
								)
								.join("\n")
						: name === "lsp_rename" && Array.isArray(result["modifiedPaths"])
							? `Renamed: ${result["modifiedPaths"].join(", ")}`
							: JSON.stringify(result);

			ok({
				...(record(structured)
					? { structuredContent: structured, ...(structured["isError"] === true ? { isError: true } : {}) }
					: {}),
				content: [
					{
						type: "text",
						text: rendered.slice(0, 8000),
					},
				],
			});
		} catch (error) {
			ok({
				isError: true,
				structuredContent: {
					status: failureKind(message(error)),
					reason: message(error),
					...(error instanceof WriteFailure ? { modifiedPaths: error.modifiedPaths } : {}),
				},
				content: [{ type: "text", text: message(error).slice(0, 2000) }],
			});
		} finally {
			controllers.delete(id);
		}
	};
	const shutdown = () => {
		for (const controller of controllers.values()) controller.abort();
	};
	const exit = () => {
		shutdown();
		lines.close();
		input.pause();
	};
	process.once("SIGTERM", exit);
	process.once("SIGINT", exit);
	output.on("error", exit);
	const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
	try {
		for await (const line of lines) {
			if (!line.trim()) continue;
			if (line.length > 1024 * 1024) {
				send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } });
				continue;
			}
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } });
				continue;
			}
			const task = handle(value);
			pending.add(task);
			void task.finally(() => pending.delete(task));
		}
	} finally {
		shutdown();
		await Promise.allSettled(pending);
		await runtime.close();
		process.removeListener("SIGTERM", exit);
		process.removeListener("SIGINT", exit);
		output.removeListener("error", exit);
	}
}
