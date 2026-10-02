#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/budgets.ts
var BUDGET;
var init_budgets = __esm({
  "src/budgets.ts"() {
    "use strict";
    BUDGET = {
      quickHook: 500,
      warmupDelay: 2e3,
      idle: 3e5,
      cleanup: 1e3,
      postWait: 3500,
      hook: 4400,
      stopWait: 42500,
      stop: 44e3,
      request: 45e3,
      project: 3e5,
      runner: 2e4,
      lspRequest: 35e3,
      lspCold: 5e3,
      lspWarm: 2e3,
      lspQuiet: 200,
      lock: 1e3,
      batch: 50,
      files: 1e4,
      fileBytes: 1024 * 1024,
      outputBytes: 4 * 1024 * 1024,
      argvBytes: 24e3,
      scanWorkers: 16
    };
  }
});

// src/environment.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
function restoreInstalledHome(script = fileURLToPath(import.meta.url)) {
  if (process.env["CODEX_HOME"]) return;
  let child = dirname(script);
  for (let parent = dirname(child); parent !== child; parent = dirname(child)) {
    if (basename(parent) === "plugins" && basename(child) === "cache") {
      process.env["CODEX_HOME"] = dirname(parent);
      return;
    }
    child = parent;
  }
}
function executionEnvironment() {
  return Object.fromEntries(
    Object.entries(executions.getStore()?.environment ?? process.env).sort(([a], [b]) => a.localeCompare(b))
  );
}
function automaticExecution() {
  return executions.getStore()?.automatic ?? false;
}
function subprocessEnvironment(environment = executionEnvironment()) {
  return automaticExecution() ? {
    ...environment,
    RUSTUP_AUTO_INSTALL: "0",
    UV_PYTHON_DOWNLOADS: "never",
    UV_NO_SYNC: "1",
    UV_OFFLINE: "1"
  } : environment;
}
function withExecution(environment, automatic, action) {
  return executions.run({ environment, automatic }, action);
}
var executions;
var init_environment = __esm({
  "src/environment.ts"() {
    "use strict";
    executions = new AsyncLocalStorage();
  }
});

// src/metrics.ts
async function measured(name, action) {
  const start = performance.now();
  try {
    return await action();
  } finally {
    const values = samples.get(name) ?? [];
    values.push(performance.now() - start);
    if (values.length > 128) values.shift();
    samples.set(name, values);
  }
}
function timings() {
  return Object.fromEntries(
    [...samples].map(([name, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return [
        name,
        {
          count: values.length,
          medianMs: sorted[Math.floor(sorted.length / 2)],
          p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]
        }
      ];
    })
  );
}
var samples;
var init_metrics = __esm({
  "src/metrics.ts"() {
    "use strict";
    samples = /* @__PURE__ */ new Map();
  }
});

// src/process-options.ts
var HIDDEN_PROCESS;
var init_process_options = __esm({
  "src/process-options.ts"() {
    "use strict";
    HIDDEN_PROCESS = { windowsHide: true, shell: false };
  }
});

// src/files.ts
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import * as nodePath from "node:path";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
async function workspacePath(root, path) {
  const absolute = resolve(root, path);
  if (!inside(root, absolute)) throw new Error("Path is outside workspace");
  const actual = await realpath(absolute);
  if (!inside(root, actual)) throw new Error("Symlink is outside workspace");
  return actual;
}
async function inventory(...args) {
  return measured("discovery/hash", () => scanInventory(...args));
}
function latestInventory(root) {
  return snapshots.get(root);
}
function indexStatistics() {
  return { ...counters };
}
async function scanInventory(root, maxFiles = 1e4, signal, exclude = [], scope2 = root, dependencyOnly = false, force = []) {
  signal?.throwIfAborted();
  const included = (name) => !name.split(/[\\/]/).some((part) => SKIP.has(part)) && !exclude.some((pattern) => nodePath.matchesGlob(name.split(sep).join("/"), pattern));
  let names;
  let complete = true;
  try {
    const { stdout } = await exec(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
      {
        ...HIDDEN_PROCESS,
        cwd: scope2,
        env: executionEnvironment(),
        timeout: 5e3,
        maxBuffer: 4 * 1024 * 1024,
        ...signal ? { signal } : {}
      }
    );
    names = [
      ...new Set(
        stdout.split("\0").filter(Boolean).map((name) => relative(root, join(scope2, name)))
      )
    ].filter(included);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && "killed" in error && error.killed)
      throw new Error("Git discovery timed out; baseline retained");
    names = [];
    const walk = async (dir) => {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name)
      )) {
        signal?.throwIfAborted();
        if (names.length > maxFiles) {
          complete = false;
          break;
        }
        if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && included(relative(root, path))) names.push(relative(root, path));
      }
    };
    await walk(scope2);
  }
  const files = /* @__PURE__ */ new Map();
  names.sort();
  if (names.length > maxFiles) complete = false;
  if (!complete && dependencyOnly) return { files, complete: false, version: hash(JSON.stringify(names)) };
  counters.scans++;
  let index = indexes.get(root);
  if (!index) {
    index = /* @__PURE__ */ new Map();
    indexes.set(root, index);
  }
  const cache = index;
  const verify = new Set(force);
  const selected = names.slice(0, maxFiles);
  let next = 0;
  await Promise.all(
    Array.from({ length: BUDGET.scanWorkers }, async () => {
      while (next < selected.length) {
        const name = selected[next++];
        if (!name) continue;
        signal?.throwIfAborted();
        try {
          const path = await workspacePath(root, name);
          const info = await lstat(path);
          if (!info.isFile()) continue;
          if (info.size > BUDGET.fileBytes) {
            complete = false;
            continue;
          }
          const key = relative(root, path);
          const signature = JSON.stringify([info.size, info.mtimeMs, info.ctimeMs, info.dev, info.ino]);
          let entry = cache.get(key);
          if (verify.has(key) || entry?.signature !== signature) {
            const content = await readFile(path, { encoding: "utf8", ...signal ? { signal } : {} });
            counters.contentReads++;
            counters.bytesRead += Buffer.byteLength(content);
            entry = { signature, content: hash(content) };
            cache.set(key, entry);
          }
          if (entry) files.set(key, entry.content);
        } catch (error) {
          signal?.throwIfAborted();
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) complete = false;
        }
      }
    })
  );
  if (scope2 === root && complete) {
    for (const key of cache.keys()) if (!files.has(key)) cache.delete(key);
  }
  const sorted = new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
  const snapshot = { files: sorted, version: hash(JSON.stringify([...sorted])), complete };
  if (scope2 === root) snapshots.set(root, snapshot);
  return snapshot;
}
function applyTextChanges(text2, edits) {
  const lines = text2.split("\n");
  const offset = (line, character) => {
    if (!Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0 || line >= lines.length || character > (lines[line]?.length ?? 0))
      throw new Error("Invalid edit range");
    return lines.slice(0, line).reduce((n, part) => n + part.length + 1, 0) + character;
  };
  const sorted = edits.map((edit) => ({
    start: offset(edit.range.start.line, edit.range.start.character),
    end: offset(edit.range.end.line, edit.range.end.character),
    text: edit.newText
  })).sort((a, b) => b.start - a.start || b.end - a.end);
  let boundary = text2.length;
  for (const edit of sorted) {
    if (edit.start > edit.end || edit.end > boundary) throw new Error("Overlapping edit ranges");
    text2 = text2.slice(0, edit.start) + edit.text + text2.slice(edit.end);
    boundary = edit.start;
  }
  return text2;
}
var exec, SKIP, hash, snapshots, indexes, counters;
var init_files = __esm({
  "src/files.ts"() {
    "use strict";
    init_budgets();
    init_environment();
    init_metrics();
    init_process_options();
    exec = promisify(execFile);
    SKIP = /* @__PURE__ */ new Set([
      ".git",
      "node_modules",
      "dist",
      "build",
      ".next",
      "coverage",
      ".canon",
      ".venv",
      ".ruff_cache",
      ".mypy_cache",
      ".pytest_cache",
      "__pycache__",
      "vendor",
      "target"
    ]);
    hash = (text2) => createHash("sha256").update(text2).digest("hex");
    snapshots = /* @__PURE__ */ new Map();
    indexes = /* @__PURE__ */ new Map();
    counters = { scans: 0, contentReads: 0, bytesRead: 0 };
  }
});

// src/lsp/server-definitions.ts
var BUILTIN_SERVERS;
var init_server_definitions = __esm({
  "src/lsp/server-definitions.ts"() {
    "use strict";
    BUILTIN_SERVERS = {
      typescript: {
        command: ["typescript-language-server", "--stdio"],
        extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]
      },
      deno: { command: ["deno", "lsp"], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"] },
      vue: { command: ["vue-language-server", "--stdio"], extensions: [".vue"] },
      eslint: {
        command: ["vscode-eslint-language-server", "--stdio"],
        extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue"]
      },
      oxlint: {
        command: ["oxlint", "--lsp"],
        extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".astro", ".svelte"]
      },
      biome: {
        command: ["biome", "lsp-proxy", "--stdio"],
        extensions: [
          ".ts",
          ".tsx",
          ".js",
          ".jsx",
          ".mjs",
          ".cjs",
          ".mts",
          ".cts",
          ".json",
          ".jsonc",
          ".vue",
          ".astro",
          ".svelte",
          ".css",
          ".graphql",
          ".gql",
          ".html"
        ]
      },
      gopls: { command: ["gopls"], extensions: [".go"] },
      "ruby-lsp": {
        command: ["rubocop", "--lsp"],
        extensions: [".rb", ".rake", ".gemspec", ".ru"]
      },
      basedpyright: {
        command: ["basedpyright-langserver", "--stdio"],
        extensions: [".py", ".pyi"]
      },
      pyright: { command: ["pyright-langserver", "--stdio"], extensions: [".py", ".pyi"] },
      ty: { command: ["ty", "server"], extensions: [".py", ".pyi"] },
      ruff: { command: ["ruff", "server"], extensions: [".py", ".pyi"] },
      "elixir-ls": { command: ["elixir-ls"], extensions: [".ex", ".exs"] },
      zls: { command: ["zls"], extensions: [".zig", ".zon"] },
      csharp: { command: ["csharp-ls"], extensions: [".cs"] },
      fsharp: { command: ["fsautocomplete"], extensions: [".fs", ".fsi", ".fsx", ".fsscript"] },
      "sourcekit-lsp": { command: ["sourcekit-lsp"], extensions: [".swift", ".objc", ".objcpp"] },
      rust: { command: ["rust-analyzer"], extensions: [".rs"] },
      clangd: {
        command: ["clangd", "--background-index", "--clang-tidy"],
        extensions: [".c", ".cpp", ".cc", ".cxx", ".c++", ".h", ".hpp", ".hh", ".hxx", ".h++"]
      },
      svelte: { command: ["svelteserver", "--stdio"], extensions: [".svelte"] },
      astro: { command: ["astro-ls", "--stdio"], extensions: [".astro"] },
      bash: {
        command: ["bash-language-server", "start"],
        extensions: [".sh", ".bash", ".zsh", ".ksh"]
      },
      "bash-ls": {
        command: ["bash-language-server", "start"],
        extensions: [".sh", ".bash", ".zsh", ".ksh"]
      },
      jdtls: { command: ["jdtls"], extensions: [".java"] },
      "yaml-ls": { command: ["yaml-language-server", "--stdio"], extensions: [".yaml", ".yml"] },
      "lua-ls": { command: ["lua-language-server"], extensions: [".lua"] },
      php: { command: ["intelephense", "--stdio"], extensions: [".php"] },
      dart: { command: ["dart", "language-server", "--lsp"], extensions: [".dart"] },
      terraform: { command: ["terraform-ls", "serve"], extensions: [".tf", ".tfvars"] },
      "terraform-ls": { command: ["terraform-ls", "serve"], extensions: [".tf", ".tfvars"] },
      prisma: { command: ["prisma", "language-server"], extensions: [".prisma"] },
      "ocaml-lsp": { command: ["ocamllsp"], extensions: [".ml", ".mli"] },
      texlab: { command: ["texlab"], extensions: [".tex", ".bib"] },
      dockerfile: { command: ["docker-langserver", "--stdio"], extensions: [".dockerfile"] },
      gleam: { command: ["gleam", "lsp"], extensions: [".gleam"] },
      "clojure-lsp": {
        command: ["clojure-lsp", "listen"],
        extensions: [".clj", ".cljs", ".cljc", ".edn"]
      },
      nixd: { command: ["nixd"], extensions: [".nix"] },
      tinymist: { command: ["tinymist"], extensions: [".typ", ".typc"] },
      "haskell-language-server": {
        command: ["haskell-language-server-wrapper", "--lsp"],
        extensions: [".hs", ".lhs"]
      },
      "kotlin-ls": { command: ["kotlin-lsp"], extensions: [".kt", ".kts"] }
    };
  }
});

// src/results.ts
function message(error) {
  return error instanceof Error ? error.message : String(error);
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}
function number(value, fallback, min = 0, max = 1e4) {
  if (value === void 0) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`Expected integer ${min}..${max}`);
  return value;
}
function render(results, limit = 50, byteLimit = 8192, offset = 0) {
  const lines = [
    ...new Set(
      results.flatMap((result) => [
        ...result.channels ? [
          `${result.path} channels: lsp=${result.channels.lsp} lint=${result.channels.lint}${result.note ? `; ${result.note.replace(/\s+/g, " ").slice(0, 300)}` : ""}`
        ] : [],
        ...result.findings.map(
          (finding) => `${finding.path}:${finding.line}:${finding.column} ${finding.severity} [${finding.source}] ${finding.message.replace(/\s+/g, " ")}`
        ),
        ...result.state === "complete" ? [] : [
          `${result.path} ${result.state}${result.note ? `: ${result.note.replace(/\s+/g, " ").slice(0, 300)}` : ""}`
        ]
      ])
    )
  ].sort((a, b) => Number(!a.includes(" error [")) - Number(!b.includes(" error [")) || a.localeCompare(b));
  const complete = results.every((result) => result.state === "complete");
  const header = `${complete ? "complete" : "partial"}; checked=${results.filter((result) => result.state === "complete").length} pending=${results.filter((result) => result.state === "pending" || result.state === "stale").length} skipped=${results.filter((result) => result.state === "skipped").length} failed=${results.filter((result) => result.state === "failed").length}`;
  let output = header;
  let shown = 0;
  for (const line of lines.slice(offset, offset + limit)) {
    const clipped = line.slice(0, 1e3);
    if (Buffer.byteLength(output + clipped) > byteLimit - 180) break;
    output += `
${clipped}`;
    shown++;
  }
  if (offset + shown < lines.length)
    output += `
${lines.length - offset - shown} omitted; next offset=${offset + shown}`;
  return output;
}
function mergeFindings(findings) {
  const entries = /* @__PURE__ */ new Map();
  for (const finding of findings) {
    const key = JSON.stringify([finding.path, finding.line, finding.column, finding.severity, finding.message]);
    const old = entries.get(key);
    if (old) old.sources = [.../* @__PURE__ */ new Set([...old.sources ?? [old.source], finding.source])];
    else entries.set(key, { ...finding });
  }
  return [...entries.values()].sort((a, b) => Number(a.severity !== "error") - Number(b.severity !== "error"));
}
function failureKind(reason) {
  if (/Migration|configuration|schemaVersion|Extension conflict|Unknown built-in|Invalid (?:lsp|lint|formatting)|lsp\.\w+.*(?:must be|requires)|trustedWorkspaces requires|exclude requires/i.test(
    reason
  ))
    return "configuration_error";
  if (/disabled or unsupported|unsupported:/i.test(reason)) return "unsupported";
  if (/timeout|time.*budget/i.test(reason)) return "timeout";
  if (/cancel|abort/i.test(reason)) return "cancelled";
  if (/missing|unavailable|NOT INSTALLED/i.test(reason)) return "tool_missing";
  if (/offline|download|failed to fetch/i.test(reason)) return "temporary_launch_failed";
  if (/initializ/i.test(reason)) return "initialization_failed";
  return "execution_failed";
}
var WriteFailure;
var init_results = __esm({
  "src/results.ts"() {
    "use strict";
    WriteFailure = class extends Error {
      constructor(reason, modifiedPaths) {
        super(reason);
        this.modifiedPaths = modifiedPaths;
      }
    };
  }
});

// node_modules/smol-toml/dist/date.js
var DATE_TIME_RE, TomlDate;
var init_date = __esm({
  "node_modules/smol-toml/dist/date.js"() {
    /*!
     * Copyright (c) Squirrel Chat et al., All rights reserved.
     * SPDX-License-Identifier: BSD-3-Clause
     *
     * Redistribution and use in source and binary forms, with or without
     * modification, are permitted provided that the following conditions are met:
     *
     * 1. Redistributions of source code must retain the above copyright notice, this
     *    list of conditions and the following disclaimer.
     * 2. Redistributions in binary form must reproduce the above copyright notice,
     *    this list of conditions and the following disclaimer in the
     *    documentation and/or other materials provided with the distribution.
     * 3. Neither the name of the copyright holder nor the names of its contributors
     *    may be used to endorse or promote products derived from this software without
     *    specific prior written permission.
     *
     * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
     * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
     * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
     * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
     * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
     * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
     * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
     * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
     * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
     * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
     */
    DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[T ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|[-+]\d{2}:\d{2})?$/i;
    TomlDate = class _TomlDate extends Date {
      #hasDate = false;
      #hasTime = false;
      #offset = null;
      constructor(date) {
        let hasDate = true;
        let hasTime = true;
        let offset = "Z";
        if (typeof date === "string") {
          let match = date.match(DATE_TIME_RE);
          if (match) {
            if (!match[1]) {
              hasDate = false;
              date = `0000-01-01T${date}`;
            }
            hasTime = !!match[2];
            hasTime && date[10] === " " && (date = date.replace(" ", "T"));
            if (match[2] && +match[2] > 23) {
              date = "";
            } else {
              offset = match[3] || null;
              date = date.toUpperCase();
              if (!offset && hasTime)
                date += "Z";
            }
          } else {
            date = "";
          }
        }
        super(date);
        if (!isNaN(this.getTime())) {
          this.#hasDate = hasDate;
          this.#hasTime = hasTime;
          this.#offset = offset;
        }
      }
      isDateTime() {
        return this.#hasDate && this.#hasTime;
      }
      isLocal() {
        return !this.#hasDate || !this.#hasTime || !this.#offset;
      }
      isDate() {
        return this.#hasDate && !this.#hasTime;
      }
      isTime() {
        return this.#hasTime && !this.#hasDate;
      }
      isValid() {
        return this.#hasDate || this.#hasTime;
      }
      toISOString() {
        let iso = super.toISOString();
        if (this.isDate())
          return iso.slice(0, 10);
        if (this.isTime())
          return iso.slice(11, 23);
        if (this.#offset === null)
          return iso.slice(0, -1);
        if (this.#offset === "Z")
          return iso;
        let offset = +this.#offset.slice(1, 3) * 60 + +this.#offset.slice(4, 6);
        offset = this.#offset[0] === "-" ? offset : -offset;
        let offsetDate = new Date(this.getTime() - offset * 6e4);
        return offsetDate.toISOString().slice(0, -1) + this.#offset;
      }
      static wrapAsOffsetDateTime(jsDate, offset = "Z") {
        let date = new _TomlDate(jsDate);
        date.#offset = offset;
        return date;
      }
      static wrapAsLocalDateTime(jsDate) {
        let date = new _TomlDate(jsDate);
        date.#offset = null;
        return date;
      }
      static wrapAsLocalDate(jsDate) {
        let date = new _TomlDate(jsDate);
        date.#hasTime = false;
        date.#offset = null;
        return date;
      }
      static wrapAsLocalTime(jsDate) {
        let date = new _TomlDate(jsDate);
        date.#hasDate = false;
        date.#offset = null;
        return date;
      }
    };
  }
});

// node_modules/smol-toml/dist/error.js
function getLineColFromPtr(string2, ptr) {
  let lines = string2.slice(0, ptr).split(/\r\n|\n|\r/g);
  return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string2, line, column) {
  let lines = string2.split(/\r\n|\n|\r/g);
  let codeblock = "";
  let numberLen = (Math.log10(line + 1) | 0) + 1;
  for (let i = line - 1; i <= line + 1; i++) {
    let l = lines[i - 1];
    if (!l)
      continue;
    codeblock += i.toString().padEnd(numberLen, " ");
    codeblock += ":  ";
    codeblock += l;
    codeblock += "\n";
    if (i === line) {
      codeblock += " ".repeat(numberLen + column + 2);
      codeblock += "^\n";
    }
  }
  return codeblock;
}
var TomlError;
var init_error = __esm({
  "node_modules/smol-toml/dist/error.js"() {
    /*!
     * Copyright (c) Squirrel Chat et al., All rights reserved.
     * SPDX-License-Identifier: BSD-3-Clause
     *
     * Redistribution and use in source and binary forms, with or without
     * modification, are permitted provided that the following conditions are met:
     *
     * 1. Redistributions of source code must retain the above copyright notice, this
     *    list of conditions and the following disclaimer.
     * 2. Redistributions in binary form must reproduce the above copyright notice,
     *    this list of conditions and the following disclaimer in the
     *    documentation and/or other materials provided with the distribution.
     * 3. Neither the name of the copyright holder nor the names of its contributors
     *    may be used to endorse or promote products derived from this software without
     *    specific prior written permission.
     *
     * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
     * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
     * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
     * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
     * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
     * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
     * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
     * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
     * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
     * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
     */
    TomlError = class extends Error {
      line;
      column;
      codeblock;
      constructor(message2, options) {
        const [line, column] = getLineColFromPtr(options.toml, options.ptr);
        const codeblock = makeCodeBlock(options.toml, line, column);
        super(`Invalid TOML document: ${message2}

${codeblock}`, options);
        this.line = line;
        this.column = column;
        this.codeblock = codeblock;
      }
    };
  }
});

// node_modules/smol-toml/dist/primitive.js
function parseString(str, ptr) {
  let c = str[ptr++];
  let first = c;
  let isLiteral = c === "'";
  let isMultiline = c === str[ptr] && c === str[ptr + 1];
  if (isMultiline) {
    if (str[ptr += 2] === "\n")
      ptr++;
    else if (str[ptr] === "\r" && str[ptr + 1] === "\n")
      ptr += 2;
  }
  let parsed = "";
  let sliceStart = ptr;
  let state = 0;
  for (let i = ptr; i < str.length; i++) {
    c = str[i];
    if (isMultiline && (c === "\n" || c === "\r" && str[i + 1] === "\n")) {
      state = state && 3;
    } else if (c < " " && c !== "	" || c === "\x7F") {
      throw new TomlError("control characters are not allowed in strings", {
        toml: str,
        ptr: i
      });
    } else if ((!state || state === 3) && c === first && (!isMultiline || str[i + 1] === first && str[i + 2] === first)) {
      if (isMultiline) {
        if (str[i + 3] === first)
          i++;
        if (str[i + 3] === first)
          i++;
      }
      return [
        // If we're in a newline escape still, then there's nothing to add.
        // Also try to avoid concat if there's nothing to add to parsed, or nothing has been added to parsed.
        state ? parsed : parsed + str.slice(sliceStart, i),
        i + (isMultiline ? 3 : 1)
      ];
    } else if (!state) {
      if (!isLiteral && c === "\\") {
        parsed += str.slice(sliceStart, sliceStart = i);
        state = 1;
      }
    } else if (state === 1) {
      if (c === "x" || c === "u" || c === "U") {
        let value = 0;
        let len = c === "x" ? 2 : c === "u" ? 4 : 8;
        for (let j = 0; j < len; j++, i++) {
          let hex = str.charCodeAt(i + 1);
          let digit = (
            /* 0-9 */
            hex >= 48 && hex <= 57 ? hex - 48 : (
              /* A-F */
              hex >= 65 && hex <= 70 ? hex - 65 + 10 : (
                /* a-f */
                hex >= 97 && hex <= 102 ? hex - 97 + 10 : -1
              )
            )
          );
          if (digit < 0)
            throw new TomlError("invalid non-hex character in unicode escape", { toml: str, ptr: i + 1 });
          value = value << 4 | digit;
        }
        if (value < 0 || value > 1114111 || value >= 55296 && value <= 57343) {
          throw new TomlError("invalid unicode escape", { toml: str, ptr: i });
        }
        parsed += String.fromCodePoint(value);
        sliceStart = i + 1;
        state = 0;
      } else if (c === " " || c === "	") {
        state = 2;
      } else {
        if (c === "b")
          parsed += "\b";
        else if (c === "t")
          parsed += "	";
        else if (c === "n")
          parsed += "\n";
        else if (c === "f")
          parsed += "\f";
        else if (c === "r")
          parsed += "\r";
        else if (c === "e")
          parsed += "\x1B";
        else if (c === '"')
          parsed += '"';
        else if (c === "\\")
          parsed += "\\";
        else
          throw new TomlError("unrecognized escape sequence", { toml: str, ptr: i });
        sliceStart = i + 1;
        state = 0;
      }
    } else if (c !== " " && c !== "	") {
      if (state === 2) {
        throw new TomlError("invalid escape: only line-ending whitespace may be escaped", {
          toml: str,
          ptr: sliceStart
        });
      }
      state = !isLiteral && c === "\\" ? 1 : 0;
      sliceStart = i;
    }
  }
  throw new TomlError("unfinished string", { toml: str, ptr });
}
function parseValue(value, toml, ptr, integersAsBigInt) {
  if (value === "true")
    return true;
  if (value === "false")
    return false;
  if (value === "-inf")
    return -Infinity;
  if (value === "inf" || value === "+inf")
    return Infinity;
  if (value === "nan" || value === "+nan" || value === "-nan")
    return NaN;
  if (value === "-0")
    return integersAsBigInt ? 0n : 0;
  let isInt = INT_REGEX.test(value);
  if (isInt || FLOAT_REGEX.test(value)) {
    if (LEADING_ZERO.test(value)) {
      throw new TomlError("leading zeroes are not allowed", {
        toml,
        ptr
      });
    }
    value = value.replace(/_/g, "");
    let numeric = +value;
    if (isNaN(numeric)) {
      throw new TomlError("invalid number", {
        toml,
        ptr
      });
    }
    if (isInt) {
      if ((isInt = !Number.isSafeInteger(numeric)) && !integersAsBigInt) {
        throw new TomlError("integer value cannot be represented losslessly", {
          toml,
          ptr
        });
      }
      if (isInt || integersAsBigInt === true)
        numeric = BigInt(value);
    }
    return numeric;
  }
  const date = new TomlDate(value);
  if (!date.isValid()) {
    throw new TomlError("invalid value", {
      toml,
      ptr
    });
  }
  return date;
}
var INT_REGEX, FLOAT_REGEX, LEADING_ZERO;
var init_primitive = __esm({
  "node_modules/smol-toml/dist/primitive.js"() {
    init_date();
    init_error();
    /*!
     * Copyright (c) Squirrel Chat et al., All rights reserved.
     * SPDX-License-Identifier: BSD-3-Clause
     *
     * Redistribution and use in source and binary forms, with or without
     * modification, are permitted provided that the following conditions are met:
     *
     * 1. Redistributions of source code must retain the above copyright notice, this
     *    list of conditions and the following disclaimer.
     * 2. Redistributions in binary form must reproduce the above copyright notice,
     *    this list of conditions and the following disclaimer in the
     *    documentation and/or other materials provided with the distribution.
     * 3. Neither the name of the copyright holder nor the names of its contributors
     *    may be used to endorse or promote products derived from this software without
     *    specific prior written permission.
     *
     * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
     * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
     * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
     * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
     * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
     * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
     * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
     * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
     * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
     * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
     */
    INT_REGEX = /^((0x[0-9a-fA-F](_?[0-9a-fA-F])*)|(([+-]|0[ob])?\d(_?\d)*))$/;
    FLOAT_REGEX = /^[+-]?\d(_?\d)*(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/;
    LEADING_ZERO = /^[+-]?0[0-9_]/;
  }
});

// node_modules/smol-toml/dist/util.js
function indexOfNewline(str, start = 0, end = str.length) {
  let idx = str.indexOf("\n", start);
  if (str[idx - 1] === "\r")
    idx--;
  return idx <= end ? idx : -1;
}
function skipComment(str, ptr) {
  for (let i = ptr; i < str.length; i++) {
    let c = str[i];
    if (c === "\n")
      return i;
    if (c === "\r" && str[i + 1] === "\n")
      return i + 1;
    if (c < " " && c !== "	" || c === "\x7F") {
      throw new TomlError("control characters are not allowed in comments", {
        toml: str,
        ptr
      });
    }
  }
  return str.length;
}
function skipVoid(str, ptr, banNewLines, banComments) {
  let c;
  while (1) {
    while ((c = str[ptr]) === " " || c === "	" || !banNewLines && (c === "\n" || c === "\r" && str[ptr + 1] === "\n"))
      ptr++;
    if (banComments || c !== "#")
      break;
    ptr = skipComment(str, ptr);
  }
  return ptr;
}
function skipUntil(str, ptr, sep4, end, banNewLines = false) {
  if (!end) {
    ptr = indexOfNewline(str, ptr);
    return ptr < 0 ? str.length : ptr;
  }
  for (let i = ptr; i < str.length; i++) {
    let c = str[i];
    if (c === "#") {
      i = indexOfNewline(str, i);
    } else if (c === sep4) {
      return i + 1;
    } else if (c === end || banNewLines && (c === "\n" || c === "\r" && str[i + 1] === "\n")) {
      return i;
    }
  }
  throw new TomlError("cannot find end of structure", {
    toml: str,
    ptr
  });
}
var init_util = __esm({
  "node_modules/smol-toml/dist/util.js"() {
    init_error();
    /*!
     * Copyright (c) Squirrel Chat et al., All rights reserved.
     * SPDX-License-Identifier: BSD-3-Clause
     *
     * Redistribution and use in source and binary forms, with or without
     * modification, are permitted provided that the following conditions are met:
     *
     * 1. Redistributions of source code must retain the above copyright notice, this
     *    list of conditions and the following disclaimer.
     * 2. Redistributions in binary form must reproduce the above copyright notice,
     *    this list of conditions and the following disclaimer in the
     *    documentation and/or other materials provided with the distribution.
     * 3. Neither the name of the copyright holder nor the names of its contributors
     *    may be used to endorse or promote products derived from this software without
     *    specific prior written permission.
     *
     * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
     * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
     * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
     * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
     * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
     * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
     * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
     * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
     * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
     * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
     */
  }
});

// node_modules/smol-toml/dist/extract.js
function sliceAndTrimEndOf(str, startPtr, endPtr) {
  let value = str.slice(startPtr, endPtr);
  let commentIdx = value.indexOf("#");
  if (commentIdx > -1) {
    skipComment(str, commentIdx);
    value = value.slice(0, commentIdx);
  }
  return [value.trimEnd(), commentIdx];
}
function extractValue(str, ptr, end, depth, integersAsBigInt) {
  if (depth === 0) {
    throw new TomlError("document contains excessively nested structures. aborting.", {
      toml: str,
      ptr
    });
  }
  let c = str[ptr];
  if (c === "[" || c === "{") {
    let [value, endPtr2] = c === "[" ? parseArray(str, ptr, depth, integersAsBigInt) : parseInlineTable(str, ptr, depth, integersAsBigInt);
    if (end) {
      endPtr2 = skipVoid(str, endPtr2);
      if (str[endPtr2] === ",")
        endPtr2++;
      else if (str[endPtr2] !== end) {
        throw new TomlError("expected comma or end of structure", {
          toml: str,
          ptr: endPtr2
        });
      }
    }
    return [value, endPtr2];
  }
  if (c === '"' || c === "'") {
    let [parsed, endPtr2] = parseString(str, ptr);
    if (end) {
      endPtr2 = skipVoid(str, endPtr2);
      if (str[endPtr2] && str[endPtr2] !== "," && str[endPtr2] !== end && str[endPtr2] !== "\n" && str[endPtr2] !== "\r") {
        throw new TomlError("unexpected character encountered", {
          toml: str,
          ptr: endPtr2
        });
      }
      if (str[endPtr2] === ",")
        endPtr2++;
    }
    return [parsed, endPtr2];
  }
  let endPtr = skipUntil(str, ptr, ",", end);
  let slice = sliceAndTrimEndOf(str, ptr, endPtr - (str[endPtr - 1] === "," ? 1 : 0));
  if (!slice[0]) {
    throw new TomlError("incomplete key-value declaration: no value specified", {
      toml: str,
      ptr
    });
  }
  if (end && slice[1] > -1) {
    endPtr = skipVoid(str, ptr + slice[1]);
    if (str[endPtr] === ",")
      endPtr++;
  }
  return [
    parseValue(slice[0], str, ptr, integersAsBigInt),
    endPtr
  ];
}
var init_extract = __esm({
  "node_modules/smol-toml/dist/extract.js"() {
    init_primitive();
    init_struct();
    init_util();
    init_error();
    /*!
     * Copyright (c) Squirrel Chat et al., All rights reserved.
     * SPDX-License-Identifier: BSD-3-Clause
     *
     * Redistribution and use in source and binary forms, with or without
     * modification, are permitted provided that the following conditions are met:
     *
     * 1. Redistributions of source code must retain the above copyright notice, this
     *    list of conditions and the following disclaimer.
     * 2. Redistributions in binary form must reproduce the above copyright notice,
     *    this list of conditions and the following disclaimer in the
     *    documentation and/or other materials provided with the distribution.
     * 3. Neither the name of the copyright holder nor the names of its contributors
     *    may be used to endorse or promote products derived from this software without
     *    specific prior written permission.
     *
     * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
     * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
     * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
     * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
     * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
     * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
     * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
     * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
     * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
     * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
     */
  }
});

// node_modules/smol-toml/dist/struct.js
function parseKey(str, ptr, end = "=") {
  let dot = ptr - 1;
  let parsed = [];
  let endPtr = str.indexOf(end, ptr);
  if (endPtr < 0) {
    throw new TomlError("incomplete key-value: cannot find end of key", {
      toml: str,
      ptr
    });
  }
  do {
    let c = str[ptr = ++dot];
    if (c !== " " && c !== "	") {
      if (c === '"' || c === "'") {
        if (c === str[ptr + 1] && c === str[ptr + 2]) {
          throw new TomlError("multiline strings are not allowed in keys", {
            toml: str,
            ptr
          });
        }
        let [part, eos] = parseString(str, ptr);
        dot = str.indexOf(".", eos);
        let strEnd = str.slice(eos, dot < 0 || dot > endPtr ? endPtr : dot);
        let newLine = indexOfNewline(strEnd);
        if (newLine > -1) {
          throw new TomlError("newlines are not allowed in keys", {
            toml: str,
            ptr: ptr + dot + newLine
          });
        }
        if (strEnd.trimStart()) {
          throw new TomlError("found extra tokens after the string part", {
            toml: str,
            ptr: eos
          });
        }
        if (endPtr < eos) {
          endPtr = str.indexOf(end, eos);
          if (endPtr < 0) {
            throw new TomlError("incomplete key-value: cannot find end of key", {
              toml: str,
              ptr
            });
          }
        }
        parsed.push(part);
      } else {
        dot = str.indexOf(".", ptr);
        let part = str.slice(ptr, dot < 0 || dot > endPtr ? endPtr : dot);
        if (!KEY_PART_RE.test(part)) {
          throw new TomlError("only letter, numbers, dashes and underscores are allowed in keys", {
            toml: str,
            ptr
          });
        }
        parsed.push(part.trimEnd());
      }
    }
  } while (dot + 1 && dot < endPtr);
  return [parsed, skipVoid(str, endPtr + 1, true, true)];
}
function parseInlineTable(str, ptr, depth, integersAsBigInt) {
  let res = {};
  let seen = /* @__PURE__ */ new Set();
  let c;
  ptr++;
  while ((c = str[ptr++]) !== "}" && c) {
    if (c === ",") {
      throw new TomlError("expected value, found comma", {
        toml: str,
        ptr: ptr - 1
      });
    } else if (c === "#")
      ptr = skipComment(str, ptr);
    else if (c !== " " && c !== "	" && c !== "\n" && c !== "\r") {
      let k;
      let t = res;
      let hasOwn = false;
      let [key, keyEndPtr] = parseKey(str, ptr - 1);
      for (let i = 0; i < key.length; i++) {
        if (i)
          t = hasOwn ? t[k] : t[k] = {};
        k = key[i];
        if ((hasOwn = Object.hasOwn(t, k)) && (typeof t[k] !== "object" || seen.has(t[k]))) {
          throw new TomlError("trying to redefine an already defined value", {
            toml: str,
            ptr
          });
        }
        if (!hasOwn && k === "__proto__") {
          Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        }
      }
      if (hasOwn) {
        throw new TomlError("trying to redefine an already defined value", {
          toml: str,
          ptr
        });
      }
      let [value, valueEndPtr] = extractValue(str, keyEndPtr, "}", depth - 1, integersAsBigInt);
      seen.add(value);
      t[k] = value;
      ptr = valueEndPtr;
    }
  }
  if (!c) {
    throw new TomlError("unfinished table encountered", {
      toml: str,
      ptr
    });
  }
  return [res, ptr];
}
function parseArray(str, ptr, depth, integersAsBigInt) {
  let res = [];
  let c;
  ptr++;
  while ((c = str[ptr++]) !== "]" && c) {
    if (c === ",") {
      throw new TomlError("expected value, found comma", {
        toml: str,
        ptr: ptr - 1
      });
    } else if (c === "#")
      ptr = skipComment(str, ptr);
    else if (c !== " " && c !== "	" && c !== "\n" && c !== "\r") {
      let e = extractValue(str, ptr - 1, "]", depth - 1, integersAsBigInt);
      res.push(e[0]);
      ptr = e[1];
    }
  }
  if (!c) {
    throw new TomlError("unfinished array encountered", {
      toml: str,
      ptr
    });
  }
  return [res, ptr];
}
var KEY_PART_RE;
var init_struct = __esm({
  "node_modules/smol-toml/dist/struct.js"() {
    init_primitive();
    init_extract();
    init_util();
    init_error();
    /*!
     * Copyright (c) Squirrel Chat et al., All rights reserved.
     * SPDX-License-Identifier: BSD-3-Clause
     *
     * Redistribution and use in source and binary forms, with or without
     * modification, are permitted provided that the following conditions are met:
     *
     * 1. Redistributions of source code must retain the above copyright notice, this
     *    list of conditions and the following disclaimer.
     * 2. Redistributions in binary form must reproduce the above copyright notice,
     *    this list of conditions and the following disclaimer in the
     *    documentation and/or other materials provided with the distribution.
     * 3. Neither the name of the copyright holder nor the names of its contributors
     *    may be used to endorse or promote products derived from this software without
     *    specific prior written permission.
     *
     * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
     * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
     * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
     * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
     * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
     * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
     * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
     * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
     * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
     * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
     */
    KEY_PART_RE = /^[a-zA-Z0-9-_]+[ \t]*$/;
  }
});

// node_modules/smol-toml/dist/parse.js
function peekTable(key, table, meta, type) {
  let t = table;
  let m = meta;
  let k;
  let hasOwn = false;
  let state;
  for (let i = 0; i < key.length; i++) {
    if (i) {
      t = hasOwn ? t[k] : t[k] = {};
      m = (state = m[k]).c;
      if (type === 0 && (state.t === 1 || state.t === 2)) {
        return null;
      }
      if (state.t === 2) {
        let l = t.length - 1;
        t = t[l];
        m = m[l].c;
      }
    }
    k = key[i];
    if ((hasOwn = Object.hasOwn(t, k)) && m[k]?.t === 0 && m[k]?.d) {
      return null;
    }
    if (!hasOwn) {
      if (k === "__proto__") {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        Object.defineProperty(m, k, { enumerable: true, configurable: true, writable: true });
      }
      m[k] = {
        t: i < key.length - 1 && type === 2 ? 3 : type,
        d: false,
        i: 0,
        c: {}
      };
    }
  }
  state = m[k];
  if (state.t !== type && !(type === 1 && state.t === 3)) {
    return null;
  }
  if (type === 2) {
    if (!state.d) {
      state.d = true;
      t[k] = [];
    }
    t[k].push(t = {});
    state.c[state.i++] = state = { t: 1, d: false, i: 0, c: {} };
  }
  if (state.d) {
    return null;
  }
  state.d = true;
  if (type === 1) {
    t = hasOwn ? t[k] : t[k] = {};
  } else if (type === 0 && hasOwn) {
    return null;
  }
  return [k, t, state.c];
}
function parse(toml, { maxDepth = 1e3, integersAsBigInt } = {}) {
  let res = {};
  let meta = {};
  let tbl = res;
  let m = meta;
  for (let ptr = skipVoid(toml, 0); ptr < toml.length; ) {
    if (toml[ptr] === "[") {
      let isTableArray = toml[++ptr] === "[";
      let k = parseKey(toml, ptr += +isTableArray, "]");
      if (isTableArray) {
        if (toml[k[1] - 1] !== "]") {
          throw new TomlError("expected end of table declaration", {
            toml,
            ptr: k[1] - 1
          });
        }
        k[1]++;
      }
      let p = peekTable(
        k[0],
        res,
        meta,
        isTableArray ? 2 : 1
        /* Type.EXPLICIT */
      );
      if (!p) {
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr
        });
      }
      m = p[2];
      tbl = p[1];
      ptr = k[1];
    } else {
      let k = parseKey(toml, ptr);
      let p = peekTable(
        k[0],
        tbl,
        m,
        0
        /* Type.DOTTED */
      );
      if (!p) {
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr
        });
      }
      let v = extractValue(toml, k[1], void 0, maxDepth, integersAsBigInt);
      p[1][p[0]] = v[0];
      ptr = v[1];
    }
    ptr = skipVoid(toml, ptr, true);
    if (toml[ptr] && toml[ptr] !== "\n" && toml[ptr] !== "\r") {
      throw new TomlError("each key-value declaration must be followed by an end-of-line", {
        toml,
        ptr
      });
    }
    ptr = skipVoid(toml, ptr);
  }
  return res;
}
var init_parse = __esm({
  "node_modules/smol-toml/dist/parse.js"() {
    init_struct();
    init_extract();
    init_util();
    init_error();
    /*!
     * Copyright (c) Squirrel Chat et al., All rights reserved.
     * SPDX-License-Identifier: BSD-3-Clause
     *
     * Redistribution and use in source and binary forms, with or without
     * modification, are permitted provided that the following conditions are met:
     *
     * 1. Redistributions of source code must retain the above copyright notice, this
     *    list of conditions and the following disclaimer.
     * 2. Redistributions in binary form must reproduce the above copyright notice,
     *    this list of conditions and the following disclaimer in the
     *    documentation and/or other materials provided with the distribution.
     * 3. Neither the name of the copyright holder nor the names of its contributors
     *    may be used to endorse or promote products derived from this software without
     *    specific prior written permission.
     *
     * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
     * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
     * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
     * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
     * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
     * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
     * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
     * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
     * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
     * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
     */
  }
});

