// Adapted from zoisythe/lsp-tools-mcp @ 9cc6f753d04834c148d08bbca72e3b483d6301b2.
// Copyright (c) 2026 Yeongyu Kim. MIT; see NOTICE and src/lsp/LICENSE.
export function reportBestEffortCleanupError(operation: string, error: unknown): void {
	if (process.env["CODEX_LSP_DEBUG_CLEANUP"] !== "1") return;
	const message = error instanceof Error ? error.message : String(error);
	console.error(`[codex-lsp] ignored ${operation} failure during cleanup: ${message}`);
}
