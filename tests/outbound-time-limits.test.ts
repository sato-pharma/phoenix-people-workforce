import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_OUTBOUND_TIMEOUT_MS,
  OutboundTimeoutError,
  fetchWithTimeout,
  isOutboundTimeoutError,
} from "../src/lib/http/fetch-with-timeout.ts";

/**
 * EVERY CALL TO AN OUTSIDE SERVICE HAS A TIME LIMIT (audit item REC-050, 13 Nov 2026).
 *
 * The integration audit's ISS-011 (tests/integration-audit-edges.test.ts) pins the deadline on the
 * calls it NAMED, by counting them file by file. This is the repo-wide half: a NEW outbound call
 * anywhere under `src/lib` or `app/api` with no deadline fails here, by file and line, the day it
 * is written.
 *
 * WHAT COUNTS AS AN OUTBOUND CALL. A call to `fetch(` — or to an injected fetch (`fetchImpl(`,
 * `fetchFn(`, `fetcher(`, `doFetch(`) — whose address is provably outside this app:
 *   - its first argument holds an `http://` / `https://` literal, or
 *   - names a constant of this file that holds one (`API_BASE`, `TOKEN_URL`), or
 *   - names a local variable whose declaration holds either (`const url = \`${TOKEN_URL}?…\``).
 * Such a call passes when its options carry a `signal` (the house style:
 * `signal: AbortSignal.timeout(...)`), or when it goes through `fetchWithTimeout`, which always has one.
 *
 * OUT OF SCOPE, deliberately:
 *   - browser code: any file that starts with "use client" (the person's own browser cancels it, and
 *     `src/components/**` is not scanned at all);
 *   - same-origin and local calls: `/api/...` paths, `localhost`, `127.0.0.1`;
 *   - the Supabase client (`supabase.from(...)`, `.storage`) — it is not a `fetch(` here, and its
 *     own transport is configured where the client is made;
 *   - an address the scan cannot see the origin of (a function parameter, an environment variable).
 *     Those are left to review; the scan never guesses.
 * Comments are stripped first, so a comment that quotes a call neither trips nor satisfies it.
 */

const ROOT = process.cwd();
const SCANNED_DIRS = ["src/lib", "app/api"];
const FETCH_CALLEES = new Set(["fetch", "fetchImpl", "fetchFn", "fetcher", "doFetch"]);

/**
 * Calls that are outbound and carry no deadline ON PURPOSE, each with its reason. Keep this short:
 * the right fix is almost always a deadline. Key: `file:callee:first-argument` (line-free, so an
 * edit above the call does not break the entry).
 */
const ALLOWED_WITHOUT_DEADLINE = new Map<string, string>([]);

// ── The scanner ─────────────────────────────────────────────────────────────────────────────────

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      filesUnder(rel, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Comments out, everything else kept in place (a comment becomes spaces, its newlines stay), so a
 * character offset in the result is the same line in the file. Strings, template literals and
 * regular-expression literals are stepped over, so `"https://…"` and `/https?:\/\//` stay intact.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const templateDepth: number[] = [];
  let braceDepth = 0;
  let lastSignificant = "";
  const blank = (text: string) => text.replace(/[^\n]+/g, (run) => " ".repeat(run.length));

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
      lastSignificant = ch;
      continue;
    }
    if (ch === "`" || (ch === "}" && templateDepth.length > 0 && templateDepth[templateDepth.length - 1] === braceDepth)) {
      // A template literal, or the rest of one after a `${ … }` closes.
      if (ch === "}") templateDepth.pop();
      let j = i + 1;
      while (j < source.length && source[j] !== "`") {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === "$" && source[j + 1] === "{") {
          templateDepth.push(braceDepth);
          j += 2;
          break;
        }
        j += 1;
      }
      const closed = source[j] === "`";
      out += source.slice(i, closed ? j + 1 : j);
      i = closed ? j + 1 : j;
      lastSignificant = "`";
      continue;
    }
    if (ch === "/" && (lastSignificant === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastSignificant))) {
      // A regular-expression literal: step to its unescaped closing slash, outside any [class].
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== "\n") {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        else if (source[j] === "/" && !inClass) break;
        j += 1;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      lastSignificant = "/";
      continue;
    }
    if (ch === "{") braceDepth += 1;
    if (ch === "}") braceDepth -= 1;
    out += ch;
    if (!/\s/.test(ch)) lastSignificant = /[\w$)\]]/.test(ch) ? "a" : ch;
    i += 1;
  }
  return out;
}