// node_modules/smol-toml/dist/stringify.js
var init_stringify = __esm({
  "node_modules/smol-toml/dist/stringify.js"() {
    /*!
     * Copyright (c) Squirrel Chat et al., All rights reserved.
     * SPDX-License-Identifier: BSD-3-Clause
     *
     * Redistribution and use in source and binary forms, with or without
     * modification, are permitted provided that the following conditions are met:
     *
     * 1. Redistributions of source code must retain the above copyright notice, this
     *    list of conditions and the following disclaimer.
     * 2. Redistributions in binary form must reproduce the above copyright notice,
     *    this list of conditions and the following disclaimer in the
     *    documentation and/or other materials provided with the distribution.
     * 3. Neither the name of the copyright holder nor the names of its contributors
     *    may be used to endorse or promote products derived from this software without
     *    specific prior written permission.
     *
     * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
     * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
     * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
     * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
     * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
     * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
     * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
     * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
     * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
     * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
     */
  }
});

// node_modules/smol-toml/dist/index.js
var init_dist = __esm({
  "node_modules/smol-toml/dist/index.js"() {
    init_parse();
    init_stringify();
    init_date();
    init_error();
    /*!
     * Copyright (c) Squirrel Chat et al., All rights reserved.
     * SPDX-License-Identifier: BSD-3-Clause
     *
     * Redistribution and use in source and binary forms, with or without
     * modification, are permitted provided that the following conditions are met:
     *
     * 1. Redistributions of source code must retain the above copyright notice, this
     *    list of conditions and the following disclaimer.
     * 2. Redistributions in binary form must reproduce the above copyright notice,
     *    this list of conditions and the following disclaimer in the
     *    documentation and/or other materials provided with the distribution.
     * 3. Neither the name of the copyright holder nor the names of its contributors
     *    may be used to endorse or promote products derived from this software without
     *    specific prior written permission.
     *
     * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
     * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
     * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
     * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
     * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
     * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
     * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
     * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
     * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
     * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
     */
  }
});

// src/trust.ts
import { readFile as readFile2, realpath as realpath2 } from "node:fs/promises";
import { isAbsolute as isAbsolute2 } from "node:path";
async function workspaceTrust(root, path) {
  const workspace = await realpath2(root);
  let content;
  try {
    content = await readFile2(path, "utf8");
  } catch (error) {
    if (record(error) && error["code"] === "ENOENT") return { path, workspace, level: "unset" };
    throw new Error(`Cannot read Codex user trust configuration: ${path}`);
  }
  let config;
  try {
    config = parse(content);
  } catch {
    throw new Error(`Invalid TOML in Codex user trust configuration: ${path}`);
  }
  const projects = record(config) ? config["projects"] : void 0;
  if (projects === void 0) return { path, workspace, level: "unset" };
  if (!record(projects)) throw new Error(`Invalid projects table in Codex user trust configuration: ${path}`);
  const levels = await Promise.all(
    Object.entries(projects).map(async ([candidate, entry]) => {
      if (!isAbsolute2(candidate) || !record(entry)) return void 0;
      if (await realpath2(candidate).catch(() => void 0) !== workspace) return void 0;
      return entry["trust_level"];
    })
  );
  const level = levels.includes("untrusted") ? "untrusted" : levels.includes("trusted") ? "trusted" : "unset";
  return { path, workspace, level };
}
var init_trust = __esm({
  "src/trust.ts"() {
    "use strict";
    init_dist();
    init_results();
  }
});

// src/config.ts
import { readFile as readFile3 } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute as isAbsolute3, join as join2 } from "node:path";
function configPaths(root) {
  for (const key of Object.keys(executionEnvironment()))
    if (key.startsWith("LSP_TOOLS_MCP_") && key.endsWith("_CONFIG") || key === "CODEX_LSP_TRUST_PROJECT")
      throw new Error(
        `Migration required: remove ${key}; use $CODEX_HOME/lsp-client.json (schemaVersion: 1) and <workspace>/.codex/lsp-client.json; trust comes from $CODEX_HOME/config.toml. See docs/usage.md#upgrade`
      );
  return {
    user: join2(executionEnvironment()["CODEX_HOME"] ?? join2(homedir(), ".codex"), "lsp-client.json"),
    project: join2(root, ".codex", "lsp-client.json"),
    codex: join2(executionEnvironment()["CODEX_HOME"] ?? join2(homedir(), ".codex"), "config.toml")
  };
}
async function read(path) {
  try {
    const value = JSON.parse(await readFile3(path, "utf8"));
    if (!record(value) || value["schemaVersion"] !== 1)
      throw new Error(
        `Migration required: ${path} requires schemaVersion: 1 and language-keyed lsp entries; see docs/usage.md#upgrade`
      );
    for (const key of Object.keys(value))
      if (![
        "schemaVersion",
        "trustedWorkspaces",
        "lsp",
        "lint",
        "exclude",
        "formatting",
        "automaticDiagnostics",
        "projectChecks"
      ].includes(key))
        throw new Error(`Unknown configuration field ${key} in ${path}`);
    return value;
  } catch (error) {
    if (record(error) && error["code"] === "ENOENT") return {};
    throw new Error(`Configuration error in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function server(value, language, source) {
  if (value === false) return false;
  const builtin = typeof value === "string" ? builtins[value] : void 0;
  if (typeof value === "string" && !builtin) throw new Error(`Unknown built-in server ${value} for ${language}`);
  const item = builtin ?? value;
  if (!record(item)) throw new Error(`lsp.${language} must be a built-in name, custom server or false`);
  for (const key of Object.keys(item))
    if (!["command", "extensions", "env", "initialization"].includes(key))
      throw new Error(`Invalid lsp.${language}.${key}; priority/disabled were removed; use false to disable`);
  const command = item["command"];
  const extensions = item["extensions"];
  if (!Array.isArray(command) || !command.length || !command.every((v) => typeof v === "string" && !!v))
    throw new Error(`lsp.${language}.command requires a nonempty string array`);
  if (!Array.isArray(extensions) || !extensions.length || !extensions.every((v) => typeof v === "string" && /^\.[^/\\]+$/.test(v)))
    throw new Error(`lsp.${language}.extensions requires dot-prefixed extensions`);
  const env = item["env"];
  const initialization = item["initialization"];
  if (env !== void 0 && (!record(env) || !Object.values(env).every((v) => typeof v === "string")))
    throw new Error(`Invalid lsp.${language}.env`);
  if (initialization !== void 0 && !record(initialization))
    throw new Error(`Invalid lsp.${language}.initialization`);
  return {
    id: typeof value === "string" ? value : language,
    command,
    extensions,
    explicit: !builtin,
    source,
    ...env ? { env } : {},
    ...initialization ? { initialization } : {}
  };
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
async function configuration(root) {
  const paths = configPaths(root);
  const user = await read(paths.user);
  const trust = await workspaceTrust(root, paths.codex);
  const project = trust.level === "trusted" ? await read(paths.project) : {};
  const servers = {};
  for (const [language, name] of Object.entries(defaults)) servers[language] = server(name, language, "builtin");
  for (const [data, source] of [
    [user, paths.user],
    [project, paths.project]
  ]) {
    if (data["lsp"] !== void 0 && !record(data["lsp"])) throw new Error(`Invalid lsp in ${source}`);
    if (record(data["lsp"]))
      for (const [language, value] of Object.entries(data["lsp"]))
        servers[language] = server(value, language, source);
    for (const key of ["lint", "formatting", "automaticDiagnostics"])
      if (data[key] !== void 0 && !record(data[key])) throw new Error(`Invalid ${key} in ${source}`);
  }
  const extensions = {};
  for (const [language, name] of Object.entries(defaults)) {
    const entry = server(name, language, "builtin");
    if (entry) extensions[language] = entry.extensions;
  }
  for (const [language, entry] of Object.entries(servers)) if (entry) extensions[language] = entry.extensions;
  const used = /* @__PURE__ */ new Map();
  for (const [language, entry] of Object.entries(servers))
    if (entry)
      for (const extension of entry.extensions) {
        if (used.has(extension))
          throw new Error(
            `Extension conflict ${extension}: ${used.get(extension)} and ${language}; disable or replace the original language entry`
          );
        used.set(extension, language);
      }
  const lint = { ...record(user["lint"]) ? user["lint"] : {}, ...record(project["lint"]) ? project["lint"] : {} };
  const javascript = lint["javascript"] ?? "auto";
  const python = lint["python"] ?? "auto";
  if (javascript !== "auto" && javascript !== "biome" && javascript !== "eslint" && javascript !== "off")
    throw new Error("Invalid lint.javascript");
  if (python !== "auto" && python !== "ruff" && python !== "off") throw new Error("Invalid lint.python");
  const exclude = project["exclude"] ?? user["exclude"] ?? [];
  if (!Array.isArray(exclude) || !exclude.every(
    (item) => typeof item === "string" && !item.startsWith("!") && !item.includes("\\") && !isAbsolute3(item) && !item.split("/").includes("..")
  ))
    throw new Error("exclude requires relative forward-slash globs without negation");
  const formatting = {
    tabSize: 4,
    insertSpaces: true,
    ...record(user["formatting"]) ? user["formatting"] : {},
    ...record(project["formatting"]) ? project["formatting"] : {}
  };
  if (!Number.isInteger(formatting.tabSize) || formatting.tabSize < 1 || formatting.tabSize > 16 || typeof formatting.insertSpaces !== "boolean")
    throw new Error("Invalid formatting.tabSize or formatting.insertSpaces");
  const automaticDiagnostics = {
    postToolUse: "delta",
    stop: "errors",
    ...record(user["automaticDiagnostics"]) ? user["automaticDiagnostics"] : {},
    ...record(project["automaticDiagnostics"]) ? project["automaticDiagnostics"] : {}
  };
  for (const [key, value] of Object.entries(automaticDiagnostics)) {
    if (value === "full" || key === "stop" && value === "delta")
      throw new Error(
        "Migration required: automaticDiagnostics uses postToolUse=delta/off and stop=errors/off; use check_project for full checks. See docs/usage.md#upgrade"
      );
    if (!["postToolUse", "stop"].includes(key) || ![key === "stop" ? "errors" : "delta", "off"].includes(value))
      throw new Error(`Invalid automaticDiagnostics.${key}`);
  }
  const projectChecks = project["projectChecks"] ?? user["projectChecks"] ?? "auto";
  if (projectChecks !== "auto") {
    if (!Array.isArray(projectChecks)) throw new Error("projectChecks requires auto or a list");
    const used2 = /* @__PURE__ */ new Set();
    for (const check of projectChecks) {
      if (!record(check) || Object.keys(check).some((key) => !["name", "cwd", "command", "parser", "coverage"].includes(key)) || typeof check["name"] !== "string" || !check["name"] || used2.has(check["name"]) || typeof check["cwd"] !== "string" || isAbsolute3(check["cwd"]) || check["cwd"].split(/[\\/]/).includes("..") || !["tsc", "ty", "cargo", "ruff", "eslint", "biome", "json", "sarif"].includes(String(check["parser"])) || !Array.isArray(check["command"]) || !check["command"].length || !check["command"].every((arg) => typeof arg === "string" && arg.length) || !Array.isArray(check["coverage"]) || !check["coverage"].length || !check["coverage"].every(
        (arg) => typeof arg === "string" && !isAbsolute3(arg) && !arg.startsWith("!") && !arg.split("/").includes("..")
      ))
        throw new Error(
          "Invalid projectChecks entry: require unique name, relative cwd, command array, parser and coverage globs"
        );
      used2.add(check["name"]);
    }
  }
  return freeze({
    schemaVersion: 1,
    projectChecks,
    automaticDiagnostics,
    javascript,
    python,
    exclude,
    trusted: trust.level === "trusted",
    trust,
    ...paths,
    extensions,
    servers,
    formatting,
    version: hash(JSON.stringify([user, project, trust, paths]))
  });
}
var defaults, web, builtins;
var init_config = __esm({
  "src/config.ts"() {
    "use strict";
    init_environment();
    init_files();
    init_server_definitions();
    init_results();
    init_trust();
    defaults = {
      python: "ty",
      typescript: "typescript",
      cpp: "clangd",
      rust: "rust",
      bash: "bash",
      yaml: "yaml-ls",
      svelte: "svelte",
      astro: "astro",
      go: "gopls",
      lua: "lua-ls",
      java: "jdtls",
      html: "html",
      css: "css",
      json: "json"
    };
    web = {
      html: { command: ["vscode-html-language-server", "--stdio"], extensions: [".html", ".htm"] },
      css: { command: ["vscode-css-language-server", "--stdio"], extensions: [".css", ".scss", ".less"] },
      json: { command: ["vscode-json-language-server", "--stdio"], extensions: [".json", ".jsonc"] }
    };
    builtins = {
      ...BUILTIN_SERVERS,
      ...web,
      tsc: { command: ["tsc", "--lsp", "--stdio"], extensions: BUILTIN_SERVERS["typescript"]?.extensions },
      tsgo: { command: ["tsgo", "--lsp", "--stdio"], extensions: BUILTIN_SERVERS["typescript"]?.extensions }
    };
  }
});

// src/config-files.ts
import { basename as basename2 } from "node:path";
function configurationImpact(path) {
  const name = basename2(path);
  if (/^(?:tsconfig|jsconfig)(?:\.[^.]+)*\.json$/.test(name)) return ["types"];
  if (/^(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.(?:json|ya?ml|[cm]?js))?)$/.test(name)) return ["lint"];
  return exact[name] ?? [];
}
function configNames() {
  return Object.keys(exact);
}
function configurationLanguages(path) {
  const name = basename2(path);
  if (configurationImpact(path).length === 0) return [];
  if (/^(?:eslint\.config\.|\.eslintrc|biome\.json)/.test(name)) return ["typescript"];
  if (["ruff.toml", ".ruff.toml"].includes(name)) return ["python"];
  if (["rustfmt.toml", ".rustfmt.toml"].includes(name)) return ["rust"];
  if (name === ".clang-format") return ["cpp"];
  if (/^(?:Cargo\.|rust-toolchain)/.test(name)) return ["rust"];
  if (/^(?:tsconfig|jsconfig|package|pnpm-lock|yarn\.lock)/.test(name)) return ["typescript"];
  if (["pyproject.toml", "uv.lock", "ty.toml", "pyrightconfig.json"].includes(name)) return ["python"];
  if ([".clangd", "compile_commands.json", "compile_flags.txt"].includes(name)) return ["cpp"];
  if (["go.mod", "go.sum"].includes(name)) return ["go"];
  return [];
}
var exact;
var init_config_files = __esm({
  "src/config-files.ts"() {
    "use strict";
    exact = {
      "package.json": ["types", "lint"],
      "package-lock.json": ["types", "lint"],
      "pnpm-lock.yaml": ["types", "lint"],
      "yarn.lock": ["types", "lint"],
      "Cargo.toml": ["types"],
      "Cargo.lock": ["types"],
      "rust-toolchain": ["types"],
      "rust-toolchain.toml": ["types"],
      "pyproject.toml": ["types", "lint", "format"],
      "uv.lock": ["types", "lint"],
      "ty.toml": ["types"],
      "pyrightconfig.json": ["types"],
      "ruff.toml": ["lint", "format"],
      ".ruff.toml": ["lint", "format"],
      "biome.json": ["lint", "format"],
      "biome.jsonc": ["lint", "format"],
      ".clangd": ["types"],
      "compile_commands.json": ["types"],
      "compile_flags.txt": ["types"],
      ".clang-format": ["format"],
      "rustfmt.toml": ["format"],
      ".rustfmt.toml": ["format"],
      "go.mod": ["types"],
      "go.sum": ["types"],
      "lsp-client.json": ["types", "lint", "format"]
    };
  }
});

// src/diagnostic-delta.ts
function diagnosticKey(finding) {
  const rule = finding.source.split("/").at(-1)?.replace(/^TS(?=\d)/, "") ?? "";
  return JSON.stringify([
    finding.path,
    rule,
    finding.severity,
    finding.column,
    finding.message.replace(/\s+/g, " ").trim()
  ]);
}
function addedFindings(before, after) {
  const counts = /* @__PURE__ */ new Map();
  for (const item of before) {
    const key = diagnosticKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return after.filter((item) => {
    const key = diagnosticKey(item);
    const remaining = counts.get(key) ?? 0;
    if (!remaining) return true;
    counts.set(key, remaining - 1);
    return false;
  });
}
var init_diagnostic_delta = __esm({
  "src/diagnostic-delta.ts"() {
    "use strict";
  }
});

// src/lsp/cleanup-errors.ts
function reportBestEffortCleanupError(operation, error) {
  if (process.env["CODEX_LSP_DEBUG_CLEANUP"] !== "1") return;
  const message2 = error instanceof Error ? error.message : String(error);
  console.error(`[codex-lsp] ignored ${operation} failure during cleanup: ${message2}`);
}
var init_cleanup_errors = __esm({
  "src/lsp/cleanup-errors.ts"() {
    "use strict";
  }
});

// src/lsp/errors.ts
var LspConnectionClosedError, LspProcessExitedError, LspInvalidPathError, LspProcessSpawnError;
var init_errors = __esm({
  "src/lsp/errors.ts"() {
    "use strict";
    LspConnectionClosedError = class extends Error {
      constructor(serverId, root, message2) {
        super(message2 ?? `LSP connection closed for ${serverId} at ${root}`);
        this.serverId = serverId;
        this.root = root;
        this.name = "LspConnectionClosedError";
      }
    };
    LspProcessExitedError = class extends Error {
      constructor(serverId, root, exitCode, stderrTail) {
        const stderrSuffix = stderrTail ? `
stderr tail: ${stderrTail}` : "";
        super(`LSP server ${serverId} at ${root} exited with code ${exitCode ?? "null"}${stderrSuffix}`);
        this.serverId = serverId;
        this.root = root;
        this.exitCode = exitCode;
        this.stderrTail = stderrTail;
        this.name = "LspProcessExitedError";
      }
    };
    LspInvalidPathError = class extends Error {
      constructor() {
        super(...arguments);
        this.name = "LspInvalidPathError";
      }
    };
    LspProcessSpawnError = class extends Error {
      constructor() {
        super(...arguments);
        this.name = "LspProcessSpawnError";
      }
    };
  }
});

// src/lsp/process.ts
import * as childProcess from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join as join3 } from "node:path";
function isMissingProcessError(error) {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "ESRCH";
}
function reportKillError(context, error) {
  if (!isMissingProcessError(error)) {
    reportBestEffortCleanupError(context, error);
  }
}
function validateCwd(cwd) {
  try {
    if (!existsSync(cwd)) {
      return { valid: false, error: `Working directory does not exist: ${cwd}` };
    }
    const stats = statSync(cwd);
    if (!stats.isDirectory()) {
      return { valid: false, error: `Path is not a directory: ${cwd}` };
    }
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: `Cannot access working directory: ${cwd} (${err instanceof Error ? err.message : String(err)})`
    };
  }
}
function wrap(proc) {
  const exitedPromise = new Promise((resolve12) => {
    proc.once("close", (code) => resolve12(code ?? 0));
    proc.once("error", () => resolve12(1));
  });
  if (!proc.stdin || !proc.stdout || !proc.stderr) {
    throw new LspProcessSpawnError("Spawned process is missing one of stdin/stdout/stderr pipes");
  }
  return {
    stdin: proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
    get pid() {
      return proc.pid ?? void 0;
    },
    get exitCode() {
      return proc.exitCode;
    },
    get killed() {
      return proc.killed;
    },
    exited: exitedPromise,
    kill(signal) {
      terminateProcessTree(proc, signal ?? "SIGTERM");
    }
  };
}
function terminateProcessTree(proc, signal = "SIGTERM", options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" && proc.pid) {
    if (terminating.has(proc)) return;
    terminating.add(proc);
    const args = ["/pid", String(proc.pid), "/f", "/t"];
    childProcess.execFile(
      "taskkill",
      args,
      {
        ...HIDDEN_PROCESS,
        env: executionEnvironment(),
        timeout: BUDGET.cleanup,
        maxBuffer: 64 * 1024
      },
      (error) => {
        if (!error) return;
        terminating.delete(proc);
        if (proc.exitCode !== null) return;
        reportKillError("windows process tree kill", error);
        try {
          proc.kill(signal);
        } catch (fallback) {
          reportKillError("process kill", fallback);
        }
      }
    );
    return;
  }
  if (platform !== "win32" && proc.pid) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch (error) {
      reportKillError("process group kill", error);
    }
    const descendants = findDescendantProcessIds(proc.pid);
    try {
      proc.kill(signal);
    } catch (error) {
      reportKillError("process kill", error);
    }
    for (const pid of descendants) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        reportKillError("descendant process kill", error);
      }
    }
    return;
  }
  try {
    proc.kill(signal);
  } catch (error) {
    reportKillError("process kill", error);
  }
}
function findDescendantProcessIds(rootPid) {
  const result = childProcess.spawnSync("ps", ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8",
    env: executionEnvironment()
  });
  if (result.error) {
    reportKillError("process tree inspection", result.error);
    return [];
  }
  if (result.status !== 0 || typeof result.stdout !== "string") return [];
  const childrenByParent = /* @__PURE__ */ new Map();
  for (const line of result.stdout.split("\n")) {
    const [pidText, parentPidText] = line.trim().split(/\s+/, 2);
    if (pidText === void 0 || parentPidText === void 0) continue;
    const pid = Number(pidText);
    const parentPid = Number(parentPidText);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid)) continue;
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }
  const descendants = [];
  const pendingParents = [rootPid];
  while (pendingParents.length > 0) {
    const parentPid = pendingParents.pop();
    if (parentPid === void 0) break;
    for (const childPid of childrenByParent.get(parentPid) ?? []) {
      descendants.push(childPid);
      pendingParents.push(childPid);
    }
  }
  return descendants.reverse();
}
function isWindowsShellShim(command) {
  const lowerCommand = command.toLowerCase();
  return lowerCommand.endsWith(".cmd") || lowerCommand.endsWith(".bat");
}
function splitPath(pathValue, platform) {
  const separator = platform === "win32" ? ";" : delimiter;
  return pathValue.split(separator).filter(Boolean);
}
function getWindowsPathExtensions(env) {
  const rawExtensions = env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD";
  const extensions = rawExtensions.split(";").map((extension) => extension.trim()).filter(Boolean).map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
  return [.../* @__PURE__ */ new Set(["", ...extensions, ".exe", ".cmd", ".bat"])];
}
function resolveWindowsCommand(command, env) {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  const pathValue = env["PATH"] ?? env["Path"] ?? "";
  const baseDirectories = hasPathSeparator ? [""] : splitPath(pathValue, "win32");
  const extensions = getWindowsPathExtensions(env);
  for (const baseDirectory of baseDirectories) {
    for (const extension of extensions) {
      const candidate = baseDirectory ? join3(baseDirectory, `${command}${extension}`) : `${command}${extension}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}
function createSpawnCommand(command, platform = process.platform, commandProcessor = process.env["ComSpec"] ?? "cmd.exe", env = process.env) {
  const [cmd, ...args] = command;
  if (!cmd) {
    throw new LspProcessSpawnError("[lsp] empty command");
  }
  if (platform !== "win32") {
    return { command: cmd, args, shell: false };
  }
  const resolvedCommand = resolveWindowsCommand(cmd, env);
  if (!isWindowsShellShim(resolvedCommand)) {
    return { command: resolvedCommand, args, shell: false };
  }
  return {
    command: commandProcessor,
    args: ["/d", "/s", "/c", resolvedCommand, ...args],
    shell: false
  };
}
function spawnProcess(command, options) {
  const cwdValidation = validateCwd(options.cwd);
  if (!cwdValidation.valid) {
    throw new LspInvalidPathError(`[lsp] ${cwdValidation.error}`);
  }
  const [cmd] = command;
  if (!cmd) {
    throw new LspProcessSpawnError("[lsp] empty command");
  }
  const environment = subprocessEnvironment(options.env);
  const preparedCommand = createSpawnCommand(
    command,
    process.platform,
    environment["ComSpec"] ?? "cmd.exe",
    environment
  );
  const proc = childProcess.spawn(preparedCommand.command, preparedCommand.args, {
    ...HIDDEN_PROCESS,
    cwd: options.cwd,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    shell: preparedCommand.shell,
    detached: process.platform !== "win32"
  });
  return wrap(proc);
}
var terminating;
var init_process = __esm({
  "src/lsp/process.ts"() {
    "use strict";
    init_budgets();
    init_environment();
    init_process_options();
    init_cleanup_errors();
    init_errors();
    terminating = /* @__PURE__ */ new WeakSet();
  }
});

// src/lint-output.ts
function position(value, content) {
  const location = record(value["location"]) ? value["location"] : {};
  const span = location["span"];
  if (Array.isArray(span) && typeof span[0] === "number") {
    const before = Buffer.from(content).subarray(0, span[0]).toString("utf8").split("\n");
    return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
  }
  const start = record(location["start"]) ? location["start"] : {};
  const line = value["line"] ?? location["row"] ?? start["line"];
  const column = value["column"] ?? location["column"] ?? start["column"];
  return { line: typeof line === "number" ? line : 1, column: typeof column === "number" ? column : 1 };
}
function items(runner, data) {
  if (runner === "eslint" && Array.isArray(data))
    return data.flatMap((file) => record(file) && Array.isArray(file["messages"]) ? file["messages"] : []);
  if (runner === "ruff" && Array.isArray(data)) return data;
  if (runner === "biome" && record(data) && Array.isArray(data["diagnostics"])) {
    const summary = data["summary"];
    if (record(summary) && Number(summary["diagnosticsNotPrinted"]) > 0)
      throw new Error("Lint result truncated; narrow file scope");
    return data["diagnostics"];
  }
  throw new Error("Unexpected lint output");
}
function parseLint(runner, data, path, content) {
  const findings = [];
  for (const value of items(runner, data)) {
    if (!record(value)) throw new Error("Malformed lint finding");
    const severity = value["severity"];
    if (severity !== void 0 && ![1, 2, "error", "warning", "fatal"].includes(severity))
      continue;
    findings.push({
      path,
      ...position(value, content),
      severity: severity === 1 || severity === "warning" ? "warning" : "error",
      source: `${runner}/${text(value["ruleId"], text(value["code"], text(value["category"], "lint")))}`,
      message: text(value["description"], text(value["message"], "Lint finding"))
    });
  }
  return findings;
}
var init_lint_output = __esm({
  "src/lint-output.ts"() {
    "use strict";
    init_results();
  }
});

// src/log.ts
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir as homedir2, tmpdir } from "node:os";
import { join as join4 } from "node:path";
function logEvent(event) {
  queue = queue.then(async () => {
    const dir = join4(
      executionEnvironment()["CODEX_LSP_CACHE"] ?? join4(tmpdir(), `codex-lsp-${process.getuid?.() ?? hash(homedir2()).slice(0, 10)}`),
      "logs-v5"
    );
    await mkdir(dir, { recursive: true, mode: 448 });
    const path = join4(dir, `${instance}.log`);
    if ((await stat(path).catch(() => ({ size: 0 }))).size + 100 > 1024 * 1024) {
      await rm(`${path}.1`, { force: true });
      await rename(path, `${path}.1`);
    }
    await appendFile(path, `${(/* @__PURE__ */ new Date()).toISOString()} ${event}
`, { mode: 384 });
  }).catch(() => void 0);
  return queue;
}
var instance, queue;
var init_log = __esm({
  "src/log.ts"() {
    "use strict";
    init_environment();
    init_files();
    instance = `${process.pid}-${randomUUID()}`;
    queue = Promise.resolve();
  }
});

// src/prepared-tools.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat as lstat2, mkdir as mkdir2, readFile as readFile4, rename as rename2, writeFile } from "node:fs/promises";
import { homedir as homedir3 } from "node:os";
import { isAbsolute as isAbsolute4, join as join5 } from "node:path";
function directory() {
  return join5(executionEnvironment()["CODEX_HOME"] ?? join5(homedir3(), ".codex"), "cache", "codex-lsp-v5", "tools");
}
async function preparedRuff() {
  try {
    const value = JSON.parse(await readFile4(join5(directory(), "ruff.json"), "utf8"));
    if (!record(value) || typeof value["executable"] !== "string" || !isAbsolute4(value["executable"]))
      return void 0;
    await access(value["executable"], constants.X_OK);
    return value["executable"];
  } catch {
    return void 0;
  }
}
async function rememberRuff(executable3) {
  if (!isAbsolute4(executable3)) throw new Error("Invalid prepared Ruff path");
  await access(executable3, constants.X_OK);
  const dir = directory();
  await mkdir2(dir, { recursive: true, mode: 448 });
  const info = await lstat2(dir);
  if (info.isSymbolicLink() || process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 63) !== 0))
    throw new Error("Unsafe prepared-tool directory");
  const temporary2 = join5(dir, `${randomUUID2()}.tmp`);
  await writeFile(temporary2, JSON.stringify({ executable: executable3 }), { mode: 384 });
  await rename2(temporary2, join5(dir, "ruff.json"));
}
var init_prepared_tools = __esm({
  "src/prepared-tools.ts"() {
    "use strict";
    init_environment();
    init_results();
  }
});

