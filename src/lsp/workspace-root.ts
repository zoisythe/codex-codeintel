// Adapted from zoisythe/lsp-tools-mcp @ 9cc6f753d04834c148d08bbca72e3b483d6301b2.
// Copyright (c) 2026 Yeongyu Kim. MIT; see NOTICE and src/lsp/LICENSE.
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { type CargoWorkspaceRootOptions, resolveCargoWorkspaceRoot } from "./cargo-workspace-root.js";
import type { ResolvedServer } from "./types.js";

const WORKSPACE_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle"];

export type { CargoMetadataLoader } from "./cargo-workspace-root.js";
export interface FindWorkspaceRootOptions extends CargoWorkspaceRootOptions {}

function isDirectoryPath(filePath: string): boolean {
	try {
		return statSync(filePath).isDirectory();
	} catch {
		return false;
	}
}

export async function findWorkspaceRoot(
	filePath: string,
	server?: ResolvedServer,
	options: FindWorkspaceRootOptions = {},
): Promise<string> {
	const abs = resolve(filePath);
	let dir = abs;

	if (!isDirectoryPath(dir)) {
		dir = dirname(dir);
	}

	if (server?.id === "rust") {
		const cargoRoot = await resolveCargoWorkspaceRoot(dir, options);
		if (cargoRoot !== undefined) return cargoRoot;
	}

	let prevDir = "";
	while (dir !== prevDir) {
		const markers = server?.extensions.some((extension) => [".c", ".cpp", ".cc", ".h"].includes(extension))
			? [".clangd", "compile_commands.json", "compile_flags.txt", ...WORKSPACE_MARKERS]
			: WORKSPACE_MARKERS;
		for (const marker of markers) {
			if (existsSync(join(dir, marker))) {
				return dir;
			}
		}
		prevDir = dir;
		dir = dirname(dir);
	}

	return dirname(abs);
}