/** The text between the `(` at `open` and its matching `)`, stepping over strings. */
function callArguments(source: string, open: number): string {
  let depth = 0;
  let quote = "";
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source.slice(open + 1);
}

/** The arguments split at top-level commas. */
function splitArguments(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(args.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(args.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

const EXTERNAL_LITERAL = /["'`]https?:\/\/(?!localhost[:/"'`]|127\.0\.0\.1[:/"'`]|\[::1\])/;

function identifiersIn(text: string): string[] {
  return text.match(/[A-Za-z_$][\w$]*/g) ?? [];
}

/** `NAME = <declaration>` for every const/let/var in the file (the first one wins). */
function declarations(source: string): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (found.has(match[1])) continue;
    const start = match.index + match[0].length;
    // To the end of the statement; capped, so a declaration with no semicolon cannot swallow the file.
    const end = source.indexOf(";", start);
    const stop = Math.min(end === -1 ? source.length : end, start + 600);
    found.set(match[1], source.slice(start, stop));
  }
  return found;
}

export type OutboundCall = { file: string; line: number; callee: string; target: string; hasDeadline: boolean };

export function scanOutboundCalls(): OutboundCall[] {
  const calls: OutboundCall[] = [];
  for (const dir of SCANNED_DIRS) {
    for (const file of filesUnder(dir)) {
      const raw = readFileSync(path.join(ROOT, file), "utf8");
      // Most files never call a fetch at all; only those that might are stripped and read closely.
      if (!/(?<![\w$.])(?:fetch|fetchImpl|fetchFn|fetcher|doFetch)\s*\(/.test(raw)) continue;
      const source = stripComments(raw);
      if (/^\s*["']use client["']/.test(source)) continue;

      const decls = declarations(source);
      const external = new Set<string>();
      for (const [name, value] of decls) if (EXTERNAL_LITERAL.test(value)) external.add(name);
      // One level of indirection: `const url = \`${API_BASE}/…\`` is external because API_BASE is.
      for (const [name, value] of decls) if (identifiersIn(value).some((id) => external.has(id))) external.add(name);
      const isExternal = (text: string) => EXTERNAL_LITERAL.test(text) || identifiersIn(text).some((id) => external.has(id));

      const callPattern = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
      let match: RegExpExecArray | null;
      while ((match = callPattern.exec(source)) !== null) {
        const callee = match[1];
        if (!FETCH_CALLEES.has(callee)) continue;
        if (/\bfunction\s*$/.test(source.slice(Math.max(0, match.index - 20), match.index))) continue;
        const args = splitArguments(callArguments(source, match.index + match[0].length - 1));
        if (args.length === 0 || !isExternal(args[0])) continue;
        const options = args.slice(1).join(",");
        const optionsIdentifier = /^[A-Za-z_$][\w$]*$/.test(options) ? options : "";
        const hasDeadline =
          /\bsignal\b/.test(options) || (optionsIdentifier !== "" && /\bsignal\b/.test(decls.get(optionsIdentifier) ?? ""));
        calls.push({
          callee,
          file,
          hasDeadline,
          line: source.slice(0, match.index).split("\n").length,
          target: args[0].replace(/\s+/g, " "),
        });
      }
    }
  }
  return calls;
}

function everyOutboundCallHasADeadline() {
  const calls = scanOutboundCalls();
  // A scanner that finds nothing would pass forever. These are known outbound calls that must be seen.
  assert.ok(calls.length >= 40, `the scan found only ${calls.length} outbound calls — it has stopped seeing them`);
  for (const [file, minimum] of [
    ["src/lib/zoom/meetings.ts", 7],
    ["src/lib/sales/master-map/sheets-client.ts", 2],
    ["src/lib/outstation/places-autocomplete.ts", 1],
  ] as const) {
    const seen = calls.filter((call) => call.file === file).length;
    assert.ok(seen >= minimum, `${file}: the scan saw ${seen} outbound call(s), expected at least ${minimum}`);
  }

  const missing = calls
    .filter((call) => !call.hasDeadline)
    .filter((call) => !ALLOWED_WITHOUT_DEADLINE.has(`${call.file}:${call.callee}:${call.target}`))
    .map((call) => `${call.file}:${call.line} ${call.callee}(${call.target}, …)`);
  assert.deepEqual(
    missing,
    [],
    "an outbound call with no time limit holds the request open until the platform cuts it (REC-050). " +
      "Give it `signal: AbortSignal.timeout(ms)`, or call it through fetchWithTimeout from src/lib/http/fetch-with-timeout.ts",
  );

  // An allow-list entry for a call that no longer exists, or that now has a deadline, is stale.
  const live = new Set(calls.filter((call) => !call.hasDeadline).map((call) => `${call.file}:${call.callee}:${call.target}`));
  for (const key of ALLOWED_WITHOUT_DEADLINE.keys()) assert.ok(live.has(key), `stale allow-list entry: ${key}`);

  // The three calls REC-050 found beyond the audit's list go through the helper.
  const drive = stripComments(readFileSync(path.join(ROOT, "src/lib/recruitment/drive-storage.ts"), "utf8"));
  assert.equal(drive.split("await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/").length - 1, 2, "both Drive reads carry a deadline");
  const photos = stripComments(readFileSync(path.join(ROOT, "src/lib/phoenix-crm/server/photos.ts"), "utf8"));
  const put = photos.slice(photos.indexOf("await fetchWithTimeout(slot.signedUrl"));
  assert.ok(put.length > 0 && /method: "PUT"/.test(put.slice(0, 400)) && !/retry:/.test(put.slice(0, 400)), "the photo PUT carries a deadline and is never retried");
}

// ── The scanner sees what it must, and nothing else ─────────────────────────────────────────────

function theStripperKeepsAddressesAndDropsComments() {
  const stripped = stripComments(
    [
      '// await fetch("https://quoted.example/in-a-comment")',
      'const A = "https://keep.example//double"; /* fetch("https://x.example") */',
      "const re = /https?:\\/\\//; const B = `https://t.example/${re}/x`;",
    ].join("\n"),
  );
  assert.equal(stripped.split("\n").length, 3, "line numbers survive");
  assert.ok(!stripped.includes("in-a-comment") && !stripped.includes("x.example"), "comments are gone");
  assert.ok(stripped.includes('"https://keep.example//double"'), "a `//` inside a string is not a comment");
  assert.ok(stripped.includes("`https://t.example/${re}/x`"), "a regex with `\\/\\/` does not swallow the rest of the line");
}

// ── The helper ─────────────────────────────────────────────────────────────────────────────────

/** A fetch that answers only when its signal fires — a provider that accepted and said nothing. */
function stalledFetch(seen: Array<RequestInit | undefined>) {
  return (_input: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      seen.push(init);
      init?.signal?.addEventListener("abort", () => reject(init?.signal?.reason), { once: true });
    });
}