// src/tool-resolution.ts
import { AsyncLocalStorage as AsyncLocalStorage2 } from "node:async_hooks";
import { constants as constants2 } from "node:fs";
import { access as access2, stat as stat2 } from "node:fs/promises";
import { basename as basename3, delimiter as delimiter2, dirname as dirname2, extname, isAbsolute as isAbsolute5, join as join6, resolve as resolve2 } from "node:path";
async function executable(path) {
  try {
    await access2(path, constants2.X_OK);
    return (await stat2(path)).isFile();
  } catch {
    return false;
  }
}
function suffixes(name) {
  return process.platform === "win32" && !/\.(?:exe|com|cmd|bat)$/i.test(name) ? [".exe", ".com", ".cmd", ".bat", ""] : [""];
}
async function pathExecutable(name) {
  for (const dir of (executionEnvironment()["PATH"] ?? "").split(delimiter2).filter(Boolean)) {
    for (const suffix of suffixes(name)) {
      const path = resolve2(dir, name + suffix);
      if (await executable(path)) return path;
    }
  }
  return void 0;
}
async function resolution(command, source, note) {
  const info = await stat2(command[0] ?? "").catch(() => void 0);
  return {
    command,
    source,
    identity: hash(JSON.stringify([command, source, info?.size, info?.mtimeMs, executionEnvironment()])),
    ...note ? { note } : {}
  };
}
function withToolResolution(action) {
  return requestTools.run(/* @__PURE__ */ new Map(), action);
}
function resolveTool(...args) {
  const cache = requestTools.getStore();
  const key = JSON.stringify([args[0], dirname2(resolve2(args[0], args[1])), ...args.slice(2)]);
  const existing = cache?.get(key);
  if (existing) return existing;
  const task = findTool(...args);
  cache?.set(key, task);
  return task;
}
async function findTool(root, path, command, explicit = false, allowTemporary = true) {
  const name = command[0];
  if (!name) throw new Error("Empty command");
  const executableName = basename3(name).replace(/\.(?:exe|cmd|bat)$/i, "");
  if (automaticExecution() && (["uvx", "npx", "pipx"].includes(executableName) || executableName === "uv" && command[1] === "tool" && command[2] === "run"))
    return resolution(
      [...command],
      "missing",
      `Automatic temporary launcher disabled: ${name}; install a local server or use explicit active MCP`
    );
  if (explicit) {
    const entry = isAbsolute5(name) || name.includes("/") || name.includes("\\") ? resolve2(root, name) : await pathExecutable(name);
    return resolution(
      [entry ?? name, ...command.slice(1)],
      entry && await executable(entry) ? "explicit" : "missing",
      entry && await executable(entry) ? void 0 : `Explicit command missing: ${name}; no fallback`
    );
  }
  let dir = dirname2(resolve2(root, path));
  while (inside(root, dir)) {
    for (const candidate of [
      ...suffixes(name).map(
        (suffix) => join6(dir, ".venv", process.platform === "win32" ? "Scripts" : "bin", name + suffix)
      ),
      ...suffixes(name).map((suffix) => join6(dir, "node_modules", ".bin", name + suffix))
    ])
      if (await executable(candidate)) return resolution([candidate, ...command.slice(1)], "project");
    if (dir === root) break;
    dir = dirname2(dir);
  }
  const local = await pathExecutable(name);
  if (local) return resolution([local, ...command.slice(1)], "PATH");
  const plan = temporary[name];
  if (allowTemporary && !automaticExecution() && plan) {
    if (plan.ecosystem === "python") {
      for (const [launcher, prefix] of [
        ["uvx", ["--isolated", "--from", plan.packages[0] ?? name]],
        ["uv", ["tool", "run", "--isolated", "--from", plan.packages[0] ?? name]],
        ["pipx", ["run", "--spec", plan.packages[0] ?? name]]
      ]) {
        const found = await pathExecutable(launcher);
        if (found)
          return resolution(
            [found, ...prefix, ...command],
            "temporary",
            "Available to attempt; initialization not verified"
          );
      }
    } else {
      const npx = await pathExecutable("npx");
      if (npx)
        return resolution(
          [npx, "--yes", ...plan.packages.flatMap((pkg) => ["--package", pkg]), "--", ...command],
          "temporary",
          "Available to attempt; initialization not verified"
        );
    }
  }
  return resolution(
    [...command],
    "missing",
    `Tool missing: ${name}; install locally and retry or use lsp_status refresh=true`
  );
}
function languageFor(config, path) {
  for (const [language, server2] of Object.entries(config.servers))
    if (server2 !== false && server2.extensions.includes(extname(path))) return { language, server: server2 };
  return void 0;
}
async function resolveServer(root, path, config) {
  const entry = languageFor(config, path);
  if (!entry) throw new Error(`Language disabled or unsupported: ${extname(path) || path}`);
  const tool2 = await resolveTool(root, path, entry.server.command, entry.server.explicit);
  return {
    language: entry.language,
    tool: tool2,
    server: {
      id: entry.server.id,
      command: tool2.command,
      extensions: [...entry.server.extensions],
      priority: 0,
      ...entry.server.env ? { env: { ...entry.server.env } } : {},
      ...entry.server.initialization ? { initialization: { ...entry.server.initialization } } : {}
    }
  };
}
function codeLanguage(config, path) {
  return languageFor(config, path)?.language ?? Object.entries(config.extensions).find(([, extensions]) => extensions.includes(extname(path)))?.[0];
}
var temporary, requestTools;
var init_tool_resolution = __esm({
  "src/tool-resolution.ts"() {
    "use strict";
    init_environment();
    init_files();
    temporary = {
      ty: { ecosystem: "python", packages: ["ty"] },
      ruff: { ecosystem: "python", packages: ["ruff"] },
      "pyright-langserver": { ecosystem: "python", packages: ["pyright"] },
      "basedpyright-langserver": { ecosystem: "python", packages: ["basedpyright"] },
      "typescript-language-server": { ecosystem: "npm", packages: ["typescript-language-server", "typescript@5.9.3"] },
      tsc: { ecosystem: "npm", packages: ["typescript@7.0.2"] },
      "bash-language-server": { ecosystem: "npm", packages: ["bash-language-server"] },
      "yaml-language-server": { ecosystem: "npm", packages: ["yaml-language-server"] },
      "vscode-html-language-server": { ecosystem: "npm", packages: ["vscode-langservers-extracted"] },
      "vscode-css-language-server": { ecosystem: "npm", packages: ["vscode-langservers-extracted"] },
      "vscode-json-language-server": { ecosystem: "npm", packages: ["vscode-langservers-extracted"] },
      svelteserver: { ecosystem: "npm", packages: ["svelte-language-server"] },
      "astro-ls": { ecosystem: "npm", packages: ["@astrojs/language-server", "typescript"] }
    };
    requestTools = new AsyncLocalStorage2();
  }
});

// src/runners.ts
import { spawn as spawn2 } from "node:child_process";
import { access as access3, readFile as readFile5, realpath as realpath3, stat as stat3, writeFile as writeFile2 } from "node:fs/promises";
import { basename as basename4, dirname as dirname3, extname as extname2, join as join7, relative as relative2, resolve as resolve3 } from "node:path";
async function run(command, args, cwd, signal, input, options = {}) {
  signal.throwIfAborted();
  const environment = subprocessEnvironment(options.environment ?? executionEnvironment());
  return new Promise((resolve12, reject) => {
    const prepared = createSpawnCommand([command, ...args], process.platform, environment["ComSpec"], environment);
    const child = spawn2(prepared.command, prepared.args, {
      ...HIDDEN_PROCESS,
      cwd,
      env: environment,
      shell: prepared.shell,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    const cancel = () => terminateProcessTree(child, "SIGKILL");
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    const timer = setTimeout(() => {
      exceeded = true;
      void logEvent("timeout");
      terminateProcessTree(child, "SIGKILL");
    }, options.timeout ?? BUDGET.runner);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > BUDGET.outputBytes) {
        exceeded = true;
        terminateProcessTree(child, "SIGKILL");
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4e3);
    });
    child.once("error", (error) => {
      void logEvent("startup-failure");
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      if (code !== 0 && code !== 1 && !signal.aborted) void logEvent("abnormal-exit");
      if (signal.aborted) reject(new Error("Runner cancelled"));
      else if (exceeded) reject(new Error("Runner exceeded time/output budget"));
      else resolve12({ stdout, stderr, code: code ?? -1 });
    });
    child.stdin.on("error", () => {
    });
    child.stdin.end(input);
  });
}
async function exists(path) {
  try {
    await access3(path);
    return true;
  } catch {
    return false;
  }
}
async function configured(root, path, names) {
  let dir = dirname3(path);
  while (inside(root, dir)) {
    for (const name of names) if (await exists(join7(dir, name))) return true;
    if (dir === root) break;
    dir = dirname3(dir);
  }
  return false;
}
async function executable2(root, target, packageName, entry) {
  let dir = dirname3(target);
  while (inside(root, dir)) {
    const path = join7(dir, "node_modules", packageName, entry);
    if (await exists(path)) return realpath3(path);
    const parent = dirname3(dir);
    if (dir === root) break;
    dir = parent;
  }
  return void 0;
}
async function javascriptRunner(root, path, name, packageName, entry) {
  const tool2 = await resolveTool(root, path, [name], false, false);
  if (tool2.source === "project") return { name, command: tool2.command[0] ?? name, prefix: [], source: "project" };
  const script = await executable2(root, path, packageName, entry);
  if (script) return { name, command: process.execPath, prefix: [script], source: "project" };
  if (tool2.source === "PATH") return { name, command: tool2.command[0] ?? name, prefix: [], source: "PATH" };
  throw new Error(`${name}: configured tool is not installed`);
}
async function select(root, path, formatting = false, provided, active = false, signal = new AbortController().signal) {
  const config = provided ?? await configuration(root);
  const extension = extname2(path);
  const choice = formatting ? "auto" : /\.pyi?$/.test(extension) ? config.python : config.javascript;
  if (choice === "off") return void 0;
  if (/\.pyi?$/.test(extension)) {
    let tool2 = await resolveTool(root, path, ["ruff"], false, false);
    if (tool2.source === "missing") {
      const prepared = await preparedRuff();
      if (prepared) return { name: "ruff", command: prepared, prefix: [], source: "prepared" };
      if (!active || automaticExecution() || !config.trusted)
        throw new Error(
          "Ruff unavailable: no local or prepared executable; run trusted active MCP diagnostics to prepare it. Hook never downloads tools"
        );
      tool2 = await resolveTool(root, path, ["ruff"]);
      if (tool2.source === "missing") throw new Error(tool2.note);
      const launcher = tool2.command[0] ?? "";
      if (/^uvx?(?:\.exe)?$/.test(basename4(launcher))) {
        const prepared2 = await run(
          launcher,
          [...tool2.command.slice(1, -1), "python", "-c", "import shutil; print(shutil.which('ruff') or '')"],
          root,
          signal
        );
        if (prepared2.code !== 0 || !prepared2.stdout.trim())
          throw new Error(`Ruff preparation failed: ${prepared2.stderr}`);
        await rememberRuff(prepared2.stdout.trim());
        return { name: "ruff", command: prepared2.stdout.trim(), prefix: [], source: "prepared" };
      }
    }
    return { name: "ruff", command: tool2.command[0] ?? "ruff", prefix: tool2.command.slice(1), source: tool2.source };
  }
  if (!/\.(?:[cm]?[jt]sx?|jsonc?|css)$/.test(path)) return void 0;
  if ((choice === "auto" || choice === "biome") && await configured(root, path, ["biome.json", "biome.jsonc"]))
    return javascriptRunner(root, path, "biome", "@biomejs/biome", "bin/biome");
  if ((choice === "auto" || choice === "eslint") && await configured(root, path, [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
    ".eslintrc.json",
    ".eslintrc.cjs"
  ]))
    return javascriptRunner(root, path, "eslint", "eslint", "bin/eslint.js");
  if (choice !== "auto") throw new Error(`${choice}: matching project configuration missing`);
  return void 0;
}
async function runnerIdentity(root, path, provided) {
  const config = provided ?? await configuration(root);
  if (!config.trusted) return "untrusted";
  try {
    const runner = await select(root, path, false, config);
    if (!runner) return "none";
    const identities = await Promise.all(
      [runner.command, ...runner.prefix.filter((value) => value.includes("/"))].map(async (command) => {
        const info = await stat3(command).catch(() => void 0);
        return [command, info?.size, info?.mtimeMs, info?.ino];
      })
    );
    return JSON.stringify([runner, identities]);
  } catch {
    return "unavailable";
  }
}
async function lintBatch(root, paths, signal, provided, active = false) {
  const config = provided ?? await configuration(root);
  const results = /* @__PURE__ */ new Map();
  if (!config.trusted) return results;
  const groups = /* @__PURE__ */ new Map();
  for (const path of paths) {
    try {
      const absolute = await workspacePath(root, path);
      const runner = languageFor(config, path) ? await select(root, absolute, false, config, active, signal) : void 0;
      if (!runner) {
        results.set(path, {
          path,
          state: "skipped",
          findings: [],
          note: "lint off or no matching Runner configuration"
        });
        continue;
      }
      let cwd = dirname3(absolute);
      while (cwd !== root && inside(root, cwd)) {
        const names = await import("node:fs/promises").then((fs) => fs.readdir(cwd));
        if (names.some((name) => configurationImpact(name).includes("lint"))) break;
        cwd = dirname3(cwd);
      }
      const key = JSON.stringify([
        runner,
        cwd,
        await runnerIdentity(root, absolute, config),
        executionEnvironment()
      ]);
      const group = groups.get(key) ?? { runner, cwd, paths: [] };
      group.paths.push(path);
      groups.set(key, group);
    } catch (error) {
      results.set(path, { path, state: "failed", findings: [], note: `lint: ${message(error)}` });
    }
  }
  for (const { runner, cwd, paths: members } of groups.values()) {
    const batches = [];
    let batch = [];
    let bytes = 0;
    for (const path of members) {
      const size = Buffer.byteLength(resolve3(root, path)) + 3;
      if (batch.length && bytes + size > BUDGET.argvBytes) {
        batches.push(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(path);
      bytes += size;
    }
    if (batch.length) batches.push(batch);
    for (const paths2 of batches) {
      try {
        const args = runner.name === "biome" ? ["lint", "--reporter=json", "--max-diagnostics=none"] : runner.name === "eslint" ? ["--format", "json"] : ["check", "--no-fix", "--no-fix-only", "--no-cache", "--output-format", "json", "--"];
        const output = await measured(
          "lint",
          () => run(
            runner.command,
            [...runner.prefix, ...args, ...paths2.map((path) => resolve3(root, path))],
            cwd,
            signal
          )
        );
        if (output.code !== 0 && output.code !== 1) throw new Error(output.stderr || `Runner exit ${output.code}`);
        const data = JSON.parse(output.stdout);
        const split = splitLint(runner.name, data, root, cwd);
        for (const path of paths2)
          results.set(path, {
            path,
            state: "complete",
            findings: parseLint(
              runner.name,
              split.get(path) ?? (runner.name === "biome" ? { diagnostics: [] } : []),
              path,
              await readFile5(resolve3(root, path), "utf8")
            )
          });
      } catch (error) {
        for (const path of paths2)
          results.set(path, {
            path,
            state: signal.aborted ? "pending" : "failed",
            findings: [],
            note: `lint: ${message(error)}`
          });
      }
    }
  }
  return results;
}
function splitLint(runner, data, root, cwd) {
  const grouped = /* @__PURE__ */ new Map();
  const items2 = runner === "biome" && record(data) ? data["diagnostics"] : data;
  if (!Array.isArray(items2)) throw new Error("Unexpected lint output");
  if (runner === "biome" && record(data) && record(data["summary"]) && Number(data["summary"]["diagnosticsNotPrinted"]) > 0)
    throw new Error("Lint result truncated");
  for (const item of items2) {
    if (!record(item)) throw new Error("Malformed lint result");
    const location = record(item["location"]) ? item["location"] : {};
    const biomePath = record(location["path"]) ? location["path"]["file"] : location["path"];
    const file = runner === "eslint" ? item["filePath"] : runner === "ruff" ? item["filename"] : biomePath;
    if (typeof file !== "string") throw new Error("Lint result has no file path");
    const path = relative2(root, resolve3(cwd, file));
    if (!inside(root, resolve3(root, path))) throw new Error("Lint result outside workspace");
    const values = grouped.get(path) ?? [];
    values.push(item);
    grouped.set(path, values);
  }
  return new Map([...grouped].map(([path, items3]) => [path, runner === "biome" ? { diagnostics: items3 } : items3]));
}
async function formatWithRunner(root, path, signal, provided) {
  const config = provided ?? await configuration(root);
  if (!config.trusted) return void 0;
  const absolute = await workspacePath(root, path);
  const runner = await select(root, absolute, true, config, true, signal);
  if (!runner || runner.name === "eslint") return void 0;
  const before = await readFile5(absolute, "utf8");
  const args = runner.name === "biome" ? ["format", `--stdin-file-path=${absolute}`] : ["format", "--no-cache", "--stdin-filename", absolute, "-"];
  const result = await run(runner.command, [...runner.prefix, ...args], dirname3(absolute), signal, before);
  if (result.code !== 0) throw new Error(result.stderr || "Format failed");
  if (await readFile5(absolute, "utf8") !== before) throw new Error("File changed during format; retry");
  if (before === result.stdout) return { status: "unchanged", path, modifiedPaths: [] };
  signal.throwIfAborted();
  await writeFile2(absolute, result.stdout);
  return { status: "formatted", path, modifiedPaths: [path] };
}
async function preflightRunner(root, path, config, signal) {
  if (!config.trusted) {
    if (/\.pyi?$/.test(path)) throw new Error("Python formatting with Ruff requires workspace trust");
    return false;
  }
  const runner = await select(root, await workspacePath(root, path), true, config, true, signal);
  if (!runner || runner.name === "eslint") return false;
  const result = await run(runner.command, [...runner.prefix, "--version"], root, signal);
  if (result.code !== 0) throw new Error(`${runner.name} preflight failed: ${result.stderr}`);
  return true;
}
var init_runners = __esm({
  "src/runners.ts"() {
    "use strict";
    init_budgets();
    init_config();
    init_config_files();
    init_environment();
    init_process();
    init_config();
    init_files();
    init_lint_output();
    init_log();
    init_metrics();
    init_prepared_tools();
    init_process_options();
    init_results();
    init_tool_resolution();
  }
});

// src/identity.ts
import { readdir as readdir2, readFile as readFile6, stat as stat4 } from "node:fs/promises";
import { dirname as dirname4, extname as extname3, join as join8, resolve as resolve4 } from "node:path";
async function analysisIdentity(root, paths, config, signal, lsp = true) {
  const dirs = /* @__PURE__ */ new Set();
  const runners = /* @__PURE__ */ new Map();
  for (const path of paths) {
    signal.throwIfAborted();
    const absolute = resolve4(root, path);
    const key = `${dirname4(absolute)}:${extname3(path)}`;
    if (!runners.has(key)) runners.set(key, await runnerIdentity(root, absolute, config));
    let dir = dirname4(absolute);
    while (inside(root, dir)) {
      dirs.add(dir);
      if (dir === root) break;
      dir = dirname4(dir);
    }
  }
  const contents = [];
  const languages = paths.map((path) => codeLanguage(config, path));
  const scoped = languages.every((language) => ["typescript", "python", "cpp", "rust", "go"].includes(language ?? ""));
  for (const dir of [...dirs].sort()) {
    const names = [
      .../* @__PURE__ */ new Set([...configNames(), ...(await readdir2(dir)).filter((name) => configurationImpact(name).length)])
    ];
    for (const name of names) {
      if (!configurationImpact(name).some((impact) => impact === "types" || impact === "lint")) continue;
      const affected = configurationLanguages(name);
      if (scoped && affected.length && !affected.some((language) => languages.includes(language))) continue;
      signal.throwIfAborted();
      const path = join8(dir, name);
      try {
        if ((await stat4(path)).size > 1024 * 1024) throw new Error("Tool configuration exceeds 1 MiB");
        contents.push(path, hash(await readFile6(path, { encoding: "utf8", signal })));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }
  const representatives = [...new Map(paths.map((path) => [`${dirname4(path)}:${extname3(path)}`, path])).values()];
  const servers = lsp ? await Promise.all(
    representatives.map((path) => resolveServer(root, path, config).catch((error) => String(error)))
  ) : [];
  return hash(JSON.stringify([config.version, executionEnvironment(), contents, [...runners].sort(), servers]));
}
var init_identity = __esm({
  "src/identity.ts"() {
    "use strict";
    init_config_files();
    init_environment();
    init_files();
    init_runners();
    init_tool_resolution();
  }
});

// src/directory-lock.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir as mkdir3, readFile as readFile7, rename as rename3, rm as rm2, writeFile as writeFile3 } from "node:fs/promises";
import { join as join9 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
function alive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)?.split(" ")[0];
      if (state === "Z" || state === "X") return false;
    }
    return true;
  } catch (error) {
    return !(record(error) && ["ESRCH", "ENOENT"].includes(String(error["code"])));
  }
}
async function directoryLock(lock, signal, budget = BUDGET.lock) {
  const nonce = randomUUID3();
  const candidate = `${lock}.claim-${nonce}`;
  await mkdir3(candidate, { mode: 448 });
  await writeFile3(join9(candidate, "owner"), JSON.stringify({ pid: process.pid, nonce }), { mode: 384 });
  const deadline = Date.now() + budget;
  try {
    while (true) {
      signal.throwIfAborted();
      try {
        await rename3(candidate, lock);
        break;
      } catch (error) {
        if (!record(error) || !["EEXIST", "ENOTEMPTY", "EPERM"].includes(String(error["code"]))) throw error;
        const raw = await readFile7(join9(lock, "owner"), "utf8").catch(() => "{}");
        const owner = JSON.parse(raw);
        if (record(owner) && typeof owner["pid"] === "number" && typeof owner["nonce"] === "string" && !alive(owner["pid"]) && await readFile7(join9(lock, "owner"), "utf8").catch(() => "") === raw)
          await rename3(lock, `${lock}.abandoned-${owner["nonce"]}`).catch(() => void 0);
        if (Date.now() >= deadline) throw new Error("Directory lock busy; retry");
        await delay(10, void 0, { signal });
      }
    }
  } finally {
    await rm2(candidate, { recursive: true, force: true });
  }
  return async () => {
    const released = `${lock}.released-${nonce}`;
    await rename3(lock, released);
    await rm2(released, { recursive: true, force: true });
  };
}
var init_directory_lock = __esm({
  "src/directory-lock.ts"() {
    "use strict";
    init_budgets();
    init_results();
  }
});

// src/service-identity.ts
import { readFile as readFile8, realpath as realpath4 } from "node:fs/promises";
import { homedir as homedir4 } from "node:os";
import { resolve as resolve5 } from "node:path";
function bundleIdentity() {
  bundle ??= readFile8(new URL(import.meta.url), "utf8").then(hash);
  return bundle;
}
async function workspaceIdentity(root) {
  const home = resolve5(executionEnvironment()["CODEX_HOME"] ?? resolve5(homedir4(), ".codex"));
  return hash(
    JSON.stringify([
      process.getuid?.() ?? homedir4(),
      await realpath4(root),
      await realpath4(home).catch(() => home),
      await bundleIdentity(),
      SERVICE_PROTOCOL
    ])
  );
}
var SERVICE_PROTOCOL, bundle;
var init_service_identity = __esm({
  "src/service-identity.ts"() {
    "use strict";
    init_environment();
    init_files();
    SERVICE_PROTOCOL = 1;
  }
});

// src/metadata.ts
import { randomUUID as randomUUID4 } from "node:crypto";
import { lstat as lstat3, mkdir as mkdir4, readdir as readdir3, readFile as readFile9, realpath as realpath5, rename as rename4, rm as rm3, writeFile as writeFile4 } from "node:fs/promises";
import { homedir as homedir5, tmpdir as tmpdir2 } from "node:os";
import { join as join10 } from "node:path";
var empty, Metadata;
var init_metadata = __esm({
  "src/metadata.ts"() {
    "use strict";
    init_directory_lock();
    init_environment();
    init_files();
    init_results();
    init_service_identity();
    empty = (id) => ({
      id,
      epoch: hash(`initial:${id}`),
      outbox: {},
      version: 0,
      generation: 0,
      configuration: "",
      pendingChannels: { lsp: [], lint: [] },
      automaticScope: "delta",
      turn: "",
      baseline: null,
      diagnosticBaseline: null,
      edited: false,
      unresolved: {},
      touched: [],
      current: [],
      pending: [],
      delivery: [],
      shown: {},
      blocked: []
    });
    Metadata = class {
      constructor(root) {
        this.root = root;
      }
      async dir() {
        const user = process.getuid?.() ?? hash(homedir5()).slice(0, 10);
        const base = join10(
          executionEnvironment()["CODEX_LSP_CACHE"] ?? join10(tmpdir2(), `codex-lsp-${user}`),
          `metadata-v7-${user}`
        );
        await mkdir4(base, { recursive: true, mode: 448 });
        const info = await lstat3(base);
        if (info.isSymbolicLink() || process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 63) !== 0))
          throw new Error("Unsafe metadata permissions");
        const dir = join10(base, await workspaceIdentity(await realpath5(this.root)));
        await mkdir4(dir, { recursive: true, mode: 448 });
        if ((await lstat3(dir)).isSymbolicLink()) throw new Error("Unsafe metadata directory");
        return dir;
      }
      async load(path, id) {
        try {
          const data = JSON.parse(await readFile9(path, "utf8"));
          if (!record(data) || data["id"] !== id || typeof data["version"] !== "number" || typeof data["turn"] !== "string" || typeof data["generation"] !== "number" || typeof data["configuration"] !== "string" || !record(data["pendingChannels"]) || typeof data["edited"] !== "boolean" || !["delta", "full"].includes(String(data["automaticScope"])))
            throw new Error("Invalid metadata");
          for (const key of ["touched", "current", "pending", "delivery", "blocked"])
            if (!Array.isArray(data[key]) || !data[key].every((item) => typeof item === "string"))
              throw new Error("Invalid metadata");
          for (const key of ["baseline", "diagnosticBaseline"])
            if (data[key] !== null && (typeof data[key] !== "string" || !/^[a-f0-9]{64}$/.test(String(data[key]))))
              throw new Error("Invalid baseline reference");
          if (!record(data["unresolved"]) || !Object.values(data["unresolved"]).every(
            (items2) => Array.isArray(items2) && items2.every(
              (item) => record(item) && typeof item["path"] === "string" && typeof item["source"] === "string" && typeof item["message"] === "string" && typeof item["line"] === "number" && typeof item["column"] === "number" && ["error", "warning", "information", "hint"].includes(String(item["severity"]))
            )
          ))
            throw new Error("Invalid unresolved diagnostics");
          for (const key of ["shown"])
            if (!(key === "baseline" && data[key] === null) && (!record(data[key]) || !Object.values(data[key]).every((item) => typeof item === "string")))
              throw new Error("Invalid metadata");
          const channels = data["pendingChannels"];
          if (!record(channels) || ![channels["lsp"], channels["lint"]].every(
            (paths) => Array.isArray(paths) && paths.every((path2) => typeof path2 === "string")
          ))
            throw new Error("Invalid channel metadata");
          data["epoch"] ??= "legacy";
          data["outbox"] ??= {};
          if (typeof data["epoch"] !== "string" || !record(data["outbox"]) || !Object.values(data["outbox"]).every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)))
            throw new Error("Invalid delivery metadata");
          return data;
        } catch (error) {
          if (record(error) && error["code"] === "ENOENT") return empty(id);
          throw error;
        }
      }
      async read(id) {
        return this.load(join10(await this.dir(), `${hash(id)}.json`), id);
      }
      async ids() {
        const dir = await this.dir();
        const ids = [];
        for (const file of await readdir3(dir))
          if (file.endsWith(".json")) {
            try {
              const value = JSON.parse(await readFile9(join10(dir, file), "utf8"));
              if (record(value) && typeof value["id"] === "string" && value["turn"] !== "__ended__")
                ids.push(value["id"]);
            } catch {
            }
          }
        return ids.sort();
      }
      async shared(value) {
        const content = JSON.stringify(value);
        const reference = hash(content);
        const dir = join10(await this.dir(), "shared");
        await mkdir4(dir, { recursive: true, mode: 448 });
        const path = join10(dir, `${reference}.json`);
        await writeFile4(path, content, { mode: 384, flag: "wx" }).catch((error) => {
          if (!record(error) || error["code"] !== "EEXIST") throw error;
        });
        return reference;
      }
      async readShared(reference) {
        if (!/^[a-f0-9]{64}$/.test(reference)) throw new Error("Invalid shared reference");
        const content = await readFile9(join10(await this.dir(), "shared", `${reference}.json`), "utf8");
        if (hash(content) !== reference) throw new Error("Shared snapshot integrity mismatch");
        return JSON.parse(content);
      }
      async update(id, signal, change) {
        signal.throwIfAborted();
        const dir = await this.dir();
        const path = join10(dir, `${hash(id)}.json`);
        const lock = `${path}.lock`;
        const nonce = randomUUID4();
        const temp = `${path}.${nonce}.tmp`;
        const release = await directoryLock(lock, signal);
        try {
          const state = await this.load(path, id);
          signal.throwIfAborted();
          if (await change(state) === false) return state;
          state.version++;
          for (const key of ["touched", "current", "pending", "delivery", "blocked"])
            state[key] = [...new Set(state[key])];
          await writeFile4(temp, JSON.stringify(state), { mode: 384 });
          await rename4(temp, path);
          return state;
        } finally {
          await rm3(temp, { force: true });
          await release();
        }
      }
      async end(id, signal) {
        await this.update(id, signal, (state) => {
          Object.assign(state, { ...empty(id), version: state.version, generation: state.generation + 1 });
          state.epoch = randomUUID4();
          state.turn = "__ended__";
        });
      }
    };
  }
});

// src/hook-delivery.ts
import { readFile as readFile10 } from "node:fs/promises";
async function queueDelivery(store, state, output, bindings, configuration2, analysis) {
  if (output.kind !== "context" && output.kind !== "block") return;
  const content = output.kind === "context" ? output.context : output.reason;
  const pages = [];
  let page = "";
  for (const line of content.split("\n")) {
    if (page && Buffer.byteLength(`${page}
${line}`) > 3500) {
      pages.push(page);
      page = "";
    }
    page += `${page ? "\n" : ""}${line}`;
  }
  if (page) pages.push(page);
  for (const [index, value] of pages.entries()) {
    const delivery = {
      epoch: state.epoch,
      generation: state.generation,
      turn: state.turn,
      configuration: configuration2,
      analysis,
      bindings,
      output: output.kind === "context" ? { ...output, context: value } : { ...output, reason: value }
    };
    const id = `${output.kind === "block" ? "block-" : ""}${hash(JSON.stringify([delivery, index])).slice(0, 24)}`;
    state.outbox[id] = await store.shared(delivery);
  }
}
async function consumeDelivery(root, session, event, signal) {
  const store = new Metadata(root);
  const state = await store.read(session);
  const config = await configuration(root);
  if (!config.trusted || state.turn === "__ended__" || (event === "Stop" || event === "SubagentStop" ? config.automaticDiagnostics.stop : config.automaticDiagnostics.postToolUse) === "off")
    return { output: { kind: "silent" } };
  const entries = Object.entries(state.outbox);
  if (event === "Stop" || event === "SubagentStop")
    entries.sort(([a], [b]) => Number(!a.startsWith("block-")) - Number(!b.startsWith("block-")));
  for (const [id, reference] of entries) {
    signal.throwIfAborted();
    const value = await store.readShared(reference);
    if (!record(value) || !record(value["bindings"]) || !record(value["output"]))
      throw new Error("Invalid diagnostic delivery");
    const item = value;
    const paths = Object.keys(item.bindings);
    let fresh = item.epoch === state.epoch && item.generation === state.generation && item.configuration === config.version;
    if (fresh && paths.length) {
      for (const path of paths) {
        signal.throwIfAborted();
        try {
          if (hash(await readFile10(await workspacePath(root, path), { encoding: "utf8", signal })) !== item.bindings[path])
            fresh = false;
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          fresh = false;
        }
      }
      if (fresh) fresh = item.analysis === await analysisIdentity(root, paths, config, signal);
    }
    if (!fresh) {
      await store.update(session, signal, (current2) => {
        if (current2.outbox[id] !== reference) return false;
        delete current2.outbox[id];
        if (current2.epoch === item.epoch && current2.turn !== "__ended__") current2.pending.push(...paths);
        return true;
      });
      continue;
    }
    if (item.output.kind === "block" && state.turn !== item.turn) {
      await acknowledgeDelivery(root, session, id, signal);
      continue;
    }
    if (item.output.kind === "block" && event !== "Stop" && event !== "SubagentStop") continue;
    const current = await store.read(session);
    if (current.epoch !== state.epoch || current.generation !== state.generation || current.outbox[id] !== reference)
      return { output: { kind: "silent" } };
    const marker = `[Codex CodeIntel automatic diagnostics] deliveryId=${id}; sourceTurn=${item.turn || "unknown"}
`;
    return {
      deliveryId: id,
      output: item.output.kind === "block" ? { kind: "block", reason: marker + item.output.reason } : item.output.kind === "context" ? { kind: "context", event, context: marker + item.output.context } : item.output
    };
  }
  return { output: { kind: "silent" } };
}
async function acknowledgeDelivery(root, session, id, signal) {
  await new Metadata(root).update(session, signal, (state) => {
    if (!state.outbox[id]) return false;
    delete state.outbox[id];
    return true;
  });
}
var init_hook_delivery = __esm({
  "src/hook-delivery.ts"() {
    "use strict";
    init_config();
    init_files();
    init_identity();
    init_metadata();
    init_results();
  }
});

