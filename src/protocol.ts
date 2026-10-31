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

const selector = {
	line: { type: "integer", minimum: 1 },
	column: { type: "integer", minimum: 1 },
	symbol: string,
	pattern: string,
};
const cursor = { cursor: string };
const validation = {
	validate: {
		type: "boolean",
		description: "Preview scoped diagnostics with installed local language/lint tools; false skips simulation.",
	},
	validationPaths: {
		type: "array",
		items: string,
		maxItems: 20,
		description:
			"Up to 20 additional existing files (for example unchanged callers) to check against all plan overlays.",
	},
};
const choice = (...values: string[]) => ({ type: "string", enum: values });
export const LEGACY_TOOLS: Record<string, string> = {
	check_project: "check",
	check_diagnostics: "diagnostics",
	lsp_status: "status",
	lsp_navigation: "navigate",
	lsp_rename: "rename",
	lsp_format: "format",
	lsp_diagnostics: "diagnostics",
};
export const TOOLS = [
	tool(
		"check",
		"Run or read project checks. Follow next until finished.",
		{ workspace: scope.workspace, run: choice("active", "cached"), job: string, ...paging },
		[],
		true,
	),
	tool(
		"diagnostics",
		"Check explicit paths or turn/session; cached reads never analyze. Filters affect display only.",
		{
			...scope,
			...paging,
			scope: choice("paths", "turn", "session"),
			source: choice("lsp", "lint", "both"),
			run: choice("active", "cached"),
			rule: string,
			severity: choice("error", "warning"),
		},
		[],
		true,
	),
	tool(
		"status",
		"Report tool/configuration/capability status without starting servers or downloading tools.",
		{ workspace: scope.workspace, path: string, refresh: { type: "boolean" }, ...cursor },
		[],
		true,
	),
	tool(
		"warmup",
		"Initialize local LSP servers without diagnostics or downloads. Explicit files or two representative languages.",
		{ ...scope, ...cursor },
		[],
		true,
	),
	tool(
		"navigate",
		"Read-only navigation; 1-based UTF-16 positions, symbol path or @@ anchor. Follow next for large results.",
		{
			...scope,
			...selector,
			...cursor,
			operation: choice(
				"definition",
				"declaration",
				"references",
				"symbols",
				"prepare_rename",
				"hover",
				"typeDefinition",
				"implementation",
				"signatureHelp",
				"incoming",
				"outgoing",
				"supertypes",
				"subtypes",
				"completion",
			),
			query: string,
		},
		["path", "operation"],
		true,
	),
	tool(
		"rename",
		"Preview a cross-file rename. Returns a plan; only apply writes files.",
		{ ...scope, ...selector, ...cursor, ...validation, newName: string },
		["path", "newName"],
		true,
	),
	tool(
		"format",
		"Preview formatting of explicit files. Returns a plan; only apply writes files.",
		{ ...scope, ...cursor, ...validation },
		[],
		true,
	),
	tool(
		"inspect",
		"Explore a symbol or affected files, callers and candidate tests. Source is opt-in; test links are not coverage.",
		{
			...scope,
			...selector,
			...cursor,
			operation: choice("symbol", "impact"),
			symbols: {
				type: "array",
				items: string,
				maxItems: 200,
				description: "Explicit symbol paths for impact within path/paths.",
			},
			source: { type: "boolean" },
			transitive: { type: "boolean" },
		},
		["operation"],
		true,
	),
	tool(
		"actions",
		"List, explain or preview lint/LSP fixes. Batch preview selects only vendor-safe fixes; select ids for other actions.",
		{
			...scope,
			...selector,
			...cursor,
			operation: choice("list", "explain", "preview"),
			source: choice("lint", "lsp", "both"),
			rule: string,
			ids: { type: "array", items: string, maxItems: 200 },
			details: { type: "boolean" },
			...validation,
		},
		["operation"],
		true,
	),
	tool(
		"apply",
		"Apply one existing plan once. Conflicts reject before writes; inspect modifiedPaths after cancellation or failure.",
		{ workspace: scope.workspace, session: scope.session, plan: string, ...cursor },
		["plan"],
		false,
	),
];

function validateArguments(name: string, args: Record<string, unknown>): void {
	if (
		name === "actions" &&
		(args["validate"] !== undefined || args["validationPaths"] !== undefined) &&
		args["operation"] !== "preview" &&
		!args["cursor"]
	)
		throw new Error("validate requires actions operation=preview");
	if (args["validate"] === false && args["validationPaths"] !== undefined)
		throw new Error("validationPaths requires validation enabled");
	if (
		args["refresh"] !== undefined &&
		!(name === "status" || (["diagnostics", "check"].includes(name) && args["run"] !== "cached"))
	)
		throw new Error("refresh requires active diagnostics or status");
	const definition = TOOLS.find((entry) => entry.name === name);
	if (!definition) throw new Error("Unknown tool");
	for (const key of definition.inputSchema.required)
		if (args[key] === undefined && (key === "workspace" || !args["cursor"])) throw new Error(`${key} required`);
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
			(!Array.isArray(value) ||
				value.length > (typeof schema["maxItems"] === "number" ? schema["maxItems"] : 200) ||
				!value.every((item) => typeof item === "string"))
		)
			throw new Error(`${key} must contain at most ${schema["maxItems"] ?? 200} strings`);
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
				serverInfo: { name: "codex-codeintel", version: "0.10.0" }, // keep in sync with package.json
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
			if (LEGACY_TOOLS[name])
				throw new Error(
					"Migration required: " +
						name +
						" was removed; use " +
						LEGACY_TOOLS[name] +
						(name === "lsp_rename" || name === "lsp_format" ? " to preview, then apply the plan" : ""),
				);
			if (!TOOLS.some((entry) => entry.name === name)) throw new Error("Unknown tool");
			if (!record(params["arguments"])) throw new Error("Tool arguments required");
			const args = params["arguments"];
			validateArguments(name, args);
			const result = await runtime.request(text(args["workspace"]), name, args, controller.signal);
			const structured = result;

			const rendered =
				name === "diagnostics" && Array.isArray(result["results"])
					? render(result["results"] as FileResult[], 3, 600) + (result["next"] ? "\nContinue with next." : "")
					: [
							String(result["status"] ?? result["state"] ?? (result["partial"] ? "partial" : "complete")),
							result["plan"] ? `plan=${result["plan"]}` : "",
							Array.isArray(result["modifiedPaths"]) ? `modified=${result["modifiedPaths"].length}` : "",
							result["reason"] ? String(result["reason"]).slice(0, 200) : "",
							result["next"] ? "Continue with next." : "",
						]
							.filter(Boolean)
							.join("; ");

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