async function theHelperTimesOutAndNamesOnlyTheHost() {
  assert.equal(DEFAULT_OUTBOUND_TIMEOUT_MS, 15_000, "the default the codebase already uses most for a provider call");
  const seen: Array<RequestInit | undefined> = [];
  const started = Date.now();
  const error = await fetchWithTimeout("https://api.example.test/v1/thing?key=SECRET-KEY", {
    fetchImpl: stalledFetch(seen),
    timeoutMs: 30,
  }).catch((caught: unknown) => caught);
  assert.ok(isOutboundTimeoutError(error), "running out of time is a named error");
  assert.ok(error instanceof OutboundTimeoutError);
  assert.equal(error.host, "api.example.test");
  assert.equal(error.timeoutMs, 30);
  assert.ok(!error.message.includes("SECRET-KEY") && !error.message.includes("/v1/"), "never the path or the query — it can hold a key");
  assert.ok(Date.now() - started < 2_000, "and it gave up on time");
  assert.equal(seen.length, 1, "a call with no retry asked is made once");
  assert.ok(seen[0]?.signal instanceof AbortSignal, "the provider is handed a signal");
}

async function theHelperPassesTheCallersAbortThrough() {
  const seen: Array<RequestInit | undefined> = [];
  const controller = new AbortController();
  const reason = new Error("the person left the page");
  const pending = fetchWithTimeout("https://api.example.test/slow", {
    fetchImpl: stalledFetch(seen),
    retry: { attempts: 3 },
    signal: controller.signal,
    timeoutMs: 5_000,
  }).catch((caught: unknown) => caught);
  setTimeout(() => controller.abort(reason), 10);
  const error = await pending;
  assert.equal(error, reason, "the caller's own abort comes back as the reason it aborted with");
  assert.ok(!isOutboundTimeoutError(error), "and is never dressed up as a timeout");
  assert.equal(seen.length, 1, "nor retried, even with retries asked");
  assert.notEqual(seen[0]?.signal, controller.signal, "the caller's signal is COMBINED with the deadline, not handed on alone");

  const already = new AbortController();
  already.abort(reason);
  const early = await fetchWithTimeout("https://api.example.test/slow", { fetchImpl: stalledFetch([]), signal: already.signal }).catch(
    (caught: unknown) => caught,
  );
  assert.equal(early, reason, "an already-aborted caller never reaches the provider");
}