// src/write-intent.ts
import { isAbsolute as isAbsolute6, relative as relative3, resolve as resolve6 } from "node:path";
function isShellTool(input) {
  return /^(?:bash|shell|exec_command|unified_exec)$/.test(
    text(input["tool_name"]).split(".").at(-1)?.toLowerCase() ?? ""
  );
}
function writeIntent(root, input) {
  const tool2 = text(input["tool_name"]);
  const args = record(input["tool_input"]) ? input["tool_input"] : {};
  let paths = [];
  if (/apply_patch|Edit|Write|write_file|lsp_format|lsp_rename/.test(tool2)) {
    if (/lsp_rename/.test(tool2)) return { kind: "write" };
    const command = typeof input["tool_input"] === "string" ? input["tool_input"] : text(args["command"], text(args["patch"]));
    paths.push(
      ...[...command.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(
        (match) => match[1] ?? ""
      )
    );
    paths.push(
      ...[args["path"], args["file_path"], ...Array.isArray(args["paths"]) ? args["paths"] : []].filter(
        (path) => typeof path === "string"
      )
    );
  } else if (isShellTool(input)) {
    const command = text(args["command"], text(args["cmd"])).trim();
    if (!/[<>;|&`\n]|\$\(|\$\{/.test(command) && /^(?:pwd|ls(?:\s|$)|rg(?:\s|$)|cat(?:\s|$)|head(?:\s|$)|tail(?:\s|$)|wc(?:\s|$)|Get-(?:Content|ChildItem|Location|Item)(?:\s|$)|Select-String(?:\s|$)|git (?:status|diff|log|show|ls-files|rev-parse)(?:\s|$))/i.test(
      command
    ) && !/--(?:output|ext-diff|textconv|pre)|--exec/.test(command))
      return { kind: "read" };
    return { kind: "write" };
  } else if (/read|search|list|status|diagnostics|check_project|navigation|glob|view_image/i.test(tool2))
    return { kind: "read" };
  else return { kind: "write" };
  if (!paths.length) return { kind: "write" };
  paths = [
    ...new Set(
      paths.map((path) => {
        const absolute = isAbsolute6(path) ? path : resolve6(root, path);
        if (!inside(root, absolute)) throw new Error("Write target outside workspace");
        return relative3(root, absolute);
      })
    )
  ];
  return paths.every((path) => configurationImpact(path).length) ? { kind: "configuration", paths } : { kind: "write", paths };
}
var init_write_intent = __esm({
  "src/write-intent.ts"() {
    "use strict";
    init_config_files();
    init_files();
    init_results();
  }
});

// src/hook-engine.ts
import { readFile as readFile11 } from "node:fs/promises";
function renderHook(output) {
  if (output.kind === "silent") return void 0;
  if (output.kind === "block") return { decision: "block", reason: output.reason };
  if (output.kind === "deny")
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: output.reason
      }
    };
  return output.event === "Stop" || output.event === "SubagentStop" || output.event === "SessionStart" ? { systemMessage: output.context } : { hookSpecificOutput: { hookEventName: output.event, additionalContext: output.context } };
}
var HookEngine;
var init_hook_engine = __esm({
  "src/hook-engine.ts"() {
    "use strict";
    init_budgets();
    init_config();
    init_config_files();
    init_diagnostic_delta();
    init_environment();
    init_files();
    init_hook_delivery();
    init_identity();
    init_metadata();
    init_results();
    init_tool_resolution();
    init_write_intent();
    HookEngine = class {
      constructor(root, dependencies) {
        this.root = root;
        this.dependencies = dependencies;
        this.queue = Promise.resolve();
        this.store = new Metadata(root);
      }
      hook(input, signal, background = false) {
        const event = text(input["hook_event_name"], "PostToolUse");
        if (event === "PreToolUse" && (isShellTool(input) || writeIntent(this.root, input).kind !== "write"))
          return Promise.resolve({ kind: "silent" });
        const task = event === "SessionEnd" ? this.prepare(input, signal, background) : this.queue.then(() => this.prepare(input, signal, background));
        this.queue = task.then(
          () => void 0,
          () => void 0
        );
        return task.then(async (prepared) => {
          if (typeof prepared === "function") return prepared();
          if (prepared.kind === "context" && text(input["session_id"])) {
            const config = await configuration(this.root);
            await this.store.update(text(input["session_id"]), signal, async (state) => {
              if (state.turn === "__ended__") return false;
              await queueDelivery(this.store, state, prepared, {}, config.version, "");
              return true;
            });
          }
          return prepared;
        });
      }
      async prepare(input, signal, background) {
        const began = Date.now();
        signal.throwIfAborted();
        const id = text(input["session_id"]);
        const event = text(input["hook_event_name"], "PostToolUse");
        const stopping = event === "Stop" || event === "SubagentStop";
        const context = (value) => ({ kind: "context", event, context: `session=${id}
${value}` });
        if (!id)
          return event === "PreToolUse" ? { kind: "deny", reason: "Codex CodeIntel: missing session_id; cannot establish a pre-edit baseline" } : context("Codex CodeIntel: missing session_id");
        if (event === "SessionEnd") {
          await this.store.end(id, signal);
          this.dependencies.end(id);
          return { kind: "silent" };
        }
        if (stopping && input["stop_hook_active"] === true) return { kind: "silent" };
        const initial = await this.store.read(id);
        if (initial.turn === "__ended__" && event !== "SessionStart") return { kind: "silent" };
        const config = await configuration(this.root);
        if (config.automaticDiagnostics.postToolUse === "off" && config.automaticDiagnostics.stop === "off")
          return { kind: "silent" };
        const turn = text(input["turn_id"], initial.turn);
        await this.store.update(id, signal, (state2) => {
          if (state2.epoch !== initial.epoch || state2.turn === "__ended__" && event !== "SessionStart") return false;
          if (event === "SessionStart" && state2.turn === "__ended__") state2.turn = "";
          if (turn !== state2.turn) {
            state2.turn = turn;
            state2.current = [];
            state2.blocked = [];
          }
          return true;
        });
        if (event === "SessionStart" || event === "PreToolUse") {
          const intent2 = event === "SessionStart" ? { kind: "read" } : writeIntent(this.root, input);
          if (intent2.kind === "configuration") return { kind: "silent" };
          try {
            const baseline = await this.dependencies.projects.baseline(
              id,
              intent2.kind === "write" ? intent2.paths : [],
              executionEnvironment(),
              signal,
              intent2.kind === "write" ? Math.max(1, BUDGET.postWait - (Date.now() - began)) : 0
            );
            if (intent2.kind === "write" && (baseline.failures.length || baseline.pending.length))
              return {
                kind: "deny",
                reason: `Codex CodeIntel: pre-edit baseline unavailable. ${baseline.failures.join("; ")}${baseline.pending.length ? ` Pending: ${baseline.pending.join(", ")}; retry after check_project run=cached.` : ""} Repair checker configuration or set both automaticDiagnostics modes to off.`
              };
            if (!initial.baseline) {
              const snapshot2 = await inventory(this.root, BUDGET.files, signal, config.exclude);
              const reference = await this.store.shared(Object.fromEntries(snapshot2.files));
              await this.store.update(id, signal, (state2) => {
                if (state2.epoch !== initial.epoch || state2.turn === "__ended__") return false;
                state2.baseline ??= reference;
                return true;
              });
            }
            return { kind: "silent" };
          } catch (error) {
            return intent2.kind === "write" ? { kind: "deny", reason: `Codex CodeIntel: pre-edit baseline unavailable: ${message(error)}` } : context(`Baseline pending: ${message(error)}`);
          }
        }
        const stateBefore = await this.store.read(id);
        if (!stateBefore.baseline || !stateBefore.diagnosticBaseline) {
          if (event === "PostToolUse" && !isShellTool(input) && writeIntent(this.root, input).kind === "write")
            await this.store.update(id, signal, (current) => {
              current.edited = true;
            });
          return context(
            "Pre-edit baseline missing; current diagnostics cannot be treated as an edit baseline. Run SessionStart/PreToolUse before editing, or disable automatic diagnostics."
          );
        }
        const previous = await this.store.readShared(stateBefore.baseline);
        if (!record(previous)) throw new Error("Invalid shared snapshot");
        const intent = writeIntent(this.root, input);
        const forced = intent.kind === "write" || intent.kind === "configuration" ? intent.paths ?? [] : [];
        const snapshot = await inventory(this.root, BUDGET.files, signal, config.exclude, this.root, false, forced);
        if (!snapshot.complete)
          return context("Change discovery incomplete; pending and unresolved diagnostics retained");
        const changed = [...snapshot.files].filter(([path, content]) => previous[path] !== content).map(([path]) => path);
        const deleted = Object.keys(previous).filter((path) => !snapshot.files.has(path));
        const sourcePaths = changed.filter((path) => codeLanguage(config, path) && !configurationImpact(path).length);
        const snapshotReference = await this.store.shared(Object.fromEntries(snapshot.files));
        const state = await this.store.update(id, signal, (current) => {
          if (current.generation !== stateBefore.generation || current.epoch !== stateBefore.epoch) return false;
          if (changed.length || deleted.length) current.generation++;
          if (sourcePaths.length || deleted.some((path) => codeLanguage(config, path))) current.edited = true;
          current.baseline = snapshotReference;
          current.touched = [.../* @__PURE__ */ new Set([...current.touched, ...sourcePaths])].filter(
            (path) => snapshot.files.has(path)
          );
          current.current = [.../* @__PURE__ */ new Set([...current.current, ...sourcePaths])].filter(
            (path) => snapshot.files.has(path)
          );
          current.pending = [.../* @__PURE__ */ new Set([...current.pending, ...sourcePaths])].filter(
            (path) => snapshot.files.has(path)
          );
          current.delivery = [.../* @__PURE__ */ new Set([...current.delivery, ...sourcePaths])].filter(
            (path) => snapshot.files.has(path)
          );
          for (const path of deleted) {
            const moved = changed.find(
              (next) => snapshot.files.get(next) === previous[path] && previous[next] === void 0
            );
            if (moved && current.unresolved[path])
              current.unresolved[moved] = current.unresolved[path].map((finding) => ({ ...finding, path: moved }));
            delete current.unresolved[path];
            delete current.shown[path];
          }
          return true;
        });
        if ((stopping ? config.automaticDiagnostics.stop : config.automaticDiagnostics.postToolUse) === "off")
          return { kind: "silent" };
        const paths = stopping ? [.../* @__PURE__ */ new Set([...state.current, ...state.pending])] : [.../* @__PURE__ */ new Set([...state.pending, ...state.delivery])];
        if (!paths.length) return { kind: "silent" };
        const reliable = await this.dependencies.projects.baseline(id, paths, executionEnvironment(), signal, 0);
        if (reliable.failures.length || reliable.pending.length) {
          if (isShellTool(input) && !stateBefore.edited && reliable.failures.some((failure) => failure.includes("Project changed while establishing baseline"))) {
            await this.store.update(id, signal, (current) => {
              if (current.epoch !== state.epoch || current.generation !== state.generation) return false;
              current.diagnosticBaseline = null;
              delete current.shown["baselineJob"];
              current.edited = false;
              return true;
            });
          }
          return context(
            `Pre-edit diagnostic baseline is not reliable; introduced errors cannot be attributed. ${reliable.failures.join("; ")} Pending: ${reliable.pending.join(", ")}`
          );
        }
        state.diagnosticBaseline = reliable.reference;
        return async () => {
          const output = await this.dependencies.check(
            paths,
            id,
            turn,
            state.generation,
            Math.max(
              1,
              (background ? BUDGET.project : stopping ? BUDGET.stopWait : BUDGET.postWait) - (Date.now() - began)
            ),
            signal
          );
          if (output.generation !== state.generation) return context("Stale diagnostic generation; pending retained");
          const baselineData = await this.store.readShared(state.diagnosticBaseline ?? "");
          const baseline = record(baselineData) && Array.isArray(baselineData["results"]) ? baselineData["results"].flatMap(
            (item) => record(item) && Array.isArray(item["findings"]) ? item["findings"] : []
          ) : [];
          const ledgerValue = state.shown["diagnosticCurrent"] ? await this.store.readShared(state.shown["diagnosticCurrent"]) : void 0;
          const ledger = record(ledgerValue) ? ledgerValue : {};
          for (const old of deleted) {
            const moved = changed.find(
              (path) => snapshot.files.get(path) === previous[old] && previous[path] === void 0
            );
            if (moved)
              ledger[moved] = (ledger[old] ?? baseline.filter((finding) => finding.path === old)).map((finding) => ({
                ...finding,
                path: moved
              }));
            delete ledger[old];
          }
          const valid = [];
          for (const result of output.results) {
            try {
              if (hash(await readFile11(await workspacePath(this.root, result.path), "utf8")) === snapshot.files.get(result.path))
                valid.push(result);
            } catch {
            }
          }
          let feedback = { kind: "silent" };
          const bindings = Object.fromEntries(
            valid.map((result) => [result.path, snapshot.files.get(result.path) ?? ""])
          );
          const analysis = valid.length ? await analysisIdentity(
            this.root,
            valid.map((result) => result.path),
            config,
            signal
          ) : "";
          await this.store.update(id, signal, async (current) => {
            if (current.generation !== state.generation || current.epoch !== state.epoch) return false;
            const fresh = [];
            const repaired = [];
            for (const result of valid) {
              const preceding = ledger[result.path] ?? baseline.filter((finding) => finding.path === result.path);
              const added = addedFindings(preceding, result.findings);
              const previousIssues = current.unresolved[result.path] ?? [];
              if (result.state === "complete") {
                const historical = addedFindings(previousIssues, preceding);
                current.unresolved[result.path] = addedFindings(historical, result.findings);
                ledger[result.path] = result.findings;
                current.pending = current.pending.filter((path) => path !== result.path);
                current.delivery = current.delivery.filter((path) => path !== result.path);
                if (previousIssues.length > (current.unresolved[result.path]?.length ?? 0))
                  repaired.push(
                    `${result.path}: ${previousIssues.length - (current.unresolved[result.path]?.length ?? 0)} introduced diagnostics repaired`
                  );
              } else {
                current.unresolved[result.path] = [...previousIssues, ...addedFindings(previousIssues, added)];
              }
              const signature = hash(JSON.stringify(added.map(diagnosticKey)));
              if ((added.length || result.state !== "complete") && current.shown[result.path] !== signature)
                fresh.push({ ...result, findings: added });
              current.shown[result.path] = signature;
            }
            const unresolved = Object.entries(current.unresolved).filter(([path]) => current.current.includes(path)).flatMap(([, findings]) => findings).filter((finding) => finding.severity === "error");
            const confirmed = unresolved.filter(
              (finding) => valid.some(
                (result) => result.path === finding.path && result.findings.some((item) => diagnosticKey(item) === diagnosticKey(finding))
              )
            );
            if (stopping && confirmed.length && !current.blocked.includes(turn || "__turn__")) {
              current.blocked.push(turn || "__turn__");
              feedback = {
                kind: "block",
                reason: `Codex CodeIntel: fix introduced errors before finishing.
${render([{ path: ".", state: "complete", findings: confirmed }], 1e5, BUDGET.outputBytes)}`
              };
            } else if (fresh.length || repaired.length || stopping && current.pending.length)
              feedback = context(
                `Automatic delta: introduced=${fresh.flatMap((result) => result.findings).length}; pending=${current.pending.length}
${fresh.length ? render(fresh, 1e5, BUDGET.outputBytes) : ""}${repaired.join("\n")}${output.note ? `
${output.note}` : ""}`
              );
            current.shown["diagnosticCurrent"] = await this.store.shared(ledger);
            await queueDelivery(this.store, { ...current, turn }, feedback, bindings, config.version, analysis);
            return true;
          });
          return feedback;
        };
      }
    };
  }
});

// src/lsp/constants.ts
var REQUEST_TIMEOUT_MS, INIT_TIMEOUT_MS, IDLE_TIMEOUT_MS, REAPER_INTERVAL_MS, STOP_HARD_KILL_TIMEOUT_MS, STOP_SIGKILL_GRACE_MS;
var init_constants = __esm({
  "src/lsp/constants.ts"() {
    "use strict";
    REQUEST_TIMEOUT_MS = 15e3;
    INIT_TIMEOUT_MS = 6e4;
    IDLE_TIMEOUT_MS = 5 * 6e4;
    REAPER_INTERVAL_MS = 6e4;
    STOP_HARD_KILL_TIMEOUT_MS = 5e3;
    STOP_SIGKILL_GRACE_MS = 1e3;
  }
});

// src/lsp/json-rpc-connection.ts
function parseContentLength(headers) {
  for (const line of headers.split("\r\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;
    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    if (name !== "content-length") continue;
    const value = Number.parseInt(line.slice(separatorIndex + 1).trim(), 10);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  return null;
}
function isJsonRpcObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function getMessageId(message2) {
  const id = message2["id"];
  if (typeof id === "number" || typeof id === "string" || id === null) return id;
  return void 0;
}
function jsonRpcErrorToError(value) {
  if (!isJsonRpcObject(value)) return new Error("JSON-RPC request failed");
  const message2 = typeof value["message"] === "string" ? value["message"] : "JSON-RPC request failed";
  const error = new Error(message2);
  if (typeof value["code"] === "number") {
    error.name = `JsonRpcError(${value["code"]})`;
  }
  return error;
}
function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
var HEADER_SEPARATOR, PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INTERNAL_ERROR, JsonRpcConnection;
var init_json_rpc_connection = __esm({
  "src/lsp/json-rpc-connection.ts"() {
    "use strict";
    HEADER_SEPARATOR = "\r\n\r\n";
    PARSE_ERROR = -32700;
    INVALID_REQUEST = -32600;
    METHOD_NOT_FOUND = -32601;
    INTERNAL_ERROR = -32603;
    JsonRpcConnection = class {
      constructor(reader, writer) {
        this.reader = reader;
        this.writer = writer;
        this.pendingRequests = /* @__PURE__ */ new Map();
        this.notificationHandlers = /* @__PURE__ */ new Map();
        this.requestHandlers = /* @__PURE__ */ new Map();
        this.closeHandlers = [];
        this.errorHandlers = [];
        this.inputBuffer = Buffer.alloc(0);
        this.nextRequestId = 1;
        this.listening = false;
        this.disposed = false;
        this.handleData = (chunk) => {
          const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
          this.inputBuffer = Buffer.concat([this.inputBuffer, chunkBuffer]);
          this.drainInputBuffer();
        };
        this.handleClose = () => {
          if (this.disposed) return;
          this.dispose();
          for (const handler of this.closeHandlers) {
            handler();
          }
        };
        this.handleStreamError = (error) => {
          this.emitError(error);
          this.handleClose();
        };
      }
      listen() {
        if (this.listening) return;
        this.listening = true;
        this.reader.on("data", this.handleData);
        this.reader.on("close", this.handleClose);
        this.reader.on("end", this.handleClose);
        this.reader.on("error", this.handleStreamError);
        this.writer.on("error", this.handleStreamError);
      }
      onNotification(method, handler) {
        this.notificationHandlers.set(method, handler);
      }
      onRequest(method, handler) {
        this.requestHandlers.set(method, handler);
      }
      onClose(handler) {
        this.closeHandlers.push(handler);
      }
      onError(handler) {
        this.errorHandlers.push(handler);
      }
      async sendRequest(method, params, signal) {
        signal?.throwIfAborted();
        if (this.disposed) throw new Error("JSON-RPC connection is disposed");
        const id = this.nextRequestId;
        this.nextRequestId += 1;
        const message2 = params === void 0 ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
        const responsePromise = new Promise((resolve12, reject) => {
          this.pendingRequests.set(String(id), {
            resolve(result) {
              resolve12(result);
            },
            reject
          });
        });
        const abort = () => {
          const pending = this.pendingRequests.get(String(id));
          if (!pending) return;
          this.pendingRequests.delete(String(id));
          void this.sendNotification("$/cancelRequest", { id }).catch(() => void 0);
          pending.reject(new Error("LSP request cancelled or timed out"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        try {
          const sending = this.writeMessage(message2);
          if (signal?.aborted) abort();
          const [, result] = await Promise.all([sending, responsePromise]);
          return result;
        } finally {
          signal?.removeEventListener("abort", abort);
          this.pendingRequests.delete(String(id));
        }
      }
      async sendNotification(method, params) {
        if (this.disposed) return;
        const message2 = params === void 0 ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
        await this.writeMessage(message2);
      }
      dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.reader.off("data", this.handleData);
        this.reader.off("close", this.handleClose);
        this.reader.off("end", this.handleClose);
        this.reader.off("error", this.handleStreamError);
        this.writer.off("error", this.handleStreamError);
        for (const pending of this.pendingRequests.values()) {
          pending.reject(new Error("JSON-RPC connection disposed"));
        }
        this.pendingRequests.clear();
        this.notificationHandlers.clear();
        this.requestHandlers.clear();
      }
      drainInputBuffer() {
        while (true) {
          const headerEnd = this.inputBuffer.indexOf(HEADER_SEPARATOR);
          if (headerEnd === -1) return;
          const headers = this.inputBuffer.subarray(0, headerEnd).toString("ascii");
          const contentLength = parseContentLength(headers);
          if (contentLength === null) {
            this.inputBuffer = Buffer.alloc(0);
            this.emitError(new Error("JSON-RPC message is missing Content-Length header"));
            return;
          }
          const bodyStart = headerEnd + Buffer.byteLength(HEADER_SEPARATOR);
          const bodyEnd = bodyStart + contentLength;
          if (this.inputBuffer.length < bodyEnd) return;
          const body = this.inputBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
          this.inputBuffer = this.inputBuffer.subarray(bodyEnd);
          this.dispatchBody(body);
        }
      }
      dispatchBody(body) {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (error) {
          void this.writeError(null, PARSE_ERROR, error instanceof Error ? error.message : "Parse error").catch(
            (writeError) => this.emitError(toError(writeError))
          );
          return;
        }
        if (!isJsonRpcObject(parsed)) {
          void this.writeError(null, INVALID_REQUEST, "Invalid JSON-RPC message").catch(
            (error) => this.emitError(toError(error))
          );
          return;
        }
        if ("id" in parsed && ("result" in parsed || "error" in parsed)) {
          this.handleResponse(parsed);
          return;
        }
        if (typeof parsed["method"] !== "string") {
          const id = getMessageId(parsed) ?? null;
          void this.writeError(id, INVALID_REQUEST, "Invalid JSON-RPC method").catch(
            (error) => this.emitError(toError(error))
          );
          return;
        }
        if ("id" in parsed) {
          this.handleRequest(parsed);
          return;
        }
        this.handleNotification(parsed["method"], parsed["params"]);
      }
      handleResponse(message2) {
        const id = getMessageId(message2);
        if (id === void 0) return;
        const pending = this.pendingRequests.get(String(id));
        if (!pending) return;
        this.pendingRequests.delete(String(id));
        if ("error" in message2) {
          pending.reject(jsonRpcErrorToError(message2["error"]));
          return;
        }
        pending.resolve(message2["result"]);
      }
      handleNotification(method, params) {
        const handler = this.notificationHandlers.get(method);
        if (!handler) return;
        try {
          handler(params);
        } catch (error) {
          this.emitError(toError(error));
        }
      }
      handleRequest(message2) {
        const id = getMessageId(message2);
        if (id === void 0) {
          void this.writeError(null, INVALID_REQUEST, "Invalid JSON-RPC id").catch(
            (error) => this.emitError(toError(error))
          );
          return;
        }
        const method = typeof message2["method"] === "string" ? message2["method"] : "";
        const handler = this.requestHandlers.get(method);
        if (!handler) {
          void this.writeError(id, METHOD_NOT_FOUND, `Method not found: ${method}`).catch(
            (error) => this.emitError(toError(error))
          );
          return;
        }
        Promise.resolve().then(() => handler(message2["params"])).then(
          (result) => this.writeMessage({ jsonrpc: "2.0", id, result }),
          (error) => this.writeError(id, INTERNAL_ERROR, toError(error).message)
        ).catch((error) => this.emitError(toError(error)));
      }
      async writeError(id, code, message2) {
        await this.writeMessage({ jsonrpc: "2.0", id, error: { code, message: message2 } });
      }
      writeMessage(message2) {
        const body = JSON.stringify(message2);
        const payload = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r
\r
${body}`;
        return new Promise((resolve12, reject) => {
          this.writer.write(payload, (error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve12();
          });
        });
      }
      emitError(error) {
        for (const handler of this.errorHandlers) {
          handler(error);
        }
      }
    };
  }
});

// src/lsp/transport.ts
import { delimiter as delimiter3 } from "node:path";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseConfigurationItems(params) {
  if (!isRecord(params) || !Array.isArray(params["items"])) return [];
  const items2 = [];
  for (const item of params["items"]) {
    if (!isRecord(item)) continue;
    const section = item["section"];
    items2.push(section === void 0 || typeof section !== "string" ? {} : { section });
  }
  return items2;
}
function parseDiagnosticsParams(params) {
  if (!isRecord(params) || typeof params["uri"] !== "string") return null;
  const diagnostics = Array.isArray(params["diagnostics"]) ? params["diagnostics"].filter(isDiagnostic) : [];
  return { uri: params["uri"], diagnostics };
}
function isDiagnostic(value) {
  return isRecord(value) && isRange(value["range"]) && typeof value["message"] === "string";
}
function isRange(value) {
  return isRecord(value) && isPosition(value["start"]) && isPosition(value["end"]);
}
function isPosition(value) {
  return isRecord(value) && typeof value["line"] === "number" && typeof value["character"] === "number";
}
var LspClientTransport;
var init_transport = __esm({
  "src/lsp/transport.ts"() {
    "use strict";
    init_cleanup_errors();
    init_constants();
    init_errors();
    init_json_rpc_connection();
    init_process();
    LspClientTransport = class {
      constructor(root, server2, environment = process.env) {
        this.root = root;
        this.server = server2;
        this.environment = environment;
        this.proc = null;
        this.connection = null;
        this.stderrBuffer = [];
        this.processExited = false;
        this.diagnosticsStore = /* @__PURE__ */ new Map();
      }
      pid() {
        return this.proc?.pid;
      }
      command() {
        return [...this.server.command];
      }
      async start() {
        const env = {
          ...this.environment,
          ...this.server.env
        };
        const pathValue = process.platform === "win32" ? env["PATH"] ?? env["Path"] ?? "" : env["PATH"] ?? "";
        const spawnPath = [pathValue].filter(Boolean).join(delimiter3);
        if (process.platform === "win32" && env["Path"] !== void 0) {
          env["Path"] = spawnPath;
        }
        env["PATH"] = spawnPath;
        this.proc = spawnProcess(this.server.command, {
          cwd: this.root,
          env
        });
        this.startStderrReading();
        await new Promise((resolve12) => setTimeout(resolve12, 100));
        if (this.proc.exitCode !== null) {
          const stderr = this.stderrBuffer.join("\n");
          throw new LspProcessExitedError(this.server.id, this.root, this.proc.exitCode, stderr.slice(-2e3));
        }
        this.connection = new JsonRpcConnection(this.proc.stdout, this.proc.stdin);
        this.connection.onNotification("textDocument/publishDiagnostics", (params) => {
          const diagnosticsParams = parseDiagnosticsParams(params);
          if (diagnosticsParams?.uri) {
            this.diagnosticsStore.set(diagnosticsParams.uri, diagnosticsParams.diagnostics);
          }
        });
        this.connection.onRequest("workspace/configuration", (params) => {
          const items2 = parseConfigurationItems(params);
          return items2.map((item) => {
            if (item.section === "json") return { validate: { enable: true } };
            return {};
          });
        });
        this.connection.onRequest("client/registerCapability", () => null);
        this.connection.onRequest("window/workDoneProgress/create", () => null);
        this.connection.onClose(() => {
          this.processExited = true;
        });
        this.connection.onError((error) => {
          reportBestEffortCleanupError("connection error notification", error);
        });
        this.connection.listen();
      }
      startStderrReading() {
        if (!this.proc) return;
        this.proc.stderr.setEncoding("utf-8");
        this.proc.stderr.on("data", (chunk) => {
          this.stderrBuffer.push(chunk);
          if (this.stderrBuffer.length > 100) {
            this.stderrBuffer.shift();
          }
        });
      }
      isConnectionClosedError(error) {
        if (!(error instanceof Error)) {
          return false;
        }
        const code = "code" in error && typeof error.code === "string" ? error.code : void 0;
        return code === "ERR_STREAM_DESTROYED" || /connection closed|connection is disposed|stream was destroyed/i.test(error.message);
      }
      async sendRequest(method, ...args) {
        if (!this.connection) throw new Error("LSP client not started");
        if (this.processExited || this.proc && this.proc.exitCode !== null) {
          const stderrTail = this.stderrBuffer.slice(-10).join("\n");
          throw new LspProcessExitedError(
            this.server.id,
            this.root,
            this.proc?.exitCode ?? null,
            stderrTail || void 0
          );
        }
        return this.connection.sendRequest(method, args[0], AbortSignal.timeout(REQUEST_TIMEOUT_MS));
      }
      async sendNotification(method, ...args) {
        if (!this.connection) return;
        if (this.processExited || this.proc && this.proc.exitCode !== null) return;
        try {
          if (args.length === 0) {
            await this.connection.sendNotification(method);
          } else {
            await this.connection.sendNotification(method, args[0]);
          }
        } catch (error) {
          if (this.isConnectionClosedError(error)) {
            throw new LspConnectionClosedError(this.server.id, this.root, error.message);
          }
          throw error;
        }
      }
      isAlive() {
        return this.proc !== null && !this.processExited && this.proc.exitCode === null;
      }
      async stop() {
        if (this.connection) {
          try {
            await this.sendRequest("shutdown");
          } catch (error) {
            reportBestEffortCleanupError("shutdown request", error);
          }
          try {
            await this.sendNotification("exit");
          } catch (error) {
            reportBestEffortCleanupError("exit notification", error);
          }
          try {
            this.connection.dispose();
          } catch (error) {
            reportBestEffortCleanupError("connection dispose", error);
          }
          this.connection = null;
        }
        const proc = this.proc;
        if (proc) {
          this.proc = null;
          let exitedBeforeTimeout = false;
          try {
            proc.kill();
            let timeoutId;
            const timeoutPromise = new Promise((resolve12) => {
              timeoutId = setTimeout(resolve12, STOP_HARD_KILL_TIMEOUT_MS);
            });
            await Promise.race([
              proc.exited.then(() => {
                exitedBeforeTimeout = true;
              }).finally(() => {
                if (timeoutId) clearTimeout(timeoutId);
              }),
              timeoutPromise
            ]);
            if (!exitedBeforeTimeout) {
              try {
                proc.kill("SIGKILL");
                await Promise.race([
                  proc.exited,
                  new Promise((resolve12) => setTimeout(resolve12, STOP_SIGKILL_GRACE_MS))
                ]);
              } catch (error) {
                reportBestEffortCleanupError("hard process kill", error);
              }
            }
          } catch (error) {
            reportBestEffortCleanupError("process stop", error);
          }
        }
        this.processExited = true;
        this.diagnosticsStore.clear();
      }
      getStoredDiagnostics(uri) {
        return this.diagnosticsStore.get(uri) ?? [];
      }
    };
  }
});

// src/lsp/connection.ts
import { pathToFileURL } from "node:url";
var INITIALIZE_SETTLE_MS, LspClientConnection;
var init_connection = __esm({
  "src/lsp/connection.ts"() {
    "use strict";
    init_transport();
    INITIALIZE_SETTLE_MS = 300;
    LspClientConnection = class extends LspClientTransport {
      async initialize() {
        const rootUri = pathToFileURL(this.root).href;
        await this.sendRequest("initialize", {
          processId: process.pid,
          rootUri,
          rootPath: this.root,
          workspaceFolders: [{ uri: rootUri, name: "workspace" }],
          capabilities: {
            textDocument: {
              hover: { contentFormat: ["markdown", "plaintext"] },
              definition: { linkSupport: true },
              references: {},
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              publishDiagnostics: {},
              rename: {
                prepareSupport: true,
                prepareSupportDefaultBehavior: 1,
                honorsChangeAnnotations: true
              },
              codeAction: {
                codeActionLiteralSupport: {
                  codeActionKind: {
                    valueSet: [
                      "quickfix",
                      "refactor",
                      "refactor.extract",
                      "refactor.inline",
                      "refactor.rewrite",
                      "source",
                      "source.organizeImports",
                      "source.fixAll"
                    ]
                  }
                },
                isPreferredSupport: true,
                disabledSupport: true,
                dataSupport: true,
                resolveSupport: {
                  properties: ["edit", "command"]
                }
              }
            },
            workspace: {
              symbol: {},
              workspaceFolders: true,
              configuration: true,
              applyEdit: true,
              workspaceEdit: {
                documentChanges: true
              }
            }
          },
          initializationOptions: this.server.initialization
        });
        await this.sendNotification("initialized");
        await this.sendNotification("workspace/didChangeConfiguration", {
          settings: { json: { validate: { enable: true } } }
        });
        await new Promise((r) => setTimeout(r, INITIALIZE_SETTLE_MS));
      }
    };
  }
});

// src/lsp/language-mappings.ts
function getLanguageId(ext) {
  return EXT_TO_LANG[ext] ?? "plaintext";
}
var EXT_TO_LANG;
var init_language_mappings = __esm({
  "src/lsp/language-mappings.ts"() {
    "use strict";
    EXT_TO_LANG = {
      ".abap": "abap",
      ".bat": "bat",
      ".bib": "bibtex",
      ".bibtex": "bibtex",
      ".clj": "clojure",
      ".cljs": "clojure",
      ".cljc": "clojure",
      ".edn": "clojure",
      ".coffee": "coffeescript",
      ".c": "c",
      ".cpp": "cpp",
      ".cxx": "cpp",
      ".cc": "cpp",
      ".c++": "cpp",
      ".cs": "csharp",
      ".css": "css",
      ".d": "d",
      ".pas": "pascal",
      ".pascal": "pascal",
      ".diff": "diff",
      ".patch": "diff",
      ".dart": "dart",
      ".dockerfile": "dockerfile",
      ".ex": "elixir",
      ".exs": "elixir",
      ".erl": "erlang",
      ".hrl": "erlang",
      ".fs": "fsharp",
      ".fsi": "fsharp",
      ".fsx": "fsharp",
      ".fsscript": "fsharp",
      ".gitcommit": "git-commit",
      ".gitrebase": "git-rebase",
      ".go": "go",
      ".groovy": "groovy",
      ".gleam": "gleam",
      ".hbs": "handlebars",
      ".handlebars": "handlebars",
      ".hs": "haskell",
      ".html": "html",
      ".htm": "html",
      ".ini": "ini",
      ".java": "java",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".json": "json",
      ".jsonc": "jsonc",
      ".tex": "latex",
      ".latex": "latex",
      ".less": "less",
      ".lua": "lua",
      ".makefile": "makefile",
      makefile: "makefile",
      ".md": "markdown",
      ".markdown": "markdown",
      ".m": "objective-c",
      ".mm": "objective-cpp",
      ".pl": "perl",
      ".pm": "perl",
      ".pm6": "perl6",
      ".php": "php",
      ".ps1": "powershell",
      ".psm1": "powershell",
      ".pug": "jade",
      ".jade": "jade",
      ".py": "python",
      ".pyi": "python",
      ".r": "r",
      ".cshtml": "razor",
      ".razor": "razor",
      ".rb": "ruby",
      ".rake": "ruby",
      ".gemspec": "ruby",
      ".ru": "ruby",
      ".erb": "erb",
      ".html.erb": "erb",
      ".js.erb": "erb",
      ".css.erb": "erb",
      ".json.erb": "erb",
      ".rs": "rust",
      ".scss": "scss",
      ".sass": "sass",
      ".scala": "scala",
      ".shader": "shaderlab",
      ".sh": "shellscript",
      ".bash": "shellscript",
      ".zsh": "shellscript",
      ".ksh": "shellscript",
      ".sql": "sql",
      ".svelte": "svelte",
      ".swift": "swift",
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".mts": "typescript",
      ".cts": "typescript",
      ".mtsx": "typescriptreact",
      ".ctsx": "typescriptreact",
      ".xml": "xml",
      ".xsl": "xsl",
      ".yaml": "yaml",
      ".yml": "yaml",
      ".mjs": "javascript",
      ".cjs": "javascript",
      ".vue": "vue",
      ".zig": "zig",
      ".zon": "zig",
      ".astro": "astro",
      ".ml": "ocaml",
      ".mli": "ocaml",
      ".tf": "terraform",
      ".tfvars": "terraform-vars",
      ".hcl": "hcl",
      ".nix": "nix",
      ".typ": "typst",
      ".typc": "typst",
      ".ets": "typescript",
      ".lhs": "haskell",
      ".kt": "kotlin",
      ".kts": "kotlin",
      ".prisma": "prisma",
      ".h": "c",
      ".hpp": "cpp",
      ".hh": "cpp",
      ".hxx": "cpp",
      ".h++": "cpp",
      ".objc": "objective-c",
      ".objcpp": "objective-cpp",
      ".fish": "fish",
      ".graphql": "graphql",
      ".gql": "graphql"
    };
  }
});

// src/lsp/client.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { extname as extname4, resolve as resolve7 } from "node:path";
import { pathToFileURL as pathToFileURL2 } from "node:url";
var POST_OPEN_DELAY_MS, POST_DIAGNOSTICS_WAIT_MS, LspClient;
var init_client = __esm({
  "src/lsp/client.ts"() {
    "use strict";
    init_connection();
    init_language_mappings();
    POST_OPEN_DELAY_MS = 1e3;
    POST_DIAGNOSTICS_WAIT_MS = 500;
    LspClient = class extends LspClientConnection {
      constructor() {
        super(...arguments);
        this.openedFiles = /* @__PURE__ */ new Set();
        this.documentVersions = /* @__PURE__ */ new Map();
        this.lastSyncedText = /* @__PURE__ */ new Map();
        this.diagnosticPullErrors = [];
      }
      getDiagnosticPullErrors() {
        return this.diagnosticPullErrors;
      }
      async openFile(filePath) {
        const absPath = resolve7(filePath);
        const uri = pathToFileURL2(absPath).href;
        const text2 = readFileSync2(absPath, "utf-8");
        if (!this.openedFiles.has(absPath)) {
          const ext = extname4(absPath);
          const languageId = getLanguageId(ext);
          const version = 1;
          await this.sendNotification("textDocument/didOpen", {
            textDocument: {
              uri,
              languageId,
              version,
              text: text2
            }
          });
          this.openedFiles.add(absPath);
          this.documentVersions.set(uri, version);
          this.lastSyncedText.set(uri, text2);
          await new Promise((r) => setTimeout(r, POST_OPEN_DELAY_MS));
          return;
        }
        const prevText = this.lastSyncedText.get(uri);
        if (prevText === text2) {
          return;
        }
        const nextVersion = (this.documentVersions.get(uri) ?? 1) + 1;
        this.documentVersions.set(uri, nextVersion);
        this.lastSyncedText.set(uri, text2);
        await this.sendNotification("textDocument/didChange", {
          textDocument: { uri, version: nextVersion },
          contentChanges: [{ text: text2 }]
        });
        await this.sendNotification("textDocument/didSave", {
          textDocument: { uri },
          text: text2
        });
      }
      async definition(filePath, line, character) {
        const absPath = resolve7(filePath);
        await this.openFile(absPath);
        return this.sendRequest(
          "textDocument/definition",
          {
            textDocument: { uri: pathToFileURL2(absPath).href },
            position: { line: line - 1, character }
          }
        );
      }
      async references(filePath, line, character, includeDeclaration = true) {
        const absPath = resolve7(filePath);
        await this.openFile(absPath);
        return this.sendRequest("textDocument/references", {
          textDocument: { uri: pathToFileURL2(absPath).href },
          position: { line: line - 1, character },
          context: { includeDeclaration }
        });
      }
      async documentSymbols(filePath) {
        const absPath = resolve7(filePath);
        await this.openFile(absPath);
        return this.sendRequest("textDocument/documentSymbol", {
          textDocument: { uri: pathToFileURL2(absPath).href }
        });
      }
      async workspaceSymbols(query) {
        return this.sendRequest("workspace/symbol", { query });
      }
      isUnsupportedDiagnosticPullError(error) {
        if (!(error instanceof Error)) return false;
        const code = "code" in error && typeof error.code === "number" ? error.code : void 0;
        if (code === -32601) return true;
        return /unsupported|not supported|method not found|unknown request/i.test(error.message);
      }
      async diagnostics(filePath) {
        const absPath = resolve7(filePath);
        const uri = pathToFileURL2(absPath).href;
        await this.openFile(absPath);
        await new Promise((r) => setTimeout(r, POST_DIAGNOSTICS_WAIT_MS));
        try {
          const result = await this.sendRequest("textDocument/diagnostic", {
            textDocument: { uri }
          });
          if (result.items) {
            return { items: result.items };
          }
        } catch (error) {
          if (!this.isUnsupportedDiagnosticPullError(error)) {
            this.diagnosticPullErrors.push(error instanceof Error ? error : new Error(String(error)));
          }
        }
        return { items: this.getStoredDiagnostics(uri) };
      }
      async prepareRename(filePath, line, character) {
        const absPath = resolve7(filePath);
        await this.openFile(absPath);
        return this.sendRequest(
          "textDocument/prepareRename",
          {
            textDocument: { uri: pathToFileURL2(absPath).href },
            position: { line: line - 1, character }
          }
        );
      }
      async rename(filePath, line, character, newName) {
        const absPath = resolve7(filePath);
        await this.openFile(absPath);
        return this.sendRequest("textDocument/rename", {
          textDocument: { uri: pathToFileURL2(absPath).href },
          position: { line: line - 1, character },
          newName
        });
      }
    };
  }
});