async function theHelperRetriesAGetOnceOn503() {
  const methods: string[] = [];
  const answers = [503, 200];
  const response = await fetchWithTimeout("https://api.example.test/read", {
    fetchImpl: async (_input: string, init?: RequestInit) => {
      methods.push(String(init?.method ?? "GET"));
      return new Response("body", { status: answers[methods.length - 1] ?? 200 });
    },
    retry: { attempts: 2 },
  });
  assert.equal(methods.length, 2, "a GET that met a 503 is asked once more");
  assert.equal(response.status, 200);

  let tries = 0;
  const last = await fetchWithTimeout("https://api.example.test/read", {
    fetchImpl: async () => {
      tries += 1;
      return new Response("down", { status: 503 });
    },
    retry: { attempts: 2 },
  });
  assert.equal(tries, 2, "at most the attempts asked");
  assert.equal(last.status, 503, "the last 5xx is handed back, so the caller's own error mapping reads it");

  let notFound = 0;
  await fetchWithTimeout("https://api.example.test/read", {
    fetchImpl: async () => {
      notFound += 1;
      return new Response("", { status: 404 });
    },
    retry: { attempts: 3 },
  });
  assert.equal(notFound, 1, "a 4xx is an answer, never retried");

  let capped = 0;
  await fetchWithTimeout("https://api.example.test/read", {
    fetchImpl: async () => {
      capped += 1;
      return new Response("", { status: 500 });
    },
    retry: { attempts: 99 },
  });
  assert.equal(capped, 3, "however many tries are asked, three is the ceiling");
}

async function theHelperNeverRetriesAWrite() {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
    let tries = 0;
    const response = await fetchWithTimeout("https://api.zoom.example/v2/users/me/meetings", {
      body: "{}",
      fetchImpl: async () => {
        tries += 1;
        return new Response("", { status: 503 });
      },
      method,
      retry: { attempts: 3 },
    });
    assert.equal(tries, 1, `a ${method} is sent once — a meeting create or an upload must never be made twice`);
    assert.equal(response.status, 503);

    let timedOut = 0;
    const error = await fetchWithTimeout("https://api.zoom.example/v2/users/me/meetings", {
      fetchImpl: (_input: string, init?: RequestInit) => {
        timedOut += 1;
        return stalledFetch([])(_input, init);
      },
      method,
      retry: { attempts: 3 },
      timeoutMs: 20,
    }).catch((caught: unknown) => caught);
    assert.ok(isOutboundTimeoutError(error));
    assert.equal(timedOut, 1, `nor is a ${method} that ran out of time`);
  }
}

export async function runOutboundTimeLimitsTests() {
  theStripperKeepsAddressesAndDropsComments();
  everyOutboundCallHasADeadline();
  // AbortSignal.timeout's timer does not hold the process open (it is unref'd), so a run with nothing
  // else pending would exit mid-wait. This keeps the loop alive while the deadlines are being proved.
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    await theHelperTimesOutAndNamesOnlyTheHost();
    await theHelperPassesTheCallersAbortThrough();
    await theHelperRetriesAGetOnceOn503();
    await theHelperNeverRetriesAWrite();
  } finally {
    clearInterval(keepAlive);
  }
}