// src/lsp/process-signal-cleanup.ts
import { constants as constants3 } from "node:os";
function removeSignalHandlers() {
  if (!handlersInstalled) return;
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  signalHandlers.clear();
  handlersInstalled = false;
}
function signalExitCode(signal) {
  return 128 + (constants3.signals[signal] ?? 1);
}
function terminateParent(signal) {
  if (process.platform === "win32" && signal === "SIGBREAK") {
    process.exit(signalExitCode(signal));
  }
  try {
    process.kill(process.pid, signal);
  } catch (error) {
    reportBestEffortCleanupError("signal re-delivery", error);
    process.exit(signalExitCode(signal));
  }
}
async function runCleanup(registration) {
  try {
    await registration.cleanup();
  } catch (error) {
    reportBestEffortCleanupError("signal cleanup", error);
  }
}
function handleSignal(signal) {
  if (handlingSignal) return;
  handlingSignal = true;
  const activeRegistrations = [...registrations];
  const shouldTerminateParent = activeRegistrations.some((registration) => registration.terminatesParent);
  void Promise.all(activeRegistrations.map(runCleanup)).then(() => {
    removeSignalHandlers();
    if (shouldTerminateParent) {
      terminateParent(signal);
      return;
    }
    handlingSignal = false;
    if (registrations.size > 0) ensureSignalHandlers();
  });
}
function ensureSignalHandlers() {
  if (handlersInstalled) return;
  for (const signal of PROCESS_SIGNALS) {
    const handler = () => handleSignal(signal);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  handlersInstalled = true;
}
function installProcessSignalCleanup(cleanup, options = {}) {
  const registration = {
    cleanup,
    terminatesParent: options.terminateParent ?? false
  };
  registrations.add(registration);
  ensureSignalHandlers();
  return () => {
    registrations.delete(registration);
    if (registrations.size === 0 && !handlingSignal) removeSignalHandlers();
  };
}
var PROCESS_SIGNALS, registrations, signalHandlers, handlersInstalled, handlingSignal;
var init_process_signal_cleanup = __esm({
  "src/lsp/process-signal-cleanup.ts"() {
    "use strict";
    init_cleanup_errors();
    PROCESS_SIGNALS = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
    registrations = /* @__PURE__ */ new Set();
    signalHandlers = /* @__PURE__ */ new Map();
    handlersInstalled = false;
    handlingSignal = false;
  }
});

// src/lsp/manager.ts
async function stopClientBestEffort(client) {
  try {
    await client.stop();
  } catch (error) {
    reportBestEffortCleanupError("client stop", error);
  }
}
function awaitWithSignal(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve12, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve12(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}
var LspManager;
var init_manager = __esm({
  "src/lsp/manager.ts"() {
    "use strict";
    init_cleanup_errors();
    init_client();
    init_constants();
    init_process_signal_cleanup();
    LspManager = class {
      constructor(options = {}) {
        this.clients = /* @__PURE__ */ new Map();
        this.reaperHandle = null;
        this.signalDisposer = null;
        this.disposed = false;
        this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
        this.initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
        this.reaperIntervalMs = options.reaperIntervalMs ?? REAPER_INTERVAL_MS;
        this.clientFactory = options.clientFactory ?? ((root, server2) => new LspClient(root, server2));
        this.now = options.now ?? (() => Date.now());
        this.startReaper();
        this.signalDisposer = installProcessSignalCleanup(() => this.stopAll());
      }
      startReaper() {
        if (this.reaperHandle) return;
        this.reaperHandle = setInterval(() => {
          this.reapStale();
        }, this.reaperIntervalMs);
        if (typeof this.reaperHandle.unref === "function") {
          this.reaperHandle.unref();
        }
      }
      getKey(root, serverId) {
        return `${root}::${serverId}`;
      }
      reapStale() {
        const t = this.now();
        for (const [key, managed] of this.clients) {
          if (managed.isInitializing && managed.initializingSince !== null && t - managed.initializingSince > this.initTimeoutMs) {
            void stopClientBestEffort(managed.client);
            this.clients.delete(key);
            continue;
          }
          if (!managed.isInitializing && managed.refCount === 0 && managed.pendingWaiters === 0 && t - managed.lastUsedAt > this.idleTimeoutMs) {
            void stopClientBestEffort(managed.client);
            this.clients.delete(key);
          }
        }
      }
      async getClient(root, server2, signal) {
        if (this.disposed) {
          throw new Error("LspManager has been disposed");
        }
        signal?.throwIfAborted();
        const key = this.getKey(root, server2.id);
        let managed = this.clients.get(key);
        if (managed) {
          const t = this.now();
          if (managed.isInitializing && managed.initializingSince !== null && t - managed.initializingSince > this.initTimeoutMs) {
            await stopClientBestEffort(managed.client);
            this.clients.delete(key);
            managed = void 0;
          }
        }
        if (managed) {
          if (managed.initPromise) {
            managed.pendingWaiters++;
            try {
              await awaitWithSignal(managed.initPromise, signal);
            } catch (err) {
              managed.pendingWaiters--;
              throw err;
            }
            managed.pendingWaiters--;
          }
          if (signal?.aborted) {
            signal.throwIfAborted();
          }
          if (!managed.client.isAlive()) {
            await stopClientBestEffort(managed.client);
            this.clients.delete(key);
            return this.getClient(root, server2, signal);
          }
          managed.refCount++;
          managed.lastUsedAt = this.now();
          return managed.client;
        }
        const client = this.clientFactory(root, server2);
        const initStartedAt = this.now();
        const initPromise = (async () => {
          await client.start();
          await client.initialize();
        })();
        const newManaged = {
          client,
          refCount: 0,
          pendingWaiters: 1,
          lastUsedAt: initStartedAt,
          initPromise,
          isInitializing: true,
          initializingSince: initStartedAt
        };
        this.clients.set(key, newManaged);
        try {
          await awaitWithSignal(initPromise, signal);
        } catch (err) {
          newManaged.pendingWaiters--;
          if (signal?.aborted) {
            void initPromise.then(
              () => {
                newManaged.isInitializing = false;
                newManaged.initializingSince = null;
                newManaged.initPromise = null;
              },
              () => {
                if (this.clients.get(key) === newManaged) this.invalidateClient(root, server2.id, client);
              }
            );
            throw err;
          }
          if (this.clients.get(key) === newManaged) {
            this.clients.delete(key);
          }
          await stopClientBestEffort(client);
          throw err;
        }
        newManaged.pendingWaiters--;
        newManaged.isInitializing = false;
        newManaged.initializingSince = null;
        newManaged.initPromise = null;
        if (signal?.aborted) {
          signal.throwIfAborted();
        }
        newManaged.refCount++;
        newManaged.lastUsedAt = this.now();
        return client;
      }
      releaseClient(root, serverId) {
        const key = this.getKey(root, serverId);
        const managed = this.clients.get(key);
        if (managed && managed.refCount > 0) {
          managed.refCount--;
          managed.lastUsedAt = this.now();
        }
      }
      invalidateClient(root, serverId, client) {
        const key = this.getKey(root, serverId);
        const managed = this.clients.get(key);
        if (!managed) return;
        if (client && managed.client !== client) return;
        this.clients.delete(key);
        void stopClientBestEffort(managed.client);
      }
      warmupClient(root, server2) {
        if (this.disposed) return;
        const key = this.getKey(root, server2.id);
        if (this.clients.has(key)) return;
        const client = this.clientFactory(root, server2);
        const initStartedAt = this.now();
        const initPromise = (async () => {
          await client.start();
          await client.initialize();
        })();
        const managed = {
          client,
          refCount: 0,
          pendingWaiters: 0,
          lastUsedAt: initStartedAt,
          initPromise,
          isInitializing: true,
          initializingSince: initStartedAt
        };
        this.clients.set(key, managed);
        initPromise.then(
          () => {
            managed.isInitializing = false;
            managed.initializingSince = null;
            managed.initPromise = null;
            managed.lastUsedAt = this.now();
          },
          () => {
            if (this.clients.get(key) === managed) {
              this.clients.delete(key);
            }
            void stopClientBestEffort(client);
          }
        );
      }
      isServerInitializing(root, serverId) {
        const managed = this.clients.get(this.getKey(root, serverId));
        return managed?.isInitializing ?? false;
      }
      getSnapshot() {
        const snapshots2 = [];
        for (const [key, managed] of this.clients) {
          const [root, serverId] = key.split("::");
          snapshots2.push({
            root,
            serverId,
            refCount: managed.refCount,
            pendingWaiters: managed.pendingWaiters,
            lastUsedAt: managed.lastUsedAt,
            isInitializing: managed.isInitializing,
            alive: managed.client.isAlive(),
            command: managed.client.command()
          });
        }
        return snapshots2;
      }
      hasClient(root, serverId) {
        return this.clients.has(this.getKey(root, serverId));
      }
      clientCount() {
        return this.clients.size;
      }
      async stopAll() {
        this.disposed = true;
        if (this.reaperHandle) {
          clearInterval(this.reaperHandle);
          this.reaperHandle = null;
        }
        if (this.signalDisposer) {
          this.signalDisposer();
          this.signalDisposer = null;
        }
        const stopPromises = [];
        for (const managed of this.clients.values()) {
          stopPromises.push(stopClientBestEffort(managed.client));
        }
        this.clients.clear();
        await Promise.allSettled(stopPromises);
      }
    };
  }
});

// src/lsp/abortable-shared-operation.ts
function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}
function releaseSharedOperationWaiter(operation) {
  operation.waiterCount -= 1;
  if (operation.waiterCount > 0 || operation.settled) return;
  operation.controller.abort();
  operation.onAbandoned();
  void operation.promise.catch(() => void 0);
}
function createSharedAbortableOperation(run2, onSettled, onAbandoned) {
  const controller = new AbortController();
  let operation;
  const promise = run2(controller.signal).finally(() => {
    operation.settled = true;
    onSettled();
  });
  operation = {
    controller,
    promise,
    onAbandoned,
    waiterCount: 0,
    settled: false
  };
  void promise.catch(() => void 0);
  return operation;
}
function awaitSharedAbortableOperation(operation, signal) {
  signal?.throwIfAborted();
  operation.waiterCount += 1;
  return new Promise((resolve12, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      releaseSharedOperationWaiter(operation);
      reject(signal === void 0 ? new DOMException("Aborted", "AbortError") : abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    operation.promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        releaseSharedOperationWaiter(operation);
        resolve12(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        releaseSharedOperationWaiter(operation);
        reject(error);
      }
    );
  });
}
var init_abortable_shared_operation = __esm({
  "src/lsp/abortable-shared-operation.ts"() {
    "use strict";
  }
});

// src/lsp/cargo-manifest-snapshot.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { dirname as dirname5, join as join11 } from "node:path";
function isMissingManifestError(error) {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? error.code : void 0;
  return code === "ENOENT" || code === "ENOTDIR";
}
function readManifestSnapshot(path, allowMissing = false) {
  try {
    return { path, exists: true, content: readFileSync3(path, "utf8") };
  } catch (error) {
    if (allowMissing && isMissingManifestError(error)) {
      return { path, exists: false, content: void 0 };
    }
    return void 0;
  }
}
function snapshotsAreFresh(snapshots2) {
  for (const snapshot of snapshots2) {
    const candidate = readManifestSnapshot(snapshot.path, true);
    if (candidate === void 0) return false;
    if (candidate.exists !== snapshot.exists) return false;
    if (!candidate.exists) continue;
    if (candidate.content !== snapshot.content) return false;
  }
  return true;
}
function ancestorManifestPaths(manifestDir) {
  const paths = [];
  const seen = /* @__PURE__ */ new Set();
  let dir = manifestDir;
  let prev = "";
  while (dir !== prev) {
    const manifestPath = join11(dir, "Cargo.toml");
    if (!seen.has(manifestPath)) {
      seen.add(manifestPath);
      paths.push(manifestPath);
    }
    prev = dir;
    dir = dirname5(dir);
  }
  return paths;
}
function readAncestorManifestSnapshots(manifestDir) {
  const snapshots2 = [];
  const manifestPaths = ancestorManifestPaths(manifestDir);
  for (const [index, manifestPath] of manifestPaths.entries()) {
    const snapshot = readManifestSnapshot(manifestPath, true);
    if (snapshot === void 0) return void 0;
    if (index === 0 && !snapshot.exists) return void 0;
    snapshots2.push(snapshot);
  }
  return snapshots2.length === 0 ? void 0 : snapshots2;
}
var init_cargo_manifest_snapshot = __esm({
  "src/lsp/cargo-manifest-snapshot.ts"() {
    "use strict";
  }
});

// src/lsp/cargo-metadata-parser.ts
import { readFileSync as readFileSync4, realpathSync, statSync as statSync2 } from "node:fs";
import { isAbsolute as isAbsolute7, join as join12, relative as relative4, sep as sep2 } from "node:path";
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function canonicalDirectory(path) {
  try {
    const canonicalPath = realpathSync.native(path);
    return statSync2(canonicalPath).isDirectory() ? canonicalPath : void 0;
  } catch {
    return void 0;
  }
}
function canonicalManifest(path) {
  try {
    const canonicalPath = realpathSync.native(path);
    return statSync2(canonicalPath).isFile() ? canonicalPath : void 0;
  } catch {
    return void 0;
  }
}
function readFile12(path) {
  try {
    return readFileSync4(path, "utf8");
  } catch {
    return void 0;
  }
}
function readCargoManifestKind(path) {
  const content = readFile12(path);
  if (content === void 0) return void 0;
  try {
    return Object.hasOwn(parse(content), "workspace") ? "workspace" : "ordinary";
  } catch {
    return "invalid";
  }
}
function isContainedPath(root, path) {
  const relativePath = relative4(root, path);
  return relativePath === "" || !isAbsolute7(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep2}`);
}
function parseCargoMetadata(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return void 0;
  }
  if (!isRecord2(parsed)) return void 0;
  const workspaceRoot = parsed["workspace_root"];
  const workspaceMembers = parsed["workspace_members"];
  const packages = parsed["packages"];
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) return void 0;
  if (!Array.isArray(workspaceMembers) || !Array.isArray(packages)) return void 0;
  const memberIds = /* @__PURE__ */ new Set();
  for (const id of workspaceMembers) {
    if (typeof id !== "string") return void 0;
    memberIds.add(id);
  }
  const memberManifestPaths = [];
  for (const pkg of packages) {
    if (!isRecord2(pkg)) return void 0;
    const id = pkg["id"];
    const manifestPath = pkg["manifest_path"];
    if (typeof id !== "string" || typeof manifestPath !== "string") return void 0;
    if (memberIds.has(id)) memberManifestPaths.push(manifestPath);
  }
  if (memberManifestPaths.length !== memberIds.size) return void 0;
  return { workspaceRoot, memberManifestPaths };
}
function validateCargoMetadata(requestedManifestPath, metadata) {
  const workspaceRoot = canonicalDirectory(metadata.workspaceRoot);
  if (workspaceRoot === void 0) return void 0;
  const rootManifestPath = canonicalManifest(join12(workspaceRoot, "Cargo.toml"));
  const requestedManifest = canonicalManifest(requestedManifestPath);
  if (rootManifestPath === void 0 || requestedManifest === void 0) return void 0;
  if (!isContainedPath(workspaceRoot, requestedManifest)) return void 0;
  const rootManifestKind = readCargoManifestKind(rootManifestPath);
  const requestedManifestKind = requestedManifest === rootManifestPath ? rootManifestKind : readCargoManifestKind(requestedManifest);
  if (rootManifestKind === void 0 || rootManifestKind === "invalid") return void 0;
  if (requestedManifestKind === void 0 || requestedManifestKind === "invalid") return void 0;
  if (requestedManifest !== rootManifestPath && requestedManifestKind === "workspace") return void 0;
  const memberManifestPaths = [];
  const members = /* @__PURE__ */ new Set();
  for (const manifestPath of metadata.memberManifestPaths) {
    const canonicalPath = canonicalManifest(manifestPath);
    if (canonicalPath === void 0) return void 0;
    if (!isContainedPath(workspaceRoot, canonicalPath)) return void 0;
    const manifestKind = canonicalPath === rootManifestPath ? rootManifestKind : readCargoManifestKind(canonicalPath);
    if (manifestKind === void 0) return void 0;
    if (canonicalPath !== rootManifestPath && manifestKind !== "ordinary") continue;
    if (!members.has(canonicalPath)) {
      members.add(canonicalPath);
      memberManifestPaths.push(canonicalPath);
    }
  }
  if (requestedManifest !== rootManifestPath && !members.has(requestedManifest)) return void 0;
  return { workspaceRoot, rootManifestPath, memberManifestPaths };
}
function parseTrustedCargoMetadata(requestedManifestPath, output) {
  const parsed = parseCargoMetadata(output);
  return parsed === void 0 ? void 0 : validateCargoMetadata(requestedManifestPath, parsed);
}
var init_cargo_metadata_parser = __esm({
  "src/lsp/cargo-metadata-parser.ts"() {
    "use strict";
    init_dist();
  }
});

// src/lsp/cargo-metadata-process.ts
import { spawn as spawn3 } from "node:child_process";
async function abortActiveCargoMetadata() {
  const cleanups = [...activeCargoMetadataCleanups];
  for (const cleanup of cleanups) {
    if (!cleanup.controller.signal.aborted) cleanup.controller.abort();
  }
  await Promise.all(cleanups.map((cleanup) => cleanup.waitForTermination()));
}
function ensureProcessSignalHandlers() {
  if (removeProcessSignalHandlers !== void 0) return;
  removeProcessSignalHandlers = installProcessSignalCleanup(abortActiveCargoMetadata);
}
function registerCargoMetadataCleanup(controller, waitForTermination) {
  activeCargoMetadataCleanups.add({ controller, waitForTermination });
}
function releaseCargoMetadataController(controller) {
  for (const cleanup of activeCargoMetadataCleanups) {
    if (cleanup.controller === controller) activeCargoMetadataCleanups.delete(cleanup);
  }
  if (activeCargoMetadataCleanups.size > 0) return;
  removeProcessSignalHandlers?.();
  removeProcessSignalHandlers = void 0;
}
function linkParentSignal(controller, signal) {
  if (signal === void 0) return () => {
  };
  const abortFromParent = () => controller.abort(signal.reason);
  if (signal.aborted) {
    abortFromParent();
    return () => {
    };
  }
  signal.addEventListener("abort", abortFromParent, { once: true });
  return () => signal.removeEventListener("abort", abortFromParent);
}
async function defaultCargoMetadataLoader(manifestPath, signal, environment = executionEnvironment()) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const unlinkParentSignal = linkParentSignal(controller, signal);
  ensureProcessSignalHandlers();
  try {
    controller.signal.throwIfAborted();
    return await new Promise((resolveLoader, rejectLoader) => {
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let cargoProcess;
      let cleanupStarted = false;
      let forceKillTimeout;
      let timeoutError;
      let terminationError;
      let settled = false;
      let resolveTermination;
      const terminationComplete = new Promise((resolve12) => {
        resolveTermination = resolve12;
      });
      const finishTermination = () => {
        resolveTermination?.();
        resolveTermination = void 0;
      };
      const terminateCargoProcessTree = (terminationSignal) => {
        if (cargoProcess !== void 0) terminateProcessTree(cargoProcess, terminationSignal);
      };
      const beginCargoCleanup = () => {
        if (cleanupStarted) return;
        cleanupStarted = true;
        terminateCargoProcessTree("SIGTERM");
        forceKillTimeout = setTimeout(() => {
          forceKillTimeout = void 0;
          terminateCargoProcessTree("SIGKILL");
          finishTermination();
        }, CARGO_METADATA_FORCE_KILL_DELAY_MS);
      };
      const clearCleanupTracking = () => {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", beginCargoCleanup);
        if (!cleanupStarted) {
          if (forceKillTimeout !== void 0) {
            clearTimeout(forceKillTimeout);
            forceKillTimeout = void 0;
          }
          finishTermination();
          return;
        }
        if (forceKillTimeout === void 0) finishTermination();
      };
      const timeout = setTimeout(() => {
        timeoutError = new Error(`cargo metadata timed out after ${CARGO_METADATA_TIMEOUT_MS}ms`);
        timeoutError.name = "TimeoutError";
        beginCargoCleanup();
      }, CARGO_METADATA_TIMEOUT_MS);
      controller.signal.addEventListener("abort", beginCargoCleanup, { once: true });
      registerCargoMetadataCleanup(controller, () => terminationComplete);
      const commandArgs = ["metadata", "--no-deps", "--format-version", "1", "--manifest-path", manifestPath];
      const rejectWithCurrentReason = (error) => {
        rejectLoader(controller.signal.aborted ? controller.signal.reason : error);
      };
      const settle = (callback) => {
        if (settled) return;
        settled = true;
        callback();
      };
      const appendChunk = (chunks, chunk, currentBytes) => {
        const nextBytes = currentBytes + Buffer.byteLength(chunk, "utf8");
        if (nextBytes > CARGO_METADATA_MAX_BUFFER && terminationError === void 0) {
          terminationError = new RangeError("cargo metadata output exceeded maxBuffer");
          beginCargoCleanup();
        }
        chunks.push(chunk);
        return nextBytes;
      };
      cargoProcess = spawn3("cargo", commandArgs, {
        ...HIDDEN_PROCESS,
        env: subprocessEnvironment(environment),
        detached: process.platform !== "win32",
        signal: controller.signal,
        stdio: ["ignore", "pipe", "pipe"]
      });
      cargoProcess.stdout?.setEncoding("utf8");
      cargoProcess.stderr?.setEncoding("utf8");
      cargoProcess.stdout?.on("data", (chunk) => {
        stdoutBytes = appendChunk(stdoutChunks, chunk, stdoutBytes);
      });
      cargoProcess.stderr?.on("data", (chunk) => {
        stderrBytes = appendChunk(stderrChunks, chunk, stderrBytes);
      });
      cargoProcess.once("error", (error) => {
        settle(() => {
          clearCleanupTracking();
          if (controller.signal.aborted) {
            rejectWithCurrentReason(error);
            return;
          }
          rejectLoader(error);
        });
      });
      cargoProcess.once("close", (code, closeSignal) => {
        settle(() => {
          clearCleanupTracking();
          if (controller.signal.aborted) {
            rejectWithCurrentReason(timeoutError);
            return;
          }
          if (timeoutError !== void 0) {
            rejectLoader(timeoutError);
            return;
          }
          if (terminationError !== void 0) {
            rejectLoader(terminationError);
            return;
          }
          if (code === 0 && closeSignal === null) {
            resolveLoader(stdoutChunks.join(""));
            return;
          }
          const stderrOutput = stderrChunks.join("").trim();
          const exitDetail = closeSignal === null ? `exit code ${code ?? 0}` : `signal ${closeSignal}`;
          rejectLoader(
            new Error(
              stderrOutput.length > 0 ? `cargo metadata failed with ${exitDetail}: ${stderrOutput}` : `cargo metadata failed with ${exitDetail}`
            )
          );
        });
      });
    });
  } finally {
    unlinkParentSignal();
    releaseCargoMetadataController(controller);
  }
}
var CARGO_METADATA_MAX_BUFFER, CARGO_METADATA_TIMEOUT_MS, CARGO_METADATA_FORCE_KILL_DELAY_MS, activeCargoMetadataCleanups, removeProcessSignalHandlers;
var init_cargo_metadata_process = __esm({
  "src/lsp/cargo-metadata-process.ts"() {
    "use strict";
    init_environment();
    init_process_options();
    init_process();
    init_process_signal_cleanup();
    CARGO_METADATA_MAX_BUFFER = 64 * 1024 * 1024;
    CARGO_METADATA_TIMEOUT_MS = 1e4;
    CARGO_METADATA_FORCE_KILL_DELAY_MS = 250;
    activeCargoMetadataCleanups = /* @__PURE__ */ new Set();
  }
});

// src/lsp/cargo-workspace-root.ts
import { existsSync as existsSync2, realpathSync as realpathSync2 } from "node:fs";
import { dirname as dirname6, join as join13 } from "node:path";
function realpathSafe(path) {
  try {
    return realpathSync2.native(path);
  } catch {
    return path;
  }
}
function nearestCargoManifestDir(startDir) {
  let dir = startDir;
  let prev = "";
  while (dir !== prev) {
    if (existsSync2(join13(dir, "Cargo.toml"))) return dir;
    prev = dir;
    dir = dirname6(dir);
  }
  return void 0;
}
function cacheEntryFor(root, memberManifestDir) {
  const snapshots2 = readAncestorManifestSnapshots(memberManifestDir);
  return snapshots2 === void 0 ? void 0 : { root, snapshots: snapshots2 };
}
function prepareCargoWorkspaceCache(manifestDir, metadata) {
  const entries = /* @__PURE__ */ new Map();
  for (const manifestPath of metadata.memberManifestPaths) {
    const manifestDir2 = dirname6(manifestPath);
    const entry = cacheEntryFor(metadata.workspaceRoot, manifestDir2);
    if (entry === void 0) return void 0;
    entries.set(manifestDir2, entry);
  }
  const requestedManifestPath = canonicalManifest(join13(manifestDir, "Cargo.toml"));
  if (requestedManifestPath === void 0) return void 0;
  const requestedEntry = cacheEntryFor(metadata.workspaceRoot, dirname6(requestedManifestPath));
  if (requestedEntry === void 0) return void 0;
  entries.set(manifestDir, requestedEntry);
  return { root: metadata.workspaceRoot, entries };
}
function preparedCacheIsFresh(prepared) {
  for (const entry of prepared.entries.values()) {
    if (!snapshotsAreFresh(entry.snapshots)) return false;
  }
  return true;
}
function commitCargoWorkspaceCache(prepared) {
  for (const [manifestDir, entry] of prepared.entries) {
    cargoWorkspaceRootCache.set(manifestDir, entry);
  }
}
function cacheCargoWorkspaceFailure(manifestDir, nowMs, snapshots2) {
  cargoWorkspaceRootFailures.set(manifestDir, {
    expiresAtMs: nowMs + CARGO_METADATA_FAILURE_BACKOFF_MS,
    snapshots: snapshots2
  });
}
function cacheCargoWorkspaceLoadFailure(request) {
  cacheCargoWorkspaceFailure(request.manifestDir, request.now(), request.generation.snapshots);
}
function cachedCargoWorkspaceFailure(manifestDir, nowMs) {
  const cached = cargoWorkspaceRootFailures.get(manifestDir);
  if (cached === void 0) return false;
  if (nowMs >= cached.expiresAtMs) {
    cargoWorkspaceRootFailures.delete(manifestDir);
    return false;
  }
  if (snapshotsAreFresh(cached.snapshots)) return true;
  cargoWorkspaceRootFailures.delete(manifestDir);
  return false;
}
function isAbortError(error) {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return error instanceof Error && error.name === "AbortError";
}
function sameCargoWorkspaceGeneration(left, right) {
  if (left.snapshots.length !== right.snapshots.length) return false;
  return left.snapshots.every((snapshot, index) => {
    const candidate = right.snapshots[index];
    return candidate !== void 0 && candidate.path === snapshot.path && candidate.exists === snapshot.exists && candidate.content === snapshot.content;
  });
}
function deleteInFlight(manifestDir, inFlight) {
  if (cargoWorkspaceRootInFlight.get(manifestDir)?.operation === inFlight) {
    cargoWorkspaceRootInFlight.delete(manifestDir);
  }
}
function createInFlightCargoWorkspaceRoot(request) {
  let inFlight;
  inFlight = createSharedAbortableOperation(
    (signal) => loadCargoWorkspaceRoot({ ...request, signal }),
    () => {
      deleteInFlight(request.manifestDir, inFlight);
    },
    () => {
      deleteInFlight(request.manifestDir, inFlight);
    }
  );
  return inFlight;
}
async function loadCargoWorkspaceRoot(request) {
  try {
    request.signal?.throwIfAborted();
    const manifestPath = join13(request.manifestDir, "Cargo.toml");
    const output = await request.loader(manifestPath, request.signal);
    request.signal?.throwIfAborted();
    if (!snapshotsAreFresh(request.generation.snapshots)) {
      cacheCargoWorkspaceLoadFailure(request);
      return void 0;
    }
    const metadata = parseTrustedCargoMetadata(manifestPath, output);
    if (metadata === void 0 || !snapshotsAreFresh(request.generation.snapshots)) {
      cacheCargoWorkspaceLoadFailure(request);
      return void 0;
    }
    const prepared = prepareCargoWorkspaceCache(request.manifestDir, metadata);
    if (prepared === void 0 || !snapshotsAreFresh(request.generation.snapshots) || !preparedCacheIsFresh(prepared)) {
      cacheCargoWorkspaceLoadFailure(request);
      return void 0;
    }
    commitCargoWorkspaceCache(prepared);
    cargoWorkspaceRootFailures.delete(request.manifestDir);
    return prepared.root;
  } catch (error) {
    if (request.signal?.aborted || isAbortError(error)) throw error;
    cacheCargoWorkspaceLoadFailure(request);
    return void 0;
  }
}
function cachedCargoWorkspaceRoot(manifestDir) {
  const cached = cargoWorkspaceRootCache.get(manifestDir);
  if (cached === void 0) return void 0;
  if (snapshotsAreFresh(cached.snapshots)) return cached.root;
  cargoWorkspaceRootCache.delete(manifestDir);
  return void 0;
}
async function cargoWorkspaceRoot(request) {
  request.signal?.throwIfAborted();
  const cached = cachedCargoWorkspaceRoot(request.manifestDir);
  if (cached !== void 0) return cached;
  const nowMs = request.now();
  if (cachedCargoWorkspaceFailure(request.manifestDir, nowMs)) return void 0;
  const snapshots2 = readAncestorManifestSnapshots(request.manifestDir);
  if (snapshots2 === void 0) return void 0;
  const generation = { snapshots: snapshots2 };
  const inFlight = cargoWorkspaceRootInFlight.get(request.manifestDir);
  if (inFlight !== void 0 && sameCargoWorkspaceGeneration(inFlight.generation, generation)) {
    return awaitSharedAbortableOperation(inFlight.operation, request.signal);
  }
  const newInFlight = createInFlightCargoWorkspaceRoot({ ...request, generation });
  cargoWorkspaceRootInFlight.set(request.manifestDir, { generation, operation: newInFlight });
  return awaitSharedAbortableOperation(newInFlight, request.signal);
}
async function resolveCargoWorkspaceRoot(startDir, options = {}) {
  const manifestDir = nearestCargoManifestDir(realpathSafe(startDir));
  if (manifestDir === void 0) return void 0;
  const canonicalManifestDir = realpathSafe(manifestDir);
  const root = await cargoWorkspaceRoot({
    manifestDir: canonicalManifestDir,
    loader: options.cargoMetadataLoader ?? defaultCargoMetadataLoader,
    now: options.now ?? Date.now,
    signal: options.signal
  });
  return root ?? canonicalManifestDir;
}
var CARGO_METADATA_FAILURE_BACKOFF_MS, cargoWorkspaceRootCache, cargoWorkspaceRootFailures, cargoWorkspaceRootInFlight;
var init_cargo_workspace_root = __esm({
  "src/lsp/cargo-workspace-root.ts"() {
    "use strict";
    init_abortable_shared_operation();
    init_cargo_manifest_snapshot();
    init_cargo_metadata_parser();
    init_cargo_metadata_process();
    CARGO_METADATA_FAILURE_BACKOFF_MS = 1e3;
    cargoWorkspaceRootCache = /* @__PURE__ */ new Map();
    cargoWorkspaceRootFailures = /* @__PURE__ */ new Map();
    cargoWorkspaceRootInFlight = /* @__PURE__ */ new Map();
  }
});

// src/lsp/workspace-root.ts
import { existsSync as existsSync3, statSync as statSync3 } from "node:fs";
import { dirname as dirname7, join as join14, resolve as resolve8 } from "node:path";
function isDirectoryPath(filePath) {
  try {
    return statSync3(filePath).isDirectory();
  } catch {
    return false;
  }
}
async function findWorkspaceRoot(filePath, server2, options = {}) {
  const abs = resolve8(filePath);
  let dir = abs;
  if (!isDirectoryPath(dir)) {
    dir = dirname7(dir);
  }
  if (server2?.id === "rust") {
    const cargoRoot = await resolveCargoWorkspaceRoot(dir, options);
    if (cargoRoot !== void 0) return cargoRoot;
  }
  let prevDir = "";
  while (dir !== prevDir) {
    const markers = server2?.extensions.some((extension) => [".c", ".cpp", ".cc", ".h"].includes(extension)) ? [".clangd", "compile_commands.json", "compile_flags.txt", ...WORKSPACE_MARKERS] : WORKSPACE_MARKERS;
    for (const marker of markers) {
      if (existsSync3(join14(dir, marker))) {
        return dir;
      }
    }
    prevDir = dir;
    dir = dirname7(dir);
  }
  return dirname7(abs);
}
var WORKSPACE_MARKERS;
var init_workspace_root = __esm({
  "src/lsp/workspace-root.ts"() {
    "use strict";
    init_cargo_workspace_root();
    WORKSPACE_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle"];
  }
});

// src/language.ts
import { readFile as readFile13, writeFile as writeFile5 } from "node:fs/promises";
import { dirname as dirname8, extname as extname5, relative as relative5, resolve as resolve9 } from "node:path";
import { fileURLToPath as fileURLToPath2, pathToFileURL as pathToFileURL3 } from "node:url";
function diagnosticUriKey(uri) {
  try {
    const path = fileURLToPath2(uri);
    return pathToFileURL3(
      process.platform === "win32" ? path.replace(/^[A-Z]:/, (drive) => drive.toLowerCase()) : path
    ).href;
  } catch {
    return uri;
  }
}
var Client, Languages;
var init_language = __esm({
  "src/language.ts"() {
    "use strict";
    init_budgets();
    init_config_files();
    init_environment();
    init_files();
    init_log();
    init_client();
    init_language_mappings();
    init_manager();
    init_workspace_root();
    init_metrics();
    init_results();
    init_runners();
    init_tool_resolution();
    Client = class extends LspClient {
      constructor() {
        super(...arguments);
        this.stopping = false;
        this.published = /* @__PURE__ */ new Map();
        this.capabilities = {};
        this.progress = /* @__PURE__ */ new Set();
        this.progressAt = 0;
        this.serverBusy = false;
        this.savedVersions = /* @__PURE__ */ new Map();
        this.pulls = /* @__PURE__ */ new Map();
        this.proven = /* @__PURE__ */ new Set();
        this.versions = /* @__PURE__ */ new Map();
        this.dirty = /* @__PURE__ */ new Set();
      }
      serverIdentity() {
        return this.server.id;
      }
      stop() {
        if (this.stopTask) return this.stopTask;
        this.stopping = true;
        const proc = this.proc;
        const timer = setTimeout(() => {
          proc?.kill("SIGKILL");
          this.connection?.dispose();
        }, 500);
        this.stopTask = super.stop().finally(() => clearTimeout(timer));
        return this.stopTask;
      }
      isRustAnalyzer() {
        return this.server.command.some((argument) => /rust-analyzer/.test(argument));
      }
      async settle(deadline, signal) {
        const busy = () => this.serverBusy || this.progress.size > 0 || Date.now() - this.progressAt < BUDGET.lspQuiet;
        while (busy() && Date.now() < deadline) {
          signal?.throwIfAborted();
          await new Promise((resolve12) => setTimeout(resolve12, 25));
        }
        signal?.throwIfAborted();
        return !busy();
      }
      supports(operation) {
        if (operation === "prepare_rename") {
          const provider = this.capabilities["renameProvider"];
          return record(provider) && provider["prepareProvider"] === true;
        }
        const names = {
          definition: "definitionProvider",
          references: "referencesProvider",
          symbols: "documentSymbolProvider",
          prepare_rename: "renameProvider",
          rename: "renameProvider",
          format: "documentFormattingProvider"
        };
        return Boolean(this.capabilities[names[operation] ?? operation]);
      }
      async sendNotification(method, params) {
        await super.sendNotification(method, method === "initialized" ? params ?? {} : params);
      }
      async sendRequest(method, params) {
        if (method === "initialize" && record(params) && record(params["capabilities"])) {
          const capabilities = params["capabilities"];
          capabilities["window"] = { workDoneProgress: true };
          capabilities["experimental"] = { serverStatusNotification: true };
          if (record(capabilities["textDocument"])) {
            capabilities["textDocument"]["publishDiagnostics"] = { versionSupport: true };
            capabilities["textDocument"]["diagnostic"] = { dynamicRegistration: false };
          }
        }
        let result;
        if (method === "initialize" && this.connection) {
          let timer;
          try {
            result = await Promise.race([
              this.connection.sendRequest(method, params),
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(
                    new Error(`LSP initialization/download timeout: ${this.stderrBuffer.slice(-5).join("\n")}`)
                  ),
                  BUDGET.lspRequest
                );
              })
            ]);
          } finally {
            clearTimeout(timer);
          }
        } else {
          if (!this.connection) throw new Error("LSP client not started");
          const signal = this.requestSignal ? AbortSignal.any([this.requestSignal, AbortSignal.timeout(BUDGET.lspRequest)]) : AbortSignal.timeout(BUDGET.lspRequest);
          if (this.isRustAnalyzer() && (method.startsWith("textDocument/") || method === "workspace/symbol") && !await this.settle(Date.now() + BUDGET.lspRequest, signal))
            throw new Error("LSP analysis pending: rust-analyzer is still indexing");
          result = await this.connection.sendRequest(method, params, signal);
        }
        if (method === "initialize" && record(result) && record(result["capabilities"]))
          this.capabilities = result["capabilities"];
        return result;
      }
      async navigation(method, path, line, character) {
        const capability = {
          hover: "hoverProvider",
          typeDefinition: "typeDefinitionProvider",
          implementation: "implementationProvider",
          signatureHelp: "signatureHelpProvider"
        };
        if (!this.capabilities[capability[method] ?? ""]) return { status: "unsupported", operation: method };
        await this.openFile(path);
        return this.sendRequest(`textDocument/${method}`, {
          textDocument: { uri: pathToFileURL3(path).href },
          position: { line: line - 1, character }
        });
      }
      async start() {
        this.serverBusy = this.isRustAnalyzer();
        try {
          await super.start();
        } catch (error) {
          await logEvent("startup-failure");
          throw error;
        }
        void this.proc?.exited.then(() => {
          if (!this.stopping) return logEvent("abnormal-exit");
          return void 0;
        });
        this.connection?.onNotification("experimental/serverStatus", (value) => {
          if (!record(value) || typeof value["quiescent"] !== "boolean") return;
          this.serverBusy = !value["quiescent"] || value["health"] === "error";
          this.progressAt = Date.now();
        });
        this.connection?.onNotification("$/progress", (value) => {
          if (!record(value) || !record(value["value"])) return;
          const token = String(value["token"]);
          if (value["value"]["kind"] === "end") this.progress.delete(token);
          else this.progress.add(token);
          this.progressAt = Date.now();
        });
        this.connection?.onNotification("textDocument/publishDiagnostics", (value) => {
          if (!record(value) || typeof value["uri"] !== "string" || !Array.isArray(value["diagnostics"])) return;
          const items2 = value["diagnostics"];
          const version = value["version"];
          this.published.set(
            diagnosticUriKey(value["uri"]),
            typeof version === "number" ? { version, items: items2, time: Date.now() } : { items: items2, time: Date.now() }
          );
        });
      }
      async openFile(path) {
        const uri = pathToFileURL3(path).href;
        const content = await readFile13(path, "utf8");
        const previous = this.versions.get(uri);
        if (previous?.content === content && !this.dirty.has(uri)) return;
        this.dirty.delete(uri);
        this.published.delete(diagnosticUriKey(uri));
        const version = (previous?.version ?? 0) + 1;
        this.versions.set(uri, { content, version });
        if (previous) {
          await this.sendNotification("textDocument/didChange", {
            textDocument: { uri, version },
            contentChanges: [{ text: content }]
          });
        } else {
          await this.sendNotification("textDocument/didOpen", {
            textDocument: { uri, version, languageId: getLanguageId(extname5(path)), text: content }
          });
        }
        if (this.isRustAnalyzer()) this.progressAt = Date.now();
      }
      async refresh(changes) {
        changes = changes.filter(
          ({ path }) => inside(this.root, path) && (!configurationImpact(path).length || configurationImpact(path).includes("types")) && (this.server.extensions.includes(extname5(path)) || configurationLanguages(path).some(
            (language) => this.server.extensions.some(
              (extension) => getLanguageId(extension) === language || language === "cpp" && ["c", "cpp"].includes(getLanguageId(extension))
            )
          ))
        );
        if (!changes.length) return;
        for (const uri of this.versions.keys()) {
          this.dirty.add(uri);
          this.published.delete(diagnosticUriKey(uri));
          this.pulls.delete(uri);
        }
        for (const { path, type } of changes) {
          const uri = pathToFileURL3(path).href;
          if (type === 3) {
            if (this.versions.has(uri)) await this.sendNotification("textDocument/didClose", { textDocument: { uri } });
            this.versions.delete(uri);
            this.published.delete(diagnosticUriKey(uri));
            this.pulls.delete(uri);
            this.savedVersions.delete(uri);
          } else if (this.versions.has(uri)) await this.openFile(path);
        }
        await this.sendNotification("workspace/didChangeWatchedFiles", {
          changes: changes.map(({ path, type }) => ({ uri: pathToFileURL3(path).href, type }))
        });
      }
      async collect(path, signal) {
        const uri = pathToFileURL3(path).href;
        const cold = !this.versions.has(uri);
        await this.openFile(path);
        const settling = Date.now() + (cold ? BUDGET.lspCold : BUDGET.lspWarm);
        if (!await this.settle(settling, signal)) return { items: [], ready: false };
        const version = this.versions.get(uri)?.version;
        if (version !== void 0 && this.savedVersions.get(uri) !== version) {
          await this.sendNotification("textDocument/didSave", { textDocument: { uri } });
          this.savedVersions.set(uri, version);
          if (this.isRustAnalyzer()) {
            this.progressAt = Date.now();
            if (!await this.settle(settling, signal)) return { items: [], ready: false };
          }
        }
        if (this.capabilities["diagnosticProvider"]) {
          const previous = this.pulls.get(uri);
          const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, settling - Date.now()))]);
          if (!this.connection) return { items: [], ready: false };
          const result = await this.connection.sendRequest(
            "textDocument/diagnostic",
            { textDocument: { uri }, ...previous ? { previousResultId: previous.resultId } : {} },
            requestSignal
          );
          signal.throwIfAborted();
          if (requestSignal.aborted || Date.now() > settling) return { items: [], ready: false };
          if (result.kind === "unchanged" && previous)
            return { items: previous.items, ready: true, evidence: "pull-unchanged" };
          if (Array.isArray(result.items)) {
            if (result.resultId) this.pulls.set(uri, { resultId: result.resultId, items: result.items });
            return { items: result.items, ready: true, evidence: "pull-full" };
          }
          return { items: [], ready: false };
        }
        const deadline = settling;
        while (Date.now() < deadline) {
          signal.throwIfAborted();
          const result = this.published.get(diagnosticUriKey(uri));
          if (result && Date.now() - result.time >= 200 && !this.progress.size && Date.now() - this.progressAt >= 200 && (result.version === void 0 || result.version === this.versions.get(uri)?.version)) {
            if (!(result.version === void 0 && result.items.length === 0 && !this.proven.has(uri))) {
              this.proven.add(uri);
              return {
                items: result.items,
                ready: true,
                evidence: result.version === void 0 ? "push-unversioned (weak freshness evidence)" : "push-versioned"
              };
            }
          }
          await new Promise((resolve12) => setTimeout(resolve12, 25));
        }
        return { items: [], ready: false };
      }
      async formatting(path, options) {
        if (!this.supports("format")) throw new Error("unsupported: document formatting");
        await this.openFile(path);
        return await this.sendRequest("textDocument/formatting", {
          textDocument: { uri: pathToFileURL3(path).href },
          options
        }) ?? [];
      }
    };
    Languages = class {
      constructor(root, config) {
        this.root = root;
        this.config = config;
        this.clients = /* @__PURE__ */ new Set();
        this.processStarts = 0;
        this.snapshot = /* @__PURE__ */ new Map();
        this.failures = /* @__PURE__ */ new Map();
        this.manager = new LspManager({
          idleTimeoutMs: BUDGET.idle,
          clientFactory: (root2, server2) => {
            if (!inside(this.root, root2))
              throw new Error("LSP root outside workspace; choose the enclosing project as workspace");
            this.processStarts++;
            const client = new Client(root2, server2, executionEnvironment());
            this.clients.add(client);
            return client;
          }
        });
      }
      statistics() {
        return {
          processStarts: this.processStarts,
          running: [...this.clients].filter((client) => client.isAlive()).length
        };
      }
      async sync(files) {
        const changed = [.../* @__PURE__ */ new Set([...files.keys(), ...this.snapshot.keys()])].filter(
          (path) => files.get(path) !== this.snapshot.get(path)
        );
        const events = changed.map((path) => ({
          path: resolve9(this.root, path),
          type: !files.has(path) ? 3 : !this.snapshot.has(path) ? 1 : 2
        }));
        this.snapshot = new Map(files);
        for (const client of this.clients) {
          if (!client.isAlive()) {
            this.clients.delete(client);
            continue;
          }
          await client.refresh(events);
        }
      }
      async update(config) {
        for (const managed of this.manager.getSnapshot()) {
          if (config.trusted !== this.config.trusted || Object.keys(this.config.servers).some((language) => {
            const previous = this.config.servers[language];
            return previous && managed.serverId.startsWith(`${previous.id}:`) && JSON.stringify(previous) !== JSON.stringify(config.servers[language]);
          }))
            this.manager.invalidateClient(managed.root, managed.serverId);
        }
        this.config = config;
      }
      async invalidate(path) {
        const directory2 = dirname8(resolve9(this.root, path));
        const language = configurationImpact(path).length ? void 0 : (await resolveServer(this.root, path, this.config).catch(() => void 0))?.language;
        const languages = language ? [language] : configurationLanguages(path);
        for (const managed of this.manager.getSnapshot()) {
          if ((inside(directory2, managed.root) || inside(managed.root, directory2)) && languages.some((language2) => {
            const server2 = this.config.servers[language2];
            return server2 && managed.serverId.startsWith(`${server2.id}:`);
          }))
            this.manager.invalidateClient(managed.root, managed.serverId);
        }
      }
      async status(path) {
        const resolved = await resolveServer(this.root, path, this.config);
        const failure = [...this.failures.values()].filter((entry) => entry.identity === resolved.tool.identity && inside(entry.root, resolve9(this.root, path))).sort((a, b) => b.root.length - a.root.length)[0];
        return {
          ...resolved,
          lint: this.config.trusted ? await select(this.root, resolve9(this.root, path), false, this.config).catch((error) => ({
            unavailable: message(error)
          })) ?? { unavailable: "No configured lint runner" } : { unavailable: "Workspace trust required" },
          running: [...this.clients].some(
            (client) => client.isAlive() && client.serverIdentity() === `${resolved.server.id}:${hash(JSON.stringify([resolved.server, resolved.tool.identity])).slice(0, 16)}`
          ),
          failure: failure && Date.now() < failure.retryAt ? failure.reason : void 0,
          retryAt: failure?.retryAt,
          recovery: "Install or repair the local tool, then lsp_status refresh=true; failure cooldown is 30/60/120 seconds, capped at 300 seconds"
        };
      }
      async preflight(path, signal, operation) {
        await this.withLspClient(
          await workspacePath(this.root, path),
          async (client) => {
            if (operation && client instanceof Client && !client.supports(operation))
              throw new Error(`unsupported: ${operation}`);
          },
          "preflight",
          {
            manager: this.manager,
            signal
          }
        );
      }
      async withLspClient(path, fn, _tool, options) {
        const resolved = await resolveServer(this.root, path, this.config);
        if (resolved.tool.source === "missing") throw new Error(resolved.tool.note);
        if (resolved.tool.source === "temporary" && !this.config.trusted)
          throw new Error("Temporary tool execution requires workspace trust in Codex user config.toml");
        let root = await findWorkspaceRoot(path, resolved.server, { signal: options.signal });
        if (!inside(this.root, root)) root = this.root;
        if (resolved.language === "python" && resolved.tool.source === "project" && resolved.tool.command[0]?.includes(".venv"))
          root = dirname8(dirname8(dirname8(resolved.tool.command[0])));
        const failureKey = hash(JSON.stringify([root, resolved.server, resolved.tool.identity]));
        const failed = this.failures.get(failureKey);
        if (failed && Date.now() < failed.retryAt) throw new Error(failed.reason);
        resolved.server.id += `:${hash(JSON.stringify([resolved.server, resolved.tool.identity])).slice(0, 16)}`;
        for (const managed of options.manager.getSnapshot())
          if (managed.root === root && managed.serverId.startsWith(`${resolved.server.id.split(":")[0]}:`) && managed.serverId !== resolved.server.id)
            options.manager.invalidateClient(managed.root, managed.serverId);
        let client;
        try {
          client = await measured(
            "startup/acquire",
            () => options.manager.getClient(root, resolved.server, options.signal)
          );
        } catch (error) {
          if (options.signal.aborted) throw error;
          const attempts = (failed?.attempts ?? 0) + 1;
          this.failures.set(failureKey, {
            identity: resolved.tool.identity,
            root,
            attempts,
            retryAt: Date.now() + Math.min(3e5, 3e4 * 2 ** Math.min(attempts - 1, 4)),
            reason: (resolved.tool.source === "temporary" ? "Temporary launch/download or initialization failed: " : "Local initialization failed (no fallback): ") + message(error)
          });
          const reason = this.failures.get(failureKey)?.reason;
          while (this.failures.size > 64) this.failures.delete(this.failures.keys().next().value ?? "");
          throw new Error(reason);
        }
        this.failures.delete(failureKey);
        try {
          if (client instanceof Client) client.requestSignal = options.signal;
          return await fn(client);
        } finally {
          if (client instanceof Client) client.requestSignal = void 0;
          options.manager.releaseClient(root, resolved.server.id);
        }
      }
      async check(path, signal) {
        try {
          return await this.withLspClient(
            await workspacePath(this.root, path),
            async (client) => {
              if (!(client instanceof Client)) throw new Error("Unexpected LSP client");
              const absolute = await workspacePath(this.root, path);
              const result = await measured("diagnostics/wait", () => client.collect(absolute, signal));
              return {
                path,
                state: result.ready ? "complete" : "pending",
                findings: result.items.filter((item) => item.severity === 1 || item.severity === 2).map((item) => ({
                  path,
                  line: item.range.start.line + 1,
                  column: item.range.start.character + 1,
                  severity: item.severity === 1 ? "error" : "warning",
                  source: `${item.source ?? "lsp"}${item.code === void 0 ? "" : `/${item.code}`}`,
                  message: item.message
                })),
                note: result.ready ? result.evidence ?? "fresh diagnostics" : "No fresh diagnostics published yet"
              };
            },
            "diagnostics",
            { manager: this.manager, signal }
          );
        } catch (error) {
          const note = message(error);
          if (/server cancelled|content modified|cancelled|timeout|timed out/i.test(note) || record(error) && [-32801, -32802].includes(Number(error["code"])))
            return { path, state: "pending", findings: [], note: "Server is updating its analysis; retry" };
          if (!/No LSP server|NOT INSTALLED/.test(note))
            await logEvent(/timeout/i.test(note) ? "timeout" : "startup-failure");
          return {
            path,
            state: /disabled or unsupported|Tool missing|Explicit command missing/.test(note) ? "skipped" : "failed",
            findings: [],
            note
          };
        }
      }
      async navigate(args, signal) {
        const path = await workspacePath(this.root, text(args["path"]));
        const operation = text(args["operation"]);
        const line = number(args["line"], 1, 1, 1e7);
        const column = number(args["column"], 1, 1, 1e6) - 1;
        const before = operation === "rename" ? await inventory(this.root, 1e4, signal) : void 0;
        return this.withLspClient(
          path,
          async (client) => {
            if (client instanceof Client && ["definition", "references", "symbols", "prepare_rename"].includes(operation) && !client.supports(operation === "symbols" && args["query"] ? "workspaceSymbolProvider" : operation))
              return { status: "unsupported", operation };
            let result;
            switch (operation) {
              case "hover":
              case "typeDefinition":
              case "implementation":
              case "signatureHelp":
                if (!(client instanceof Client)) throw new Error("Unexpected client");
                result = await client.navigation(operation, path, line, column);
                break;
              case "definition":
                result = await client.definition(path, line, column);
                break;
              case "references":
                result = await client.references(path, line, column);
                break;
              case "symbols":
                result = args["query"] ? await client.workspaceSymbols(text(args["query"])) : await client.documentSymbols(path);
                break;
              case "prepare_rename":
                result = await client.prepareRename(path, line, column);
                break;
              case "rename": {
                if (!before?.complete) throw new Error("Cannot safely snapshot workspace for rename");
                const name = text(args["newName"]);
                if (!name) throw new Error("newName required");
                const edit = await client.rename(path, line, column, name);
                return this.applyRename(edit, before.version, signal);
              }
              default:
                throw new Error("Unknown navigation operation");
            }
            const output = JSON.stringify(result ?? []);
            if (output.length <= 8e3) return { status: "complete", result: result ?? [] };
            if (!Array.isArray(result)) return { status: "too_large", note: "Narrow query/path" };
            const items2 = [];
            for (const item of result) {
              if (JSON.stringify([...items2, item]).length > 7600) break;
              items2.push(item);
            }
            return { status: "partial", items: items2, omitted: result.length - items2.length };
          },
          operation,
          { manager: this.manager, signal }
        );
      }
      async applyRename(edit, version, signal) {
        if (!edit) return { status: "unchanged", modifiedPaths: [] };
        const changes = /* @__PURE__ */ new Map();
        for (const [uri, edits] of Object.entries(edit.changes ?? {})) changes.set(uri, edits);
        for (const change of edit.documentChanges ?? []) {
          if ("kind" in change) throw new Error("Resource operations are not permitted by rename");
          if (changes.has(change.textDocument.uri)) throw new Error("Duplicate rename target");
          changes.set(change.textDocument.uri, change.edits);
        }
        const pending = [];
        for (const [uri, edits] of changes) {
          const path = await workspacePath(this.root, fileURLToPath2(uri));
          await this.preflight(path, signal);
          const before = await readFile13(path, "utf8");
          pending.push({ path, before, after: applyTextChanges(before, edits) });
        }
        if ((await inventory(this.root, 1e4, signal)).version !== version)
          throw new Error("Workspace changed during rename; retry");
        for (const item of pending)
          if (await readFile13(item.path, "utf8") !== item.before) throw new Error("Rename conflict");
        signal.throwIfAborted();
        const modified = [];
        try {
          for (const item of pending) {
            signal.throwIfAborted();
            await writeFile5(item.path, item.after);
            modified.push(relative5(this.root, item.path));
          }
        } catch (error) {
          throw new WriteFailure(`${message(error)}; modified paths: ${JSON.stringify(modified)}`, modified);
        }
        return { status: "renamed", modifiedPaths: modified };
      }
      async format(path, signal) {
        const absolute = await workspacePath(this.root, path);
        const before = await readFile13(absolute, "utf8");
        const edits = await this.withLspClient(
          absolute,
          async (client) => {
            if (!(client instanceof Client)) throw new Error("Unexpected LSP client");
            return client.formatting(absolute, this.config.formatting);
          },
          "format",
          { manager: this.manager, signal }
        );
        const after = applyTextChanges(before, edits);
        if (await readFile13(absolute, "utf8") !== before) throw new Error("File changed during formatting; retry");
        if (after === before) return { status: "unchanged", path, modifiedPaths: [] };
        signal.throwIfAborted();
        await writeFile5(absolute, after);
        return { status: "formatted", path, modifiedPaths: [path] };
      }
      async close() {
        await this.manager.stopAll();
      }
    };
  }
});

// src/project-output.ts
import { readFile as readFile14 } from "node:fs/promises";
import { relative as relative6, resolve as resolve10 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";
async function projectOutput(check, output, root, cwd) {
  const pathOf = (file) => {
    const absolute = resolve10(cwd, file);
    if (!inside(root, absolute)) throw new Error("Checker diagnostic outside workspace");
    return relative6(root, absolute);
  };
  if (check.parser === "sarif") {
    if (!output.trim()) return [];
    const data = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
    if (!record(data) || !Array.isArray(data["runs"])) throw new Error("Malformed SARIF checker output");
    const findings2 = [];
    for (const run2 of data["runs"]) {
      if (!record(run2) || !Array.isArray(run2["results"])) throw new Error("Malformed SARIF run");
      for (const result of run2["results"]) {
        if (!record(result) || !["error", "warning"].includes(String(result["level"]))) continue;
        const locations = result["locations"];
        const first = Array.isArray(locations) ? locations[0] : void 0;
        const physical = record(first) && record(first["physicalLocation"]) ? first["physicalLocation"] : {};
        const artifact = record(physical["artifactLocation"]) ? physical["artifactLocation"] : {};
        const region = record(physical["region"]) ? physical["region"] : {};
        const uri = text(artifact["uri"]);
        if (!uri || !record(result["message"])) throw new Error("Unlocated SARIF diagnostic");
        findings2.push({
          path: pathOf(uri.startsWith("file:") ? fileURLToPath3(uri) : decodeURI(uri)),
          line: Number(region["startLine"] ?? 1),
          column: Number(region["startColumn"] ?? 1),
          severity: result["level"] === "error" ? "error" : "warning",
          source: `compiler/${text(result["ruleId"], "diagnostic")}`,
          message: text(result["message"]["text"])
        });
      }
    }
    return findings2;
  }
  if (["ruff", "eslint", "biome"].includes(check.parser)) {
    const split = splitLint(check.parser, JSON.parse(output), root, cwd);
    const findings2 = [];
    for (const [path, data] of split)
      findings2.push(...parseLint(check.parser, data, path, await readFile14(resolve10(root, path), "utf8")));
    return findings2;
  }
  if (check.parser === "json") {
    const data = JSON.parse(output);
    if (!record(data) || !Array.isArray(data["diagnostics"]))
      throw new Error("Custom checker requires {diagnostics: [...]} output");
    return data["diagnostics"].map((item) => {
      if (!record(item) || typeof item["path"] !== "string" || typeof item["message"] !== "string" || !["error", "warning"].includes(String(item["severity"])) || !Number.isInteger(item["line"]) || Number(item["line"]) < 1 || !Number.isInteger(item["column"]) || Number(item["column"]) < 1)
        throw new Error("Malformed custom diagnostic");
      return {
        path: pathOf(item["path"]),
        message: item["message"],
        line: Number(item["line"]),
        column: Number(item["column"]),
        severity: item["severity"] === "error" ? "error" : "warning",
        source: text(item["source"], check.name)
      };
    });
  }
  const findings = [];
  if (check.parser === "cargo") {
    for (const line of output.split("\n").filter(Boolean)) {
      const item = JSON.parse(line);
      if (!record(item) || item["reason"] !== "compiler-message" || !record(item["message"])) continue;
      const diagnostic = item["message"];
      if (!["error", "warning"].includes(String(diagnostic["level"]))) continue;
      const spans = diagnostic["spans"];
      const span = Array.isArray(spans) ? spans.find((entry) => record(entry) && entry["is_primary"] === true) : void 0;
      if (!record(span) || typeof span["file_name"] !== "string")
        throw new Error(text(diagnostic["message"], "Cargo diagnostic without location"));
      findings.push({
        path: pathOf(span["file_name"]),
        line: Number(span["line_start"]),
        column: Number(span["column_start"]),
        severity: diagnostic["level"] === "error" ? "error" : "warning",
        message: text(diagnostic["message"]),
        source: `rust/${record(diagnostic["code"]) ? text(diagnostic["code"]["code"], "compiler") : "compiler"}`
      });
    }
    return findings;
  }
  for (const line of output.split("\n")) {
    const match = check.parser === "tsc" ? /^(.*?)\((\d+),(\d+)\): (error|warning) TS(\d+): (.*)$/.exec(line) : /^(.*?):(\d+):(\d+): (error|warning)\[([^\]]+)\] (.*)$/.exec(line);
    if (match)
      findings.push({
        path: pathOf(match[1] ?? ""),
        line: Number(match[2]),
        column: Number(match[3]),
        severity: match[4] === "error" ? "error" : "warning",
        source: `${check.parser === "tsc" ? "ts" : "ty"}/${match[5]}`,
        message: match[6] ?? ""
      });
    else if (/^(?:error|warning)(?: TS\d+|\[)/.test(line.trim()))
      throw new Error(`Unlocated checker diagnostic: ${line}`);
  }
  return findings;
}
var init_project_output = __esm({
  "src/project-output.ts"() {
    "use strict";
    init_files();
    init_lint_output();
    init_results();
    init_runners();
  }
});

// src/project-checks.ts
import { randomUUID as randomUUID5 } from "node:crypto";
import { readdir as readdir4, readFile as readFile15, stat as stat5 } from "node:fs/promises";
import * as nodePath2 from "node:path";
import { join as join15, relative as relative7, resolve as resolve11 } from "node:path";
import { setTimeout as delay2 } from "node:timers/promises";
function normalizedPattern(pattern) {
  return pattern.replace(/^(?:\.\/)+/, "").replace(/\/$/, "");
}
function includePattern(pattern) {
  const normalized = normalizedPattern(pattern);
  if (normalized === "." || normalized === "") return "**/*";
  if (/[*?{}[\]]/.test(normalized) || /\.(?:[cm]?[jt]sx?|pyi?)$/.test(normalized)) return normalized;
  return `${normalized}/**/*`;
}
function covers(check, path) {
  if ((check.parser === "ty" || check.parser === "ruff") && !/\.pyi?$/.test(path)) return false;
  if (check.parser === "tsc" && !/\.[cm]?[jt]sx?$/.test(path)) return false;
  if (check.parser === "cargo" && !/\.rs$/.test(path)) return false;
  const local = relative7(check.cwd === "." ? "" : check.cwd, path).split("\\").join("/");
  return local !== ".." && !local.startsWith("../") && check.coverage.some((pattern) => nodePath2.matchesGlob(local, pattern)) && !check.excluded?.some((pattern) => {
    const normalized = normalizedPattern(pattern);
    return normalized === "." || normalized === "" || nodePath2.matchesGlob(local, normalized) || nodePath2.matchesGlob(local, `${normalized}/**`);
  });
}
var ProjectChecks;
var init_project_checks = __esm({
  "src/project-checks.ts"() {
    "use strict";
    init_dist();
    init_budgets();
    init_config();
    init_config_files();
    init_environment();
    init_files();
    init_identity();
    init_metadata();
    init_project_output();
    init_results();
    init_runners();
    init_tool_resolution();
    ProjectChecks = class {
      constructor(root) {
        this.root = root;
        this.jobs = /* @__PURE__ */ new Map();
        this.sessionJobs = /* @__PURE__ */ new Map();
      }
      cancelSession(session) {
        const id = this.sessionJobs.get(session);
        if (id) this.jobs.get(id)?.controller.abort();
        this.sessionJobs.delete(session);
      }
      get active() {
        return [...this.jobs.values()].some((job) => job.results.some((result) => result.state === "running"));
      }
      async discover(config, signal) {
        if (config.projectChecks !== "auto") return [...config.projectChecks];
        const checks = [];
        const names = await readdir4(this.root);
        const has = async (name) => (await stat5(join15(this.root, name)).catch(() => void 0))?.isFile();
        if (await has("tsconfig.json")) {
          checks.push({
            name: "typescript",
            cwd: ".",
            command: ["tsc", "--noEmit", "--pretty", "false"],
            parser: "tsc",
            coverage: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"]
          });
        }
        if (names.some((name) => ["pyproject.toml", "ty.toml", "ruff.toml", ".ruff.toml"].includes(name)))
          checks.push({
            name: "python",
            cwd: ".",
            command: ["ty", "check", "--output-format", "concise", "--color", "never"],
            parser: "ty",
            coverage: ["**/*.{py,pyi}"]
          });
        if (await has("Cargo.toml"))
          checks.push({
            name: "rust",
            cwd: ".",
            command: ["cargo", "check", "--workspace", "--all-targets", "--message-format=json"],
            parser: "cargo",
            coverage: ["**/*.rs"]
          });
        for (const path of ["representative.py", "representative.ts"]) {
          const enabled = path.endsWith("py") ? checks.some((check) => check.name === "python") : checks.some((check) => check.name === "typescript") || names.some(
            (name) => configurationImpact(name).includes("lint") && configurationLanguages(name).includes("typescript") && !/^(?:package|pnpm-lock|yarn\.lock)/.test(name)
          );
          if (!enabled) continue;
          const expected = path.endsWith("py") ? "ruff" : config.javascript === "eslint" || !await has("biome.json") && !await has("biome.jsonc") ? "eslint" : "biome";
          const runner = await select(this.root, join15(this.root, path), false, config, false, signal).catch(() => ({
            name: expected,
            command: expected,
            prefix: []
          }));
          if (runner)
            checks.push({
              name: runner.name,
              cwd: ".",
              command: [
                runner.command,
                ...runner.prefix,
                ...runner.name === "ruff" ? ["check", "--no-fix", "--no-fix-only", "--output-format", "json", "."] : runner.name === "biome" ? ["lint", "--reporter=json", "--max-diagnostics=none", "."] : ["--format", "json", "."]
              ],
              parser: runner.name,
              coverage: path.endsWith("py") ? ["**/*.{py,pyi}"] : ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"]
            });
        }
        return checks;
      }
      async identity(checks, config, signal) {
        const identities = await Promise.all(
          checks.map(async (check) => {
            const cwd = await workspacePath(this.root, check.cwd);
            const tool2 = await resolveTool(
              config.projectChecks === "auto" ? this.root : cwd,
              join15(cwd, "representative"),
              check.command,
              config.projectChecks !== "auto",
              false
            );
            return [
              check,
              tool2,
              await Promise.all(
                tool2.command.slice(1).map(async (arg) => {
                  const info = await stat5(resolve11(cwd, arg)).catch(() => void 0);
                  return [arg, info?.size, info?.mtimeMs, info?.ctimeMs, info?.ino];
                })
              ),
              await analysisIdentity(
                this.root,
                [relative7(this.root, join15(cwd, "representative"))],
                config,
                signal,
                false
              )
            ];
          })
        );
        return hash(JSON.stringify([config.version, identities]));
      }
      output(job, cursor = 0) {
        const diagnostics = job.results.flatMap((result) => result.findings);
        const state = job.results.some((result) => result.state === "running") ? "running" : job.results.some((result) => result.state === "stale") ? "stale" : job.results.some((result) => result.state === "failed") || !job.checks.length ? "failed" : "complete";
        return {
          operation: "check_project",
          job: job.id,
          state,
          checkers: job.results.map((result) => ({ ...result, findings: [] })),
          diagnostics: diagnostics.slice(cursor, cursor + 100),
          errors: diagnostics.filter((item) => item.severity === "error").length,
          warnings: diagnostics.filter((item) => item.severity === "warning").length,
          ...state === "running" || diagnostics.length > cursor + 100 ? {
            next: {
              workspace: this.root,
              run: "cached",
              job: job.id,
              cursor: diagnostics.length > cursor + 100 ? String(cursor + 100) : "0"
            }
          } : {}
        };
      }
      async request(args, environment, signal) {
        const cached = args["run"] === "cached";
        const id = text(args["job"], this.latest);
        let job = id ? this.jobs.get(id) : void 0;
        if (cached)
          return job ? this.output(job, this.cursor(args)) : {
            operation: "check_project",
            job: id,
            state: "missing",
            checkers: [],
            diagnostics: [],
            errors: 0,
            warnings: 0
          };
        const config = await configuration(this.root);
        if (!config.trusted) throw new Error("Project checks require workspace trust in Codex config.toml");
        const checks = await this.discover(config, signal);
        const identity = await this.identity(checks, config, signal);
        const before = await inventory(this.root, BUDGET.files, signal, config.exclude);
        if (!before.complete) throw new Error("Project snapshot incomplete; baseline unavailable");
        if (!job || args["refresh"] === true || job.identity !== identity || job.before !== before.version) {
          job = await this.start(checks, config, environment, identity, before.version);
        }
        const wait = typeof args["waitMs"] === "number" ? Math.min(BUDGET.stopWait, Math.max(0, args["waitMs"])) : BUDGET.postWait;
        await Promise.race([Promise.allSettled(job.done), delay2(wait, void 0, { signal }).catch(() => void 0)]);
        return this.output(job, this.cursor(args));
      }
      cursor(args) {
        const cursor = Number(text(args["cursor"], "0"));
        if (!Number.isInteger(cursor) || cursor < 0) throw new Error("Invalid project cursor");
        return cursor;
      }
      async start(checks, config, environment, identity, before) {
        const job = {
          id: randomUUID5(),
          identity,
          before,
          checks,
          controller: new AbortController(),
          results: checks.map((check) => ({
            name: check.name,
            parser: check.parser,
            cwd: check.cwd,
            coverage: check.coverage,
            state: "running",
            findings: []
          })),
          done: []
        };
        this.jobs.set(job.id, job);
        this.latest = job.id;
        for (const [index, check] of checks.entries())
          job.done.push(
            withExecution(environment, true, async () => {
              const result = job.results[index];
              if (!result) return;
              const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(BUDGET.project)]);
              try {
                const cwd = await workspacePath(this.root, check.cwd);
                const checkIdentity = await this.identity([check], config, signal);
                const beforeFiles = await inventory(this.root, BUDGET.files, signal, config.exclude);
                const tool2 = await resolveTool(
                  config.projectChecks === "auto" ? this.root : cwd,
                  join15(cwd, "representative"),
                  check.command,
                  config.projectChecks !== "auto",
                  false
                );
                if (tool2.source === "missing") throw new Error(tool2.note ?? "Checker missing");
                if (config.projectChecks === "auto" && check.parser === "tsc") {
                  const shown = await run(tool2.command[0] ?? "", ["--showConfig"], cwd, signal, void 0, {
                    timeout: BUDGET.project,
                    environment
                  });
                  const data = JSON.parse(shown.stdout);
                  if (shown.code !== 0 || !record(data))
                    throw new Error("TypeScript effective configuration unavailable");
                  const pkg = JSON.parse(
                    await readFile15(join15(cwd, "package.json"), "utf8").catch(() => "{}")
                  );
                  if (Array.isArray(data["references"]) && data["references"].length || record(pkg) && pkg["workspaces"])
                    throw new Error("TypeScript references/multi-package projects require explicit projectChecks");
                  const includes = data["include"];
                  const files = data["files"];
                  const excluded = data["exclude"];
                  result.coverage = Array.isArray(includes) ? includes.filter((item) => typeof item === "string").map(includePattern) : Array.isArray(files) ? files.filter((item) => typeof item === "string").map((item) => item.replace(/^\.\//, "")) : ["**/*.{ts,tsx,mts,cts}"];
                  result.excluded = Array.isArray(excluded) ? excluded.filter((item) => typeof item === "string") : [];
                  const compiler = record(data["compilerOptions"]) ? data["compilerOptions"] : {};
                  if (compiler["allowJs"] !== true || compiler["checkJs"] !== true)
                    result.excluded.push("**/*.{js,jsx,mjs,cjs}");
                }
                if (config.projectChecks === "auto" && check.parser === "ty") {
                  const content = await readFile15(join15(cwd, "ty.toml"), "utf8").catch(() => void 0);
                  const data = content ? parse(content) : parse(await readFile15(join15(cwd, "pyproject.toml"), "utf8").catch(() => ""));
                  const toolConfig = content ? data : record(data["tool"]) && record(data["tool"]["ty"]) ? data["tool"]["ty"] : {};
                  const src = record(toolConfig["src"]) ? toolConfig["src"] : {};
                  if (Array.isArray(src["include"]))
                    result.coverage = src["include"].filter((item) => typeof item === "string").map(includePattern);
                  if (Array.isArray(src["exclude"]))
                    result.excluded = src["exclude"].filter((item) => typeof item === "string");
                }
                const output = await run(tool2.command[0] ?? "", tool2.command.slice(1), cwd, signal, void 0, {
                  timeout: BUDGET.project,
                  environment
                });
                result.findings = await projectOutput(
                  check,
                  output.stdout + (["tsc", "ty", "sarif"].includes(check.parser) ? output.stderr : ""),
                  this.root,
                  cwd
                );
                if (output.code !== 0 && !(result.findings.length && (output.code === 1 || check.parser === "tsc" && output.code === 2 || check.parser === "cargo" && output.code === 101)))
                  throw new Error(output.stderr || `Checker exit ${output.code} without located diagnostics`);
                if (await this.identity([check], await configuration(this.root), signal) !== checkIdentity)
                  throw new Error("Checker configuration/tool changed during baseline");
                const afterFiles = await inventory(this.root, BUDGET.files, signal, config.exclude);
                const relevant = [.../* @__PURE__ */ new Set([...beforeFiles.files.keys(), ...afterFiles.files.keys()])].filter(
                  (path) => covers(result, path) || configurationImpact(path).length > 0
                );
                if (!afterFiles.complete || relevant.some((path) => beforeFiles.files.get(path) !== afterFiles.files.get(path)))
                  throw new Error("Project changed while establishing baseline; retry before editing");
                result.state = "complete";
              } catch (error) {
                result.state = "failed";
                result.note = message(error);
              }
            })
          );
        while (this.jobs.size > 32) {
          const first = [...this.jobs.values()].find(
            (entry) => entry.id !== job.id && entry.results.every((result) => result.state !== "running")
          );
          if (!first) break;
          this.jobs.delete(first.id);
        }
        return job;
      }
      async baseline(session, paths, environment, signal, wait) {
        const config = await configuration(this.root);
        if (!config.trusted) throw new Error("Project baseline requires workspace trust");
        const store = new Metadata(this.root);
        const state = await store.read(session);
        const checks = await this.discover(config, signal);
        const identity = await this.identity(checks, config, signal);
        let job;
        let recovered;
        if (state.diagnosticBaseline) {
          const data = await store.readShared(state.diagnosticBaseline);
          if (record(data) && data["identity"] === identity && Array.isArray(data["results"]))
            recovered = data;
        }
        if (recovered?.results.some((result) => result.state === "running")) recovered = void 0;
        if (!recovered) {
          job = [...this.jobs.values()].find(
            (entry) => entry.id === state.shown["baselineJob"] && entry.identity === identity
          );
          if (!job) {
            if (state.edited && !state.diagnosticBaseline)
              throw new Error(
                "Editing has already occurred; cannot create a pre-edit diagnostic baseline. Restart the session or explicitly disable automatic diagnostics"
              );
            const snapshot2 = await inventory(this.root, BUDGET.files, signal, config.exclude);
            if (!snapshot2.complete) throw new Error("Baseline inventory incomplete");
            job = await this.start(checks, config, environment, identity, snapshot2.version);
            this.sessionJobs.set(session, job.id);
            await store.update(session, signal, (current) => {
              if (current.epoch !== state.epoch || current.turn === "__ended__") return false;
              current.shown["baselineJob"] = job?.id ?? "";
              return true;
            });
          }
          const selected = job.checks.map((check, index) => ({ check, index })).filter(({ check }) => !paths || paths.some((path) => covers(check, path)));
          await Promise.race([
            Promise.allSettled(selected.map(({ index }) => job?.done[index])),
            delay2(wait, void 0, { signal }).catch(() => void 0)
          ]);
          recovered = { identity, results: job.results, before: job.before };
        }
        const results = recovered.results;
        const reference = await store.shared(recovered);
        await store.update(session, signal, (current) => {
          if (current.epoch !== state.epoch || current.turn === "__ended__") return false;
          current.diagnosticBaseline = reference;
          current.configuration = config.version;
          return true;
        });
        const snapshot = paths ? void 0 : await inventory(this.root, BUDGET.files, signal, config.exclude);
        const targets = paths ?? [...snapshot?.files.keys() ?? []].filter(
          (path) => codeLanguage(config, path) && !/(?:json|yaml|css|html)$/.test(codeLanguage(config, path) ?? "")
        );
        const failures = [];
        const pending = [];
        for (const path of targets) {
          if (!codeLanguage(config, path)) continue;
          const related = results.filter((result) => covers(result, path));
          const language = codeLanguage(config, path);
          const required = language === "typescript" && /\.[cm]?tsx?$/.test(path) ? "tsc" : language === "python" ? "ty" : language === "rust" ? "cargo" : void 0;
          if (config.projectChecks === "auto" && required && !related.some((result) => result.parser === required))
            failures.push(`${path}: no type checker coverage; configure projectChecks`);
          if (!related.length) failures.push(`${path}: no project checker coverage; configure projectChecks`);
          for (const result of related) {
            if (result.state === "running") pending.push(result.name);
            else if (result.state !== "complete") failures.push(`${result.name}: ${result.note ?? result.state}`);
          }
        }
        return {
          reference,
          findings: results.filter((result) => result.state === "complete").flatMap((result) => result.findings),
          failures: [...new Set(failures)],
          pending: [...new Set(pending)]
        };
      }
      async dispose() {
        for (const job of this.jobs.values()) job.controller.abort();
        await Promise.allSettled([...this.jobs.values()].flatMap((job) => job.done));
      }
    };
  }
});

// src/engine.ts
import { randomUUID as randomUUID6 } from "node:crypto";
import { readFile as readFile16, stat as stat6 } from "node:fs/promises";
import { dirname as dirname9, relative as relative8, sep as sep3 } from "node:path";
var Engine;
var init_engine = __esm({
  "src/engine.ts"() {
    "use strict";
    init_budgets();
    init_config();
    init_config_files();
    init_environment();
    init_files();
    init_identity();
    init_language();
    init_metadata();
    init_metrics();
    init_project_checks();
    init_results();
    init_runners();
    init_tool_resolution();
    Engine = class {
      constructor(root, dependencies = {
        checkBatch: async (paths, config, source, signal) => {
          this.language ??= new Languages(root, config);
          const runners = source === "lsp" ? /* @__PURE__ */ new Map() : await lintBatch(root, paths, signal, config, !automaticExecution());
          const results = [];
          for (const path of paths) {
            const lsp = source === "lint" ? { path, state: "skipped", findings: [] } : await this.language.check(path, signal);
            const runner = runners.get(path) ?? {
              path,
              state: "skipped",
              findings: [],
              note: "lint off or unavailable"
            };
            const selected = source === "lsp" ? lsp : source === "lint" ? runner : {
              path,
              state: lsp.state === "complete" ? runner.state === "skipped" ? "complete" : runner.state : lsp.state,
              findings: mergeFindings([...lsp.findings, ...runner.findings]),
              note: [lsp.note, runner.note].filter(Boolean).join("; ")
            };
            results.push({
              result: { ...selected, channels: { lsp: lsp.state, lint: runner.state } },
              lsp,
              lint: runner
            });
          }
          return results;
        }
      }, projects = new ProjectChecks(root)) {
        this.root = root;
        this.dependencies = dependencies;
        this.projects = projects;
        this.identities = /* @__PURE__ */ new Map();
        this.cache = /* @__PURE__ */ new Map();
        this.sessions = /* @__PURE__ */ new Map();
        this.configVersion = "";
        this.queue = Promise.resolve();
        this.generation = 0;
        this.pages = /* @__PURE__ */ new Map();
      }
      async warmup(signal) {
        const config = await configuration(this.root);
        if (!config.trusted || config.automaticDiagnostics.postToolUse === "off" && config.automaticDiagnostics.stop === "off")
          return;
        const snapshot = latestInventory(this.root);
        if (!snapshot?.complete) return;
        const representatives = /* @__PURE__ */ new Map();
        for (const path of snapshot.files.keys()) {
          const language = codeLanguage(config, path);
          if (!language || configurationImpact(path).length || ["json", "yaml", "css", "html"].includes(language))
            continue;
          const entry = representatives.get(language);
          if (entry) entry.count++;
          else representatives.set(language, { path, count: 1 });
        }
        this.language ??= new Languages(this.root, config);
        await this.language.update(config);
        for (const entry of [...representatives.values()].sort((a, b) => b.count - a.count).slice(0, 2)) {
          signal.throwIfAborted();
          await this.language.preflight(entry.path, signal).catch(() => void 0);
        }
      }
      session(id, turn) {
        let session = this.sessions.get(id);
        if (!session) {
          session = {
            turn: turn ?? "",
            touched: /* @__PURE__ */ new Set(),
            current: /* @__PURE__ */ new Set()
          };
          this.sessions.set(id, session);
        }
        if (turn && session.turn !== turn) {
          session.turn = turn;
          session.current.clear();
        }
        return session;
      }
      id(value) {
        if (typeof value === "string" && value) return value;
        if (this.sessions.size === 1) return this.sessions.keys().next().value ?? "manual";
        if (this.sessions.size > 1)
          throw new Error(
            "Multiple sessions: provide session from Hook feedback, or a new unique session for manual checks"
          );
        return "manual";
      }
      async synchronize(snapshot) {
        const previous = this.previousSnapshot;
        if (previous?.version !== snapshot.version && this.language) {
          const changed = [.../* @__PURE__ */ new Set([...snapshot.files.keys(), ...previous?.files.keys() ?? []])].filter(
            (path) => previous?.files.get(path) !== snapshot.files.get(path)
          );
          for (const path of changed)
            if (configurationImpact(path).includes("types") && !/(?:\.lock|(?:^|\/)package(?:-lock)?\.json|(?:^|\/)pnpm-lock\.yaml)$/.test(path))
              await this.language.invalidate(path);
          await this.language.sync(snapshot.files);
        }
        for (const key of this.cache.keys()) {
          const path = key.replace(/^(?:lsp|lint):/, "");
          if (previous?.files.has(path) && !snapshot.files.has(path)) this.cache.delete(key);
        }
        this.previousSnapshot = snapshot;
      }
      async check(paths, id, turn, lspOnly = false, signal = new AbortController().signal, _offset = 0, baseline, provided, source = lspOnly ? "lsp" : "both") {
        const config = provided ?? await configuration(this.root);
        const snapshot = baseline ?? latestInventory(this.root) ?? await inventory(this.root, BUDGET.files, signal, config.exclude);
        await this.synchronize(snapshot);
        const session = this.session(id, turn);
        const results = /* @__PURE__ */ new Map();
        const pending = [];
        for (const requested of [...new Set(paths)].slice(0, 200)) {
          signal.throwIfAborted();
          try {
            const absolute = await workspacePath(this.root, requested);
            const path = relative8(this.root, absolute);
            session.touched.add(path);
            session.current.add(path);
            if ((await stat6(absolute)).size > BUDGET.fileBytes) {
              results.set(path, { path, state: "skipped", findings: [], note: "File exceeds 1 MiB" });
              continue;
            }
            const identity = await analysisIdentity(this.root, [path], config, signal);
            this.identities.set(path, identity);
            const content = hash(await readFile16(absolute, { encoding: "utf8", signal }));
            const key = `${source === "both" ? "" : `${source}:`}${path}`;
            const cached = this.cache.get(key);
            if (snapshot.complete && cached?.version === this.projectVersion(snapshot, path, config) && cached.identity === identity && cached.content === content && cached.result.state === "complete")
              results.set(path, cached.result);
            else pending.push({ path, identity, content, key });
          } catch (error) {
            signal.throwIfAborted();
            results.set(requested, { path: requested, state: "skipped", findings: [], note: message(error) });
          }
        }
        const checked = await this.dependencies.checkBatch(
          pending.map((entry) => entry.path),
          config,
          source,
          signal
        );
        for (const entry of pending) {
          signal.throwIfAborted();
          const channels = checked.find((item) => item.result.path === entry.path);
          const result = channels?.result ?? {
            path: entry.path,
            state: "pending",
            findings: [],
            note: "Checker returned no result"
          };
          try {
            if (hash(await readFile16(await workspacePath(this.root, entry.path), { encoding: "utf8", signal })) !== entry.content || await analysisIdentity(this.root, [entry.path], await configuration(this.root), signal) !== entry.identity || this.projectVersion(latestInventory(this.root) ?? snapshot, entry.path, config) !== this.projectVersion(snapshot, entry.path, config)) {
              result.state = "stale";
              result.note = "File/tool/configuration changed during diagnostics; retry";
            }
          } catch {
            signal.throwIfAborted();
            result.state = "stale";
            result.note = "File disappeared during diagnostics";
          }
          if (JSON.stringify(this.cache.get(entry.key)?.result) !== JSON.stringify(result)) this.generation++;
          this.cache.set(entry.key, {
            version: this.projectVersion(snapshot, entry.path, config),
            identity: entry.identity,
            content: entry.content,
            result
          });
          if (channels)
            for (const channel of ["lsp", "lint"]) {
              if (source === "lsp" && channel === "lint" || source === "lint" && channel === "lsp") continue;
              this.cache.set(`${channel}:${entry.path}`, {
                version: this.projectVersion(snapshot, entry.path, config),
                identity: entry.identity,
                content: entry.content,
                result: result.state === "stale" ? { ...channels[channel], state: "stale" } : channels[channel]
              });
            }
          results.set(entry.path, result);
        }
        return [...results.values()];
      }
      dispatch(operation, args, signal) {
        const writes = operation === "lsp_format" || operation === "lsp_rename";
        let started = false;
        const task = this.queue.then(() => {
          started = true;
          signal.throwIfAborted();
          return withToolResolution(() => this.execute(operation, args, signal));
        });
        this.queue = task.catch(() => void 0);
        return new Promise((resolve12, reject) => {
          const abort = () => {
            if (!started || !writes) reject(new Error("Request cancelled while queued or executing"));
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          void task.then(resolve12, reject).finally(() => signal.removeEventListener("abort", abort));
        });
      }
      async paths(args, signal) {
        const config = await configuration(this.root);
        const values = Array.isArray(args["paths"]) ? args["paths"] : [text(args["path"], ".")];
        if (values.length > 200 || !values.every((value) => typeof value === "string"))
          throw new Error("paths must contain at most 200 strings");
        const paths = /* @__PURE__ */ new Set();
        let complete = true;
        for (const value of values) {
          if (typeof value !== "string") continue;
          signal.throwIfAborted();
          const absolute = await workspacePath(this.root, value);
          if ((await stat6(absolute)).isFile()) paths.add(relative8(this.root, absolute));
          else {
            const scoped = await inventory(this.root, BUDGET.files, signal, config.exclude, absolute);
            complete &&= scoped.complete;
            for (const path of scoped.files.keys()) {
              paths.add(path);
              if (paths.size > 1e4) {
                complete = false;
                break;
              }
            }
          }
          if (paths.size > 1e4) break;
        }
        return { paths: [...paths].sort().slice(0, 1e4), complete };
      }
      async execute(operation, args, signal) {
        if (operation === "release") {
          await this.close();
          this.cache.clear();
          return { operation };
        }
        const config = await configuration(this.root);
        if (this.configVersion !== config.version || args["refresh"] === true) {
          if (args["refresh"] === true) await this.close();
          else await this.language?.update(config);
          this.cache.clear();
          this.pages.clear();
          this.configVersion = config.version;
        }
        const store = new Metadata(this.root);
        const ids = await store.ids();
        for (const id2 of this.sessions.keys())
          if (!ids.includes(id2) && (await store.read(id2)).turn === "__ended__") this.sessions.delete(id2);
        for (const id2 of ids) {
          const state = await store.read(id2);
          if (state.turn === "__ended__") {
            this.sessions.delete(id2);
            continue;
          }
          const session = this.session(id2, state.turn);
          session.touched = new Set(state.touched);
          session.current = new Set(state.current);
        }
        if (operation === "lsp_status") {
          this.language ??= new Languages(this.root, config);
          const targets = args["path"] ? [text(args["path"])] : Object.values(config.servers).filter((server2) => !!server2).map((server2) => server2 ? `status${server2.extensions[0]}` : "");
          return {
            operation,
            workspace: this.root,
            trusted: config.trusted,
            configuration: config,
            tools: await Promise.all(
              targets.map((path) => this.language?.status(path).catch((error) => ({ path, reason: message(error) })))
            ),
            timings: timings(),
            cache: this.cache.size,
            clients: this.language.statistics(),
            index: indexStatistics(),
            sessions: [...this.sessions.keys()]
          };
        }
        if (operation === "automatic_batch") {
          if (!config.trusted)
            throw new Error("Automatic LSP/lint requires workspace trust; lint requires workspace trust");
          const paths2 = Array.isArray(args["paths"]) ? args["paths"].filter((path) => typeof path === "string") : [];
          return {
            operation,
            results: await this.check(
              paths2.slice(0, BUDGET.batch),
              text(args["session"]),
              text(args["turn"]),
              false,
              signal,
              0,
              void 0,
              config
            )
          };
        }
        const id = args["scope"] === "paths" || args["scope"] === void 0 ? text(args["session"], "manual") : this.id(args["session"]);
        if (operation === "check_diagnostics") return this.diagnostics(args, id, signal, config, store);
        if ((operation === "lsp_rename" || operation === "lsp_format") && (config.automaticDiagnostics.postToolUse !== "off" || config.automaticDiagnostics.stop !== "off")) {
          const paths2 = operation === "lsp_rename" ? void 0 : (await this.paths(args, signal)).paths;
          const baseline = await this.projects.baseline(id, paths2, executionEnvironment(), signal, BUDGET.stopWait);
          if (baseline.pending.length || baseline.failures.length)
            throw new Error(`Pre-edit baseline unavailable: ${[...baseline.pending, ...baseline.failures].join("; ")}`);
        }
        if (operation === "lsp_rename") args = { ...args, operation: "rename" };
        if (operation === "lsp_navigation" || operation === "lsp_rename") {
          const path = relative8(this.root, await workspacePath(this.root, text(args["path"])));
          const identity = await analysisIdentity(this.root, [path], config, signal);
          if (this.identities.has(path) && this.identities.get(path) !== identity) {
            for (const key of this.cache.keys()) if (key.replace(/^(?:lsp|lint):/, "") === path) this.cache.delete(key);
          }
          this.identities.set(path, identity);
          const snapshot = await inventory(this.root, BUDGET.files, signal, config.exclude, this.root, true);
          snapshot.version = hash(snapshot.version + config.version);
          await this.synchronize(snapshot);
          this.language ??= new Languages(this.root, config);
          const before = args["operation"] === "rename" ? await inventory(this.root, BUDGET.files, signal) : void 0;
          let output;
          try {
            output = await this.language.navigate(args, signal);
          } finally {
            if (before) this.cache.clear();
          }
          if (before) {
            const modifiedPaths = "modifiedPaths" in output ? output.modifiedPaths : [];
            this.cache.clear();
            const after = await inventory(this.root, BUDGET.files, signal).catch((error) => {
              throw new WriteFailure(`${message(error)}; ${JSON.stringify(output)}`, modifiedPaths);
            });
            const changed = [...after.files].filter(([path2, version]) => before.files.get(path2) !== version).map(([path2]) => path2);
            try {
              await this.check(
                [.../* @__PURE__ */ new Set([text(args["path"]), ...changed])],
                id,
                this.session(id).turn,
                false,
                signal
              );
            } catch (error) {
              throw new WriteFailure(`${message(error)}; ${JSON.stringify(output)}`, modifiedPaths);
            }
          }
          return { ...output, operation };
        }
        const scope2 = await this.paths(args, signal);
        const paths = scope2.paths;
        if (operation === "lsp_format") {
          if (!args["paths"] && !args["path"]) throw new Error("Explicit formatting paths required");
          if (paths.length > 200) throw new Error("Format at most 200 explicitly scoped files");
          this.language ??= new Languages(this.root, config);
          for (const path of paths) {
            const runner = await preflightRunner(this.root, path, config, signal);
            await this.language.preflight(path, signal, runner ? void 0 : "format");
          }
          const writes = [];
          const modifiedPaths = [];
          try {
            for (const path of paths) {
              signal.throwIfAborted();
              writes.push(
                await formatWithRunner(this.root, path, signal, config) ?? await this.language.format(path, signal)
              );
              if (writes.at(-1)?.status === "formatted") modifiedPaths.push(path);
            }
            await this.check(paths, id, "manual", false, signal);
          } catch (error) {
            throw new WriteFailure(`${message(error)}; completed writes: ${JSON.stringify(writes)}`, modifiedPaths);
          } finally {
            this.cache.clear();
          }
          return { operation, modifiedPaths, results: writes };
        }
        throw new Error("Unknown tool");
      }
      async diagnostics(args, id, signal, config, store) {
        for (const key of ["mode", "start", "offset", "revision"])
          if (args[key] !== void 0)
            throw new Error("Migration required: use scope/source/run/cursor; see docs/usage.md#upgrade");
        const scope2 = text(args["scope"], "paths");
        if (scope2 === "paths" && (!args["path"] && !args["paths"] || args["path"] === "." || Array.isArray(args["paths"]) && args["paths"].includes(".")))
          throw new Error(
            "Migration required: use check_project for workspace checks; check_diagnostics requires specific paths or turn/session scope"
          );
        const source = text(args["source"], "both");
        const run2 = text(args["run"], "active");
        if (!["paths", "turn", "session"].includes(scope2) || !["both", "lsp", "lint"].includes(source) || !["active", "cached"].includes(run2))
          throw new Error("Invalid scope/source/run");
        const snapshot = await inventory(this.root, BUDGET.files, signal, config.exclude, this.root, true);
        snapshot.version = hash(snapshot.version + config.version);
        const token = text(args["cursor"]);
        let results;
        let index = 0;
        let identity;
        if (token) {
          const page = this.pages.get(token);
          if (!page || page.generation !== this.generation || page.version !== snapshot.version || hash(
            JSON.stringify(
              Object.entries(args).filter(([key]) => key !== "cursor" && key !== "workspace" && key !== "refresh").sort()
            )
          ) !== hash(
            JSON.stringify(
              Object.entries(page.args).filter(([key]) => key !== "cursor" && key !== "workspace" && key !== "refresh").sort()
            )
          ))
            throw new Error("Cursor invalid or stale; restart without cursor");
          identity = await this.pageIdentity(
            page.results.map((result) => result.path),
            config,
            snapshot,
            signal
          );
          if (identity !== page.identity) throw new Error("Cursor invalid: tool/configuration changed");
          results = [...page.results];
          index = page.index;
          if (run2 === "active") {
            const pending = results.slice(index, index + BUDGET.batch);
            if (pending.some((result) => result.analysisRequired)) {
              const checked = await this.check(
                pending.map((result) => result.path),
                id,
                this.session(id).turn,
                source === "lsp",
                signal,
                0,
                snapshot,
                config,
                source
              );
              results.splice(index, pending.length, ...checked);
            }
          }
        } else {
          let paths;
          if (scope2 === "paths") {
            const values = Array.isArray(args["paths"]) ? args["paths"] : [text(args["path"], ".")];
            const selected2 = /* @__PURE__ */ new Set();
            for (const value of values) {
              if (typeof value !== "string") throw new Error("paths requires strings");
              const absolute = await workspacePath(this.root, value);
              const path = relative8(this.root, absolute);
              if ((await stat6(absolute)).isFile()) {
                if (!codeLanguage(config, path)) throw new Error(`Language disabled or unsupported: ${path}`);
                selected2.add(path);
              } else
                for (const candidate of (snapshot.complete ? snapshot : await inventory(this.root, BUDGET.files, signal, config.exclude, absolute)).files.keys())
                  if ((!path || candidate.startsWith(`${path}${sep3}`)) && codeLanguage(config, candidate))
                    selected2.add(candidate);
            }
            paths = [...selected2].sort();
          } else
            paths = [...scope2 === "turn" ? this.session(id).current : this.session(id).touched].filter((path) => snapshot.files.has(path)).sort();
          identity = await this.pageIdentity(paths, config, snapshot, signal);
          if (run2 === "cached") {
            results = [];
            for (const path of paths) {
              const entry = this.cache.get((source === "lsp" ? "lsp:" : source === "lint" ? "lint:" : "") + path);
              results.push(
                !entry ? { path, state: "pending", findings: [] } : entry.version === this.projectVersion(snapshot, path, config) && entry.content === await this.contentIdentity(path, snapshot, signal) && snapshot.complete && entry.identity === await analysisIdentity(this.root, [path], config, signal) ? entry.result : { ...entry.result, state: "stale", note: "Run active diagnostics" }
              );
            }
          } else {
            await store.update(id, signal, (state) => {
              state.touched.push(...paths);
              state.current.push(...paths);
            });
            const checked = await this.check(
              paths.slice(0, BUDGET.batch),
              id,
              this.session(id).turn,
              source === "lsp",
              signal,
              0,
              snapshot,
              config,
              source
            );
            results = [
              ...checked,
              ...paths.slice(BUDGET.batch).map((path) => ({
                path,
                state: "pending",
                findings: [],
                analysisRequired: true,
                note: "Continue cursor for active analysis"
              }))
            ];
          }
        }
        const selected = [];
        let size = 0;
        for (const result of results.slice(index)) {
          const bytes = JSON.stringify(result).length;
          if (selected.length && (size + bytes > 24e3 || selected.length >= BUDGET.batch)) break;
          selected.push(result);
          size += bytes;
        }
        let next;
        if (index + selected.length < results.length) {
          const cursor = randomUUID6();
          this.pages.set(cursor, {
            version: snapshot.version,
            results,
            index: index + selected.length,
            args,
            identity,
            generation: this.generation
          });
          while (this.pages.size > 32) this.pages.delete(this.pages.keys().next().value ?? "");
          next = { ...args, refresh: void 0, workspace: this.root, cursor };
        }
        const partial = !snapshot.complete || results.some((result) => result.state !== "complete");
        return {
          operation: "check_diagnostics",
          inventoryComplete: snapshot.complete,
          scope: scope2,
          source,
          run: run2,
          partial,
          errors: results.flatMap((result) => result.findings).filter((item) => item.severity === "error").length,
          warnings: results.flatMap((result) => result.findings).filter((item) => item.severity === "warning").length,
          results: selected,
          unavailable: Object.fromEntries(
            [
              ...new Set(
                results.filter((result) => result.state === "failed" || result.state === "skipped").map((result) => codeLanguage(config, result.path) ?? "unsupported")
              )
            ].map((language) => [
              language,
              [
                ...new Set(
                  results.filter(
                    (result) => (codeLanguage(config, result.path) ?? "unsupported") === language && result.note && (result.state === "failed" || result.state === "skipped")
                  ).map((result) => result.note)
                )
              ]
            ])
          ),
          ...next ? { next } : {},
          isError: run2 === "active" && results.length > 0 && results.every(
            (result) => (result.state === "failed" || result.state === "skipped") && result.channels?.lsp !== "complete" && result.channels?.lint !== "complete"
          )
        };
      }
      projectVersion(snapshot, path, config) {
        const language = codeLanguage(config, path);
        let owner = dirname9(path);
        while (owner !== "." && ![...snapshot.files.keys()].some(
          (candidate) => dirname9(candidate) === owner && configurationLanguages(candidate).includes(language ?? "")
        ))
          owner = dirname9(owner);
        const prefix = owner === "." ? "" : `${owner}/`;
        return hash(
          JSON.stringify(
            [...snapshot.files].filter(
              ([candidate]) => candidate.startsWith(prefix) && (codeLanguage(config, candidate) === language || configurationImpact(candidate).some((impact) => impact === "types" || impact === "lint") && configurationLanguages(candidate).includes(language ?? ""))
            )
          )
        );
      }
      async contentIdentity(path, snapshot, signal) {
        const existing = snapshot.files.get(path);
        if (existing) return existing;
        try {
          const absolute = await workspacePath(this.root, path);
          const info = await stat6(absolute);
          if (info.size > BUDGET.fileBytes) return "oversized";
          return hash(await readFile16(absolute, { encoding: "utf8", signal }));
        } catch {
          signal.throwIfAborted();
          return "unavailable";
        }
      }
      async pageIdentity(paths, config, snapshot, signal) {
        const contents = [];
        for (const path of paths) contents.push([path, await this.contentIdentity(path, snapshot, signal)]);
        return hash(JSON.stringify([await analysisIdentity(this.root, paths, config, signal), contents]));
      }
      async dispose() {
        await this.close();
        await this.queue;
        await this.close();
      }
      async close() {
        const language = this.language;
        this.language = void 0;
        await language?.close();
      }
    };
  }
});

// src/ipc.ts
import { spawn as spawn4 } from "node:child_process";
import { randomUUID as randomUUID7 } from "node:crypto";
import { chmod, lstat as lstat4, mkdir as mkdir5, readFile as readFile17, rename as rename5, writeFile as writeFile6 } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir as homedir6, tmpdir as tmpdir3 } from "node:os";
import { join as join16 } from "node:path";
import { setTimeout as delay3 } from "node:timers/promises";
import { fileURLToPath as fileURLToPath4 } from "node:url";
async function serviceLocation(root) {
  const user = process.getuid?.() ?? hash(homedir6()).slice(0, 10);
  const directory2 = join16(tmpdir3(), `clsp6-${user}`);
  await mkdir5(directory2, { recursive: true, mode: 448 });
  const info = await lstat4(directory2);
  if (info.isSymbolicLink() || process.platform !== "win32" && (info.uid !== process.getuid?.() || info.mode & 63))
    throw new Error("Unsafe service directory permissions");
  const identity = await workspaceIdentity(root);
  const address = process.platform === "win32" ? `\\\\.\\pipe\\codex-lsp-${user}-${identity}` : join16(directory2, `${identity.slice(0, 32)}.sock`);
  return { directory: directory2, identity, address, endpoint: join16(directory2, `${identity}.endpoint`) };
}
async function readEndpoint(location) {
  try {
    const info = await lstat4(location.endpoint);
    if (info.isSymbolicLink() || process.platform !== "win32" && (info.uid !== process.getuid?.() || info.mode & 63))
      throw new Error("Unsafe service endpoint permissions");
    const value = JSON.parse(await readFile17(location.endpoint, "utf8"));
    if (!record(value) || value["identity"] !== location.identity || value["protocol"] !== SERVICE_PROTOCOL || typeof value["pid"] !== "number" || typeof value["token"] !== "string" || value["address"] !== location.address)
      throw new Error("Invalid service endpoint");
    return value;
  } catch (error) {
    if (record(error) && error["code"] === "ENOENT") return void 0;
    throw error;
  }
}
async function exchange(endpoint, operation, args, signal) {
  signal.throwIfAborted();
  return new Promise((resolve12, reject) => {
    const socket = createConnection(endpoint.address);
    let received = "";
    let settled = false;
    const writes = operation === "lsp_rename" || operation === "lsp_format";
    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      socket.destroy();
      if (error) reject(error);
      else if (output) resolve12(output);
      else reject(new Error("Missing service output"));
    };
    const cancel = () => {
      if (writes) socket.write(`${JSON.stringify({ cancel: true })}
`);
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
          environment: executionEnvironment()
        })}
`
      );
      if (signal.aborted) cancel();
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      received += chunk;
      if (received.length > 8 * 1024 * 1024) {
        finish(new Error("Service response exceeds limit"));
        return;
      }
      const end = received.indexOf("\n");
      if (end < 0) return;
      try {
        const response = JSON.parse(received.slice(0, end));
        if (!record(response)) throw new Error("Invalid service response");
        if (typeof response["error"] === "string") {
          const paths = response["modifiedPaths"];
          finish(
            Array.isArray(paths) ? new WriteFailure(
              response["error"],
              paths.filter((path) => typeof path === "string")
            ) : new Error(response["error"])
          );
        } else if (record(response["output"]) && typeof response["output"]["operation"] === "string")
          finish(void 0, response["output"]);
        else throw new Error("Invalid structured service response");
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once(
      "close",
      () => finish(
        new Error(
          writes ? "Service connection lost; write outcome unknown; do not replay" : "Service connection lost; retry read request"
        )
      )
    );
  });
}
async function existingService(root, signal) {
  const location = await serviceLocation(root);
  const endpoint = await readEndpoint(location);
  if (!endpoint || !alive(endpoint.pid)) return void 0;
  const handshake = await exchange(
    endpoint,
    "handshake",
    {},
    AbortSignal.any([signal, AbortSignal.timeout(750)])
  );
  if (!record(handshake) || handshake["protocol"] !== SERVICE_PROTOCOL || handshake["identity"] !== location.identity || handshake["pid"] !== endpoint.pid)
    throw new Error("Service handshake identity mismatch");
  return endpoint;
}
async function ensureService(root, signal) {
  const location = await serviceLocation(root);
  signal.throwIfAborted();
  const connected = await existingService(root, signal);
  if (connected) return connected;
  const previous = await readEndpoint(location);
  if (previous && alive(previous.pid)) throw new Error("Service process alive but handshake unavailable; retry later");
  const child = spawn4(
    process.execPath,
    [...process.execArgv, fileURLToPath4(import.meta.url), "service", root, location.identity, randomUUID7()],
    {
      ...HIDDEN_PROCESS,
      cwd: root,
      env: executionEnvironment(),
      detached: true,
      stdio: "ignore"
    }
  );
  let startupError;
  child.once("error", (error) => {
    startupError = error;
  });
  child.unref();
  const startup = AbortSignal.any([signal, AbortSignal.timeout(8e3)]);
  while (true) {
    startup.throwIfAborted();
    if (startupError) throw startupError;
    const endpoint = await readEndpoint(location);
    if (endpoint && alive(endpoint.pid)) {
      await exchange(endpoint, "handshake", {}, startup);
      return endpoint;
    }
    if (child.exitCode !== null) throw new Error("Shared service failed to start");
    await delay3(25, void 0, { signal: startup });
  }
}
async function publishEndpoint(location, token) {
  if (process.platform !== "win32") await chmod(location.address, 384);
  const temporary2 = `${location.endpoint}.${randomUUID7()}`;
  await writeFile6(
    temporary2,
    JSON.stringify({
      pid: process.pid,
      token,
      identity: location.identity,
      protocol: SERVICE_PROTOCOL,
      address: location.address
    }),
    { mode: 384 }
  );
  await rename5(temporary2, location.endpoint);
}
var init_ipc = __esm({
  "src/ipc.ts"() {
    "use strict";
    init_directory_lock();
    init_directory_lock();
    init_environment();
    init_files();
    init_process_options();
    init_results();
    init_service_identity();
  }
});

// src/hook-inbox.ts
import { randomUUID as randomUUID8 } from "node:crypto";
import { lstat as lstat5, readdir as readdir5, readFile as readFile18, rm as rm4, writeFile as writeFile7 } from "node:fs/promises";
import { join as join17 } from "node:path";
async function registerHook(root, input, signal) {
  const location = await serviceLocation(root);
  const session = text(input["session_id"]);
  const state = await new Metadata(root).update(session, signal, () => void 0);
  const path = join17(location.directory, `${location.identity}.${Date.now()}.${randomUUID8()}.hook`);
  await writeFile7(
    path,
    JSON.stringify({
      protocol: SERVICE_PROTOCOL,
      identity: location.identity,
      epoch: state.epoch,
      input,
      environment: executionEnvironment()
    }),
    { mode: 384, flag: "wx", signal }
  );
}
async function registeredHooks(root) {
  const location = await serviceLocation(root);
  const result = [];
  for (const name of (await readdir5(location.directory)).sort()) {
    if (!name.startsWith(`${location.identity}.`) || !name.endsWith(".hook")) continue;
    const path = join17(location.directory, name);
    try {
      const info = await lstat5(path);
      if (info.isSymbolicLink() || info.size > 1024 * 1024 || process.platform !== "win32" && (info.uid !== process.getuid?.() || info.mode & 63))
        throw new Error("Unsafe hook registration");
      const value = JSON.parse(await readFile18(path, "utf8"));
      if (!record(value) || value["identity"] !== location.identity || value["protocol"] !== SERVICE_PROTOCOL || typeof value["epoch"] !== "string" || !record(value["input"]) || !record(value["environment"]) || !Object.values(value["environment"]).every((entry) => typeof entry === "string"))
        throw new Error("Invalid hook registration");
      result.push({
        path,
        epoch: value["epoch"],
        input: value["input"],
        environment: value["environment"]
      });
    } catch {
      await rm4(path, { force: true });
    }
  }
  return result;
}
var init_hook_inbox = __esm({
  "src/hook-inbox.ts"() {
    "use strict";
    init_environment();
    init_ipc();
    init_metadata();
    init_results();
    init_service_identity();
  }
});

// src/runtime.ts
import { realpath as realpath6 } from "node:fs/promises";
import { isAbsolute as isAbsolute8 } from "node:path";
var Runtime;
var init_runtime = __esm({
  "src/runtime.ts"() {
    "use strict";
    init_budgets();
    init_engine();
    init_hook_inbox();
    init_ipc();
    init_metadata();
    init_results();
    init_write_intent();
    Runtime = class {
      constructor() {
        this.active = /* @__PURE__ */ new Set();
      }
      async request(root, operation, args, signal) {
        const event = operation === "hook" ? text(args["hook_event_name"], "PostToolUse") : "";
        if (event === "PreToolUse" && (isShellTool(args) || writeIntent(root, args).kind !== "write"))
          return { operation: "hook", output: { kind: "silent" } };
        if (!isAbsolute8(root)) throw new Error("workspace must be an absolute project directory");
        root = await realpath6(root);
        const controller = new AbortController();
        this.active.add(controller);
        signal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(BUDGET.request)]);
        try {
          const passiveHook = event === "PostToolUse" && writeIntent(root, args).kind === "read" || event === "SessionEnd";
          if (operation === "hook" && !passiveHook && event !== "PreToolUse" && args["stop_hook_active"] !== true)
            await registerHook(root, args, signal);
          const existing = await existingService(root, signal);
          const passive = operation === "lsp_status" || passiveHook || operation === "hook_ack" || operation === "check_diagnostics" && args["run"] === "cached" || operation === "session_end" || operation === "check_project" && args["run"] === "cached";
          if (!existing && passive) {
            if (operation === "hook_ack") return { operation };
            if (operation === "hook") {
              if (event === "SessionEnd") await new Metadata(root).end(text(args["session_id"]), signal);
              return { operation, output: { kind: "silent" } };
            }
            if (operation === "session_end") return { operation };
            if (operation === "check_project")
              return {
                operation,
                job: typeof args["job"] === "string" ? args["job"] : "",
                state: "missing",
                checkers: [],
                diagnostics: [],
                errors: 0,
                warnings: 0
              };
            const engine = new Engine(root);
            try {
              const output = await engine.dispatch(operation, args, signal);
              return operation === "lsp_status" ? { ...output, service: { state: "stopped" }, automaticTasks: [] } : output;
            } finally {
              await engine.dispose();
            }
          }
          const endpoint = existing ?? await ensureService(root, signal);
          return await exchange(endpoint, operation, args, signal);
        } finally {
          this.active.delete(controller);
        }
      }
      async close() {
        for (const controller of this.active) controller.abort();
        this.active.clear();
      }
    };
  }
});

// src/codex-hook.ts
import { realpath as realpath7 } from "node:fs/promises";
import { stdin } from "node:process";
async function runHookCli() {
  stdin.setEncoding("utf8");
  let raw = "";
  for await (const chunk of stdin) {
    raw += chunk;
    if (raw.length > 1024 * 1024) throw new Error("Hook input too large");
  }
  if (!raw.trim()) return;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid Hook JSON");
  }
  if (!record(parsed)) throw new Error("Hook input must be an object");
  const event = text(parsed["hook_event_name"], "PostToolUse");
  const cwd = text(parsed["cwd"], process.cwd());
  const shell = isShellTool(parsed);
  const budget = event === "SessionEnd" ? 1600 : event === "Stop" || event === "SubagentStop" ? BUDGET.stop : event === "SessionStart" || event === "PostToolUse" && shell ? BUDGET.quickHook : BUDGET.hook;
  let signal = AbortSignal.timeout(budget);
  try {
    const intent = shell ? void 0 : writeIntent(cwd, parsed);
    if (event === "PreToolUse" && (shell || intent?.kind !== "write")) return;
    if (event === "PostToolUse" && intent?.kind === "read") signal = AbortSignal.timeout(BUDGET.quickHook);
    const root = await realpath7(cwd);
    const runtime = new Runtime();
    try {
      const result = await runtime.request(root, "hook", parsed, signal);
      const output = renderHook(result["output"]);
      if (output) {
        await new Promise(
          (resolve12, reject) => process.stdout.write(`${JSON.stringify(output)}
`, (error) => error ? reject(error) : resolve12())
        );
        if (typeof result["deliveryId"] === "string") {
          await runtime.request(
            root,
            "hook_ack",
            { session: text(parsed["session_id"]), deliveryId: result["deliveryId"] },
            AbortSignal.any([signal, AbortSignal.timeout(100)])
          ).catch(() => void 0);
        }
      }
    } finally {
      await runtime.close();
    }
  } catch (error) {
    const context = signal.aborted ? "Codex CodeIntel: Hook budget reached; unfinished checks remain pending. Background tasks already registered continue; later Hooks or MCP queries can retrieve results." : `Codex CodeIntel unavailable: ${message(error).slice(0, 300)}`;
    process.stdout.write(
      `${JSON.stringify(event === "PreToolUse" ? { hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: context } } : event === "PostToolUse" ? { hookSpecificOutput: { hookEventName: event, additionalContext: context } } : { systemMessage: context })}
`
    );
  }
}
var init_codex_hook = __esm({
  "src/codex-hook.ts"() {
    "use strict";
    init_budgets();
    init_hook_engine();
    init_results();
    init_runtime();
    init_write_intent();
  }
});

// src/protocol.ts
import { createInterface } from "node:readline";
function tool(name, description, properties, required, readOnly) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required: ["workspace", ...required], additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false }
  };
}
function validateArguments(name, args) {
  if (args["refresh"] !== void 0 && !(name === "lsp_status" || ["check_diagnostics", "check_project"].includes(name) && args["run"] !== "cached"))
    throw new Error("refresh requires active diagnostics or lsp_status");
  const definition = TOOLS.find((entry) => entry.name === name);
  if (!definition) throw new Error("Unknown tool");
  for (const key of definition.inputSchema.required) if (args[key] === void 0) throw new Error(`${key} required`);
  for (const [key, value] of Object.entries(args)) {
    const schema = definition.inputSchema.properties[key];
    if (!record(schema))
      throw new Error(
        ["mode", "start", "offset", "revision"].includes(key) ? "Migration required: use scope/source/run/cursor; see docs/usage.md#upgrade" : `Unknown argument: ${key}`
      );
    if (schema["type"] === "boolean" && typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
    if (schema["type"] === "string" && typeof value !== "string") throw new Error(`${key} must be a string`);
    if (schema["type"] === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value) || typeof schema["minimum"] === "number" && value < schema["minimum"] || typeof schema["maximum"] === "number" && value > schema["maximum"])
        throw new Error(`Invalid integer: ${key}`);
    }
    if (schema["type"] === "array" && (!Array.isArray(value) || value.length > 200 || !value.every((item) => typeof item === "string")))
      throw new Error(`${key} must contain at most 200 strings`);
    if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) throw new Error(`Invalid ${key}`);
  }
}
async function runMcp(input = process.stdin, output = process.stdout) {
  const runtime = new Runtime();
  const controllers = /* @__PURE__ */ new Map();
  const pending = /* @__PURE__ */ new Set();
  const send = (value) => output.write(`${JSON.stringify(value)}
`);
  const handle = async (value) => {
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
    if (id === void 0) return;
    if (typeof id !== "string" && typeof id !== "number") {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid id" } });
      return;
    }
    const ok = (result) => send({ jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      ok({
        protocolVersion: text(params["protocolVersion"], "2024-11-05"),
        serverInfo: { name: "codex-codeintel", version: "0.8.0" },
        // keep in sync with package.json
        capabilities: { tools: { listChanged: false } }
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
      const rendered = name === "check_diagnostics" && Array.isArray(result["results"]) ? `${render(result["results"])}${result["next"] ? "\nMore results: follow structured next arguments." : ""}${result["inventoryComplete"] === false ? "\nDependency inventory incomplete; workspace dependency freshness unverified" : ""}` : name === "lsp_format" && Array.isArray(result["results"]) ? result["results"].map(
        (item) => record(item) ? `${item["status"] === "formatted" ? "Formatted" : "Unchanged"}: ${item["path"]}` : ""
      ).join("\n") : name === "lsp_rename" && Array.isArray(result["modifiedPaths"]) ? `Renamed: ${result["modifiedPaths"].join(", ")}` : JSON.stringify(result);
      ok({
        ...record(structured) ? { structuredContent: structured, ...structured["isError"] === true ? { isError: true } : {} } : {},
        content: [
          {
            type: "text",
            text: rendered.slice(0, 8e3)
          }
        ]
      });
    } catch (error) {
      ok({
        isError: true,
        structuredContent: {
          status: failureKind(message(error)),
          reason: message(error),
          ...error instanceof WriteFailure ? { modifiedPaths: error.modifiedPaths } : {}
        },
        content: [{ type: "text", text: message(error).slice(0, 2e3) }]
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
      let value;
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
var string, scope, paging, TOOLS;
var init_protocol = __esm({
  "src/protocol.ts"() {
    "use strict";
    init_results();
    init_runtime();
    string = { type: "string" };
    scope = {
      workspace: { type: "string", description: "Absolute user repository path, never the plugin directory." },
      session: {
        type: "string",
        description: "Codex session id for turn/session scopes; required when multiple sessions share this workspace."
      },
      path: string,
      paths: { type: "array", items: string, maxItems: 200 }
    };
    paging = { cursor: string, refresh: { type: "boolean", description: "Force tool and client revalidation" } };
    TOOLS = [
      tool(
        "check_project",
        "Run project CLI checkers; active starts background checks, cached reads a job without launching tools. Use for workspace checks.",
        { workspace: scope.workspace, run: { type: "string", enum: ["active", "cached"] }, job: string, ...paging },
        [],
        true
      ),
      tool(
        "check_diagnostics",
        "Check paths (explicit paths), current turn or session. Active runs LSP/lint; cached never starts analysis and shares automatic Hook results. Continue with complete next arguments.",
        {
          ...scope,
          ...paging,
          scope: { type: "string", enum: ["paths", "turn", "session"] },
          source: { type: "string", enum: ["lsp", "lint", "both"] },
          run: { type: "string", enum: ["active", "cached"] }
        },
        [],
        true
      ),
      tool(
        "lsp_status",
        "Explain configuration, trust, local tool selection, launchability and running clients without starting LSP. Refresh clears failures and clients.",
        { workspace: scope.workspace, path: string, refresh: { type: "boolean" } },
        [],
        true
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
              "signatureHelp"
            ]
          },
          line: { type: "integer", minimum: 1 },
          column: { type: "integer", minimum: 1 },
          query: string
        },
        ["path", "operation"],
        true
      ),
      tool(
        "lsp_rename",
        "Rename across workspace files. Preflight all targets, detect conflicts, write sequentially; never replay partial writes.",
        { ...scope, line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 1 }, newName: string },
        ["path", "newName"],
        false
      ),
      tool(
        "lsp_format",
        "Format explicit paths using Ruff for Python or project formatter/LSP. Preflight before writes.",
        scope,
        [],
        false
      )
    ];
  }
});

// src/automatic.ts
import { setTimeout as delay4, setImmediate as yieldBatch } from "node:timers/promises";
var Automatic;
var init_automatic = __esm({
  "src/automatic.ts"() {
    "use strict";
    init_budgets();
    init_config();
    init_environment();
    init_files();
    init_identity();
    init_metadata();
    init_results();
    Automatic = class {
      constructor(root, engine) {
        this.root = root;
        this.engine = engine;
        this.jobs = /* @__PURE__ */ new Map();
      }
      get active() {
        return [...this.jobs.values()].some((job) => job.state === "running");
      }
      status() {
        return [...this.jobs.values()].map((job) => ({
          session: job.session,
          generation: job.generation,
          scope: job.scope,
          state: job.state,
          total: job.paths.length,
          processed: job.results.size,
          checked: [...job.results.values()].filter((result) => result.state === "complete").length,
          remaining: job.paths.filter((path) => job.results.get(path)?.state !== "complete"),
          note: job.note
        }));
      }
      cancel(session) {
        for (const job of this.jobs.values())
          if (!session || job.session === session) {
            job.controller.abort();
            job.state = "cancelled";
            this.jobs.delete(job.session);
          }
      }
      result(job) {
        return {
          generation: job.generation,
          scope: job.scope,
          state: job.state,
          total: job.paths.length,
          results: [...job.results.values()],
          pending: job.paths.filter((path) => {
            const result = job.results.get(path);
            return result?.state !== "complete";
          }),
          note: job.note
        };
      }
      async request(args, environment, signal) {
        const session = text(args["session"]);
        const store = new Metadata(this.root);
        const state = await store.read(session);
        if (state.turn === "__ended__" || state.generation !== args["generation"])
          return { generation: -1, scope: "delta", total: 0, note: "", results: [], pending: [], state: "stale" };
        const config = await configuration(this.root);
        if (!config.trusted) {
          this.cancel();
          throw new Error("Automatic LSP/lint requires workspace trust; lint requires workspace trust");
        }
        const requested = Array.isArray(args["paths"]) ? args["paths"].filter((path) => typeof path === "string") : state.pending;
        const analysis = await analysisIdentity(this.root, requested, config, signal);
        let job = this.jobs.get(session);
        if (job && (job.epoch !== state.epoch || job.generation !== state.generation || job.configuration !== config.version || job.analysis !== analysis || hash(JSON.stringify(job.environment)) !== hash(JSON.stringify(environment)))) {
          this.cancel(session);
          job = void 0;
        }
        const knownPaths = job?.paths ?? [];
        if (job && requested.some((path) => !knownPaths.includes(path))) {
          this.cancel(session);
          job = void 0;
        }
        if (!job) {
          const paths = Array.isArray(args["paths"]) ? args["paths"].filter((path) => typeof path === "string") : state.pending;
          job = {
            session,
            epoch: state.epoch,
            turn: text(args["turn"], state.turn),
            generation: state.generation,
            scope: text(args["scope"], state.automaticScope),
            configuration: config.version,
            analysis,
            environment,
            paths: [...new Set(paths)],
            results: /* @__PURE__ */ new Map(),
            controller: new AbortController(),
            started: Date.now(),
            state: "running",
            note: "",
            done: Promise.resolve()
          };
          this.jobs.set(session, job);
          const target2 = job;
          job.done = withExecution(environment, true, () => this.run(target2));
        }
        const target = job;
        const wait = typeof args["waitMs"] === "number" ? Math.max(0, Math.min(BUDGET.project, args["waitMs"])) : BUDGET.postWait;
        if (wait === 0) return this.result(target);
        const waiting = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, wait))]);
        await Promise.race([target.done, delay4(wait, void 0, { signal: waiting }).catch(() => void 0)]);
        return this.result(target);
      }
      async run(job) {
        const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(BUDGET.project)]);
        const store = new Metadata(this.root);
        try {
          let remaining = [...job.paths];
          if (!remaining.length)
            await this.engine.dispatch("automatic_batch", { paths: [], session: job.session }, signal);
          while (remaining.length && !signal.aborted) {
            const retry = [];
            for (let start = 0; start < remaining.length; start += BUDGET.batch) {
              signal.throwIfAborted();
              const state = await store.read(job.session);
              const config = await configuration(this.root);
              if (state.turn === "__ended__" || state.epoch !== job.epoch || state.generation !== job.generation || config.version !== job.configuration || await analysisIdentity(this.root, job.paths, config, signal) !== job.analysis || !config.trusted) {
                job.state = "cancelled";
                job.note = "Generation/configuration/trust changed; results stale";
                return;
              }
              const paths = remaining.slice(start, start + BUDGET.batch);
              const output = await this.engine.dispatch(
                "automatic_batch",
                { paths, session: job.session, turn: job.turn },
                signal
              );
              const results = output["results"];
              if (await analysisIdentity(this.root, job.paths, await configuration(this.root), signal) !== job.analysis) {
                job.state = "cancelled";
                job.note = "Analysis identity changed; results stale";
                return;
              }
              await store.update(job.session, signal, (current) => {
                if (current.generation !== job.generation || current.epoch !== job.epoch || current.turn === "__ended__")
                  return false;
                for (const result of results) {
                  job.results.set(result.path, result);
                  const channels = result.channels ?? { lsp: result.state, lint: result.state };
                  for (const channel of ["lsp", "lint"]) {
                    current.pendingChannels[channel] = current.pendingChannels[channel].filter(
                      (path) => path !== result.path
                    );
                    if (channels[channel] === "pending" || channels[channel] === "stale" || channels[channel] === "failed" || channel === "lsp" && channels[channel] === "skipped")
                      current.pendingChannels[channel].push(result.path);
                  }
                  if (result.state === "complete")
                    current.pending = current.pending.filter((path) => path !== result.path);
                  if (result.state === "pending" || result.state === "stale") retry.push(result.path);
                }
                return true;
              });
              await yieldBatch();
            }
            remaining = retry;
            if (remaining.length) await delay4(1e3, void 0, { signal });
          }
          job.state = job.paths.every((path) => job.results.get(path)?.state === "complete") ? "complete" : "pending";
        } catch (error) {
          job.state = job.controller.signal.aborted ? "cancelled" : "pending";
          job.note = signal.aborted && !job.controller.signal.aborted ? "Automatic analysis exceeded five-minute budget; unfinished range retained" : message(error);
        }
      }
      async revalidate() {
        for (const job of this.jobs.values()) {
          if (job.state !== "running") continue;
          await withExecution(job.environment, true, async () => {
            try {
              const config = await configuration(this.root);
              const state = await new Metadata(this.root).read(job.session);
              if (!config.trusted || config.version !== job.configuration || state.generation !== job.generation || state.epoch !== job.epoch || state.turn === "__ended__")
                this.cancel(job.session);
            } catch {
              this.cancel(job.session);
            }
          });
        }
      }
      async dispose() {
        const tasks = [...this.jobs.values()].map((job) => job.done);
        this.cancel();
        await Promise.allSettled(tasks);
      }
    };
  }
});

// src/deadline.ts
function waitWithSignal(task, signal) {
  signal.throwIfAborted();
  return new Promise((resolve12, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    task.then(resolve12, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
var init_deadline = __esm({
  "src/deadline.ts"() {
    "use strict";
  }
});

// src/hook-coordinator.ts
import { rm as rm5 } from "node:fs/promises";
var HookCoordinator;
var init_hook_coordinator = __esm({
  "src/hook-coordinator.ts"() {
    "use strict";
    init_budgets();
    init_deadline();
    init_environment();
    init_hook_delivery();
    init_hook_inbox();
    init_log();
    init_metadata();
    init_results();
    init_write_intent();
    HookCoordinator = class {
      constructor(root, hooks, onStart = () => void 0) {
        this.root = root;
        this.hooks = hooks;
        this.onStart = onStart;
        this.jobs = /* @__PURE__ */ new Map();
        this.tasks = /* @__PURE__ */ new Set();
        this.seen = /* @__PURE__ */ new Set();
        this.disposed = false;
      }
      get active() {
        return this.tasks.size > 0;
      }
      status() {
        return [...this.jobs].map(([key]) => ({ key, state: "running" }));
      }
      ingest() {
        if (this.disposed) return Promise.resolve();
        this.ingesting ??= this.load().finally(() => {
          this.ingesting = void 0;
        });
        return this.ingesting;
      }
      async load() {
        for (const entry of await registeredHooks(this.root)) {
          if (this.disposed || this.seen.has(entry.path)) continue;
          const state = await withExecution(
            entry.environment,
            true,
            () => new Metadata(this.root).read(text(entry.input["session_id"]))
          );
          if (state.epoch !== entry.epoch) {
            await rm5(entry.path, { force: true });
            continue;
          }
          this.seen.add(entry.path);
          const key = `${text(entry.input["session_id"])}:${text(entry.input["hook_event_name"])}`;
          const previous = this.jobs.get(key);
          if (previous) {
            if (entry.input["hook_event_name"] === "SessionStart") {
              previous.registrations.add(entry.path);
              continue;
            }
            previous.controller.abort();
          }
          const job = {
            initial: entry,
            controller: new AbortController(),
            done: Promise.resolve(),
            registrations: /* @__PURE__ */ new Set([entry.path])
          };
          this.jobs.set(key, job);
          this.tasks.add(job);
          if (entry.input["hook_event_name"] === "SessionStart") this.onStart(entry);
          job.done = this.run(key, job);
        }
      }
      async run(key, job) {
        const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(BUDGET.project)]);
        try {
          await withExecution(job.initial.environment, true, () => this.hooks.hook(job.initial.input, signal, true));
        } catch {
          if (!signal.aborted) await logEvent("background-failure");
        } finally {
          if (this.jobs.get(key) === job) this.jobs.delete(key);
          for (const path of job.registrations) {
            await rm5(path, { force: true }).catch(() => logEvent("cancel-cleanup-failure"));
            this.seen.delete(path);
          }
          this.tasks.delete(job);
        }
      }
      async request(input, signal) {
        const began = Date.now();
        const session = text(input["session_id"]);
        const event = text(input["hook_event_name"], "PostToolUse");
        if (event === "PreToolUse") return { output: await this.hooks.hook(input, signal) };
        if (event === "SessionEnd") {
          for (const job2 of this.tasks) if (text(job2.initial.input["session_id"]) === session) job2.controller.abort();
          return { output: await this.hooks.hook(input, signal) };
        }
        if (event === "PostToolUse" && writeIntent(this.root, input).kind === "read")
          return consumeDelivery(this.root, session, event, signal);
        await this.ingest();
        if (event === "SessionStart" || input["stop_hook_active"] === true) return { output: { kind: "silent" } };
        const key = `${session}:${event}`;
        const job = this.jobs.get(key);
        let pending = false;
        if (job) {
          const wait = event === "Stop" || event === "SubagentStop" ? BUDGET.stopWait : BUDGET.postWait;
          const waiting = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, wait - (Date.now() - began)))]);
          try {
            await waitWithSignal(job.done, waiting);
          } catch (error) {
            if (signal.aborted || !waiting.aborted) throw error;
            pending = true;
          }
        }
        const delivery = await consumeDelivery(this.root, session, event, signal);
        return pending && delivery.output.kind === "silent" ? {
          output: {
            kind: "context",
            event,
            context: "[Codex CodeIntel automatic diagnostics] Checks still running; results pending. Background work continues and later Hooks can retrieve results."
          }
        } : delivery;
      }
      async dispose() {
        this.disposed = true;
        for (const job of this.tasks) job.controller.abort();
        await Promise.allSettled([...this.tasks].map((job) => job.done));
      }
    };
  }
});

// src/service.ts
import { rm as rm6 } from "node:fs/promises";
import { createServer } from "node:net";
async function runService(root, identity, token) {
  const location = await serviceLocation(root);
  if (location.identity !== identity || !token) throw new Error("Invalid service startup identity");
  const startup = AbortSignal.timeout(8e3);
  const release = await directoryLock(`${location.endpoint}.lock`, startup, 8e3);
  try {
    if (await existingService(root, startup)) return;
    const previous = await readEndpoint(location);
    if (previous && alive(previous.pid)) throw new Error("Service alive but unavailable; refusing duplicate startup");
    await rm6(location.endpoint, { force: true });
    if (process.platform !== "win32") await rm6(location.address, { force: true });
    await serve(root, identity, token);
  } finally {
    await release();
  }
}
async function serve(root, identity, token) {
  const location = await serviceLocation(root);
  const projects = new ProjectChecks(root);
  const engine = new Engine(root, void 0, projects);
  const automatic = new Automatic(root, engine);
  const hooks = new HookEngine(root, {
    projects,
    check: async (paths, session, turn, generation, waitMs, signal) => automatic.request(
      { paths, session, turn, generation, waitMs, scope: "delta" },
      executionEnvironment(),
      signal
    ),
    end: (session) => {
      automatic.cancel(session);
      projects.cancelSession(session);
    }
  });
  let warmupTimer;
  let warmed = false;
  let warming = false;
  let warmupTask;
  let warmupSession = "";
  const warmupController = new AbortController();
  const coordinator = new HookCoordinator(root, hooks, (entry) => {
    if (warmed) return;
    warmed = true;
    warmupSession = text(entry.input["session_id"]);
    warmupTimer = setTimeout(() => {
      warming = true;
      warmupTask = withExecution(entry.environment, true, () => engine.warmup(warmupController.signal)).catch(() => void 0).finally(() => {
        warming = false;
      });
    }, BUDGET.warmupDelay);
  });
  const sockets = /* @__PURE__ */ new Set();
  let lastActivity = Date.now();
  let requests = 0;
  let stopping = false;
  const server2 = createServer((socket) => {
    sockets.add(socket);
    const controller = new AbortController();
    let input = "";
    let started = false;
    let authenticated = false;
    socket.setEncoding("utf8");
    socket.setTimeout(5e3, () => {
      if (!authenticated) socket.destroy();
    });
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      sockets.delete(socket);
      controller.abort();
    });
    const handle = async (value) => {
      if (started) {
        if (authenticated && record(value) && value["cancel"] === true) controller.abort();
        return;
      }
      started = true;
      if (!record(value) || value["token"] !== token || value["identity"] !== identity || value["protocol"] !== SERVICE_PROTOCOL || !record(value["args"]) || !record(value["environment"]) || !Object.values(value["environment"]).every((entry) => typeof entry === "string")) {
        socket.destroy();
        return;
      }
      authenticated = true;
      requests++;
      lastActivity = Date.now();
      const operation = text(value["operation"]);
      const args = value["args"];
      const environment = value["environment"];
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
                controller.signal
              );
              return { operation };
            }
            if (operation === "automatic")
              return { operation, ...await automatic.request(args, environment, controller.signal) };
            if (operation === "check_project")
              return { ...await projects.request(args, environment, controller.signal) };
            if (operation === "hook") {
              if (args["hook_event_name"] === "SessionEnd" && text(args["session_id"]) === warmupSession) {
                if (warmupTimer) clearTimeout(warmupTimer);
                warmupTimer = void 0;
                warmupController.abort();
                warmupSession = "";
              }
              return { operation, ...await coordinator.request(args, controller.signal) };
            }
            if (!["lsp_status", "check_diagnostics", "lsp_navigation", "lsp_rename", "lsp_format"].includes(
              operation
            ))
              throw new Error("Unknown service operation");
            const config = await configuration(root);
            if (!config.trusted) automatic.cancel();
            const output2 = await engine.dispatch(operation, args, controller.signal);
            if (operation === "lsp_status")
              return {
                ...output2,
                service: { state: "running", pid: process.pid, identity, protocol: SERVICE_PROTOCOL },
                automaticDiagnostics: config.automaticDiagnostics,
                automaticTasks: automatic.status(),
                hookTasks: coordinator.status()
              };
            return output2;
          }
        );
        if (!socket.destroyed) socket.end(`${JSON.stringify({ output })}
`);
      } catch (error) {
        if (!socket.destroyed)
          socket.end(
            `${JSON.stringify({ error: message(error), ...error instanceof WriteFailure ? { modifiedPaths: error.modifiedPaths } : {} })}
`
          );
      } finally {
        requests--;
        lastActivity = Date.now();
      }
    };
    socket.on("data", (chunk) => {
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
    server2.close();
    for (const socket of sockets) socket.destroy();
    await coordinator.dispose();
    await automatic.dispose();
    await warmupTask;
    await projects.dispose();
    await engine.dispose();
    if ((await readEndpoint(location).catch(() => void 0))?.token === token)
      await rm6(location.endpoint, { force: true });
  };
  let revalidation;
  const idle = setInterval(() => {
    void coordinator.ingest().catch(() => void 0);
    if (!revalidation)
      revalidation = automatic.revalidate().catch(() => void 0).finally(() => {
        revalidation = void 0;
      });
    if (requests || coordinator.active || automatic.active || projects.active || warming || warmupTimer && !warmupTask)
      lastActivity = Date.now();
    else if (Date.now() - lastActivity >= BUDGET.idle) void stop();
  }, 250);
  process.once("SIGTERM", () => {
    void stop();
  });
  process.once("SIGINT", () => {
    void stop();
  });
  await new Promise((resolve12, reject) => {
    server2.once("error", reject);
    server2.listen(location.address, resolve12);
  });
  await publishEndpoint(location, token);
  await coordinator.ingest();
}
var init_service = __esm({
  "src/service.ts"() {
    "use strict";
    init_automatic();
    init_budgets();
    init_config();
    init_directory_lock();
    init_engine();
    init_environment();
    init_hook_coordinator();
    init_hook_delivery();
    init_hook_engine();
    init_ipc();
    init_project_checks();
    init_results();
    init_service_identity();
  }
});

// src/main.ts
var main_exports = {};
__export(main_exports, {
  main: () => main
});
async function main() {
  restoreInstalledHome();
  const [command = "mcp"] = process.argv.slice(2);
  if (command === "mcp") await runMcp();
  else if (command === "hook") await runHookCli();
  else if (command === "service")
    await runService(process.argv[3] ?? "", process.argv[4] ?? "", process.argv[5] ?? "");
  else if (command === "check_project") {
    const runtime = new Runtime();
    const options = { run: "active" };
    const tokens = process.argv.slice(3);
    const workspace = tokens[0] && !tokens[0].startsWith("--") ? tokens.shift() ?? process.cwd() : process.cwd();
    while (tokens.length) {
      const flag = tokens.shift();
      if (flag === "--refresh") options["refresh"] = true;
      else if (["--run", "--job", "--cursor"].includes(flag ?? "")) {
        const value = tokens.shift();
        if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
        options[flag?.slice(2) ?? ""] = value;
      } else throw new Error(`Unknown option ${flag}`);
    }
    if (!["active", "cached"].includes(String(options["run"]))) throw new Error("run must be active or cached");
    try {
      process.stdout.write(
        `${JSON.stringify(await runtime.request(workspace, "check_project", options, AbortSignal.timeout(BUDGET.request)))}
`
      );
    } finally {
      await runtime.close();
    }
  } else throw new Error("Usage: codex-codeintel [mcp | hook | check_project [workspace]]");
}
var init_main = __esm({
  "src/main.ts"() {
    "use strict";
    init_budgets();
    init_codex_hook();
    init_environment();
    init_protocol();
    init_runtime();
    init_service();
  }
});

// src/cli.ts
var [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || major === 22 && minor < 12) {
  const reason = `Codex CodeIntel requires Node >=22.12.0; found ${process.versions.node}.`;
  if (process.argv[2] === "hook") {
    let event = "";
    let passthrough = false;
    let input = "";
    for await (const chunk of process.stdin) {
      input += String(chunk);
      if (input.length > 1024 * 1024) break;
    }
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object" && "hook_event_name" in parsed && typeof parsed.hook_event_name === "string") {
        event = parsed.hook_event_name;
        const tool2 = "tool_name" in parsed && typeof parsed.tool_name === "string" ? parsed.tool_name : "";
        passthrough = event === "PreToolUse" && (/^(?:bash|shell|exec_command|unified_exec)$/i.test(tool2.split(".").at(-1) ?? "") || /read|search|list|status|diagnostics|check_project|navigation|glob|view_image/i.test(tool2));
      }
    } catch {
    }
    if (!passthrough)
      process.stdout.write(
        `${JSON.stringify({ systemMessage: reason, ...event === "PreToolUse" ? { hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: reason } } : {} })}
`
      );
  } else {
    process.stderr.write(`${reason}
`);
    process.exitCode = 1;
  }
} else {
  const { main: main2 } = await Promise.resolve().then(() => (init_main(), main_exports));
  await main2().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
    process.exitCode = 1;
  });
}
