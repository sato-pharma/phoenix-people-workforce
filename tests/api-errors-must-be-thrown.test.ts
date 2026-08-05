import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// The helpers in src/lib/http/api-errors.ts are FACTORIES: `notFoundError("...")` builds an
// ApiError and hands it back. It does not throw. So a bare call is a silent no-op — the error
// object is constructed, dropped on the floor, and execution carries on into the very null the
// guard existed to stop.
//
// This shipped live on 2026-08-05 (PR #1748). Six sites in the direct-orders Stage 2 code read
//
//     if (!row) notFoundError("Link not found.");
//
// which looks exactly like a guard and behaves like a comment. Production returned
// HTTP 500 "Cannot read properties of null (reading 'surface')" for any bad share-link token
// instead of a clean 404 — failing closed, but leaking an internal message and burning a real
// error budget on a case the code had already handled correctly on paper.
//
// The reason this needs a test rather than care: `throw notFoundError(x)` and `notFoundError(x)`
// are BOTH valid TypeScript with identical types, so neither tsc nor eslint says a word. Nothing
// in the toolchain can see the difference. A grep can.
//
// Scope is deliberately repo-wide, not the two files that were wrong — the mistake is a property
// of the API's shape, so it can reappear anywhere either helper is imported.
// ─────────────────────────────────────────────────────────────────────────────

const ERROR_FACTORIES = [
  "validationError",
  "unauthorizedError",
  "forbiddenError",
  "notFoundError",
  "conflictError",
];

const SCAN_ROOTS = ["src", "app"];

/** Every .ts/.tsx file under the given roots. */
function collectSourceFiles(root: URL): string[] {
  const found: string[] = [];
  const walk = (dir: URL): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".next" || entry.startsWith("_wt-")) continue;
      const child = new URL(`${entry}${""}`, `${dir.href}/`);
      const stats = statSync(child);
      if (stats.isDirectory()) {
        walk(child);
      } else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry)) {
        found.push(child.href);
      }
    }
  };
  walk(root);
  return found;
}

/**
 * Is this occurrence a bare expression statement — i.e. the constructed error goes nowhere?
 *
 * Legitimate uses all consume the value: `throw f(...)`, `return f(...)`, `const e = f(...)`,
 * `reject(f(...))`. Those are recognised by what sits immediately to the left of the call.
 * Two shapes drop it, and they are the two that shipped:
 *   `notFoundError("x");`            — call alone on the line
 *   `if (!row) notFoundError("x");`  — call as an if/else body
 */
function isDroppedOnTheFloor(line: string, indexOfCall: number): boolean {
  const before = line.slice(0, indexOfCall).trim();
  if (before === "") return true;
  // An if/else guard body: `if (...) f(...)` / `} else f(...)`.
  if (/^(\}\s*)?(if|else if|else)\b/.test(before) && before.endsWith(")")) return true;
  return false;
}

export function runApiErrorsMustBeThrownTests() {
  const offenders: string[] = [];
  const callSites = { total: 0, thrown: 0 };

  for (const rootName of SCAN_ROOTS) {
    const root = new URL(`../${rootName}`, import.meta.url);
    for (const fileHref of collectSourceFiles(root)) {
      // The definitions themselves legitimately `return new ApiError(...)`.
      if (fileHref.includes("/http/api-errors.ts")) continue;
      const source = readFileSync(new URL(fileHref), "utf8");
      if (!ERROR_FACTORIES.some((name) => source.includes(name))) continue;

      const lines = source.split(/\r?\n/);
      lines.forEach((line, i) => {
        // Skip imports and comment lines outright.
        const trimmed = line.trim();
        if (trimmed.startsWith("import ") || trimmed.startsWith("//") || trimmed.startsWith("*")) return;

        for (const name of ERROR_FACTORIES) {
          const pattern = new RegExp(`(^|[^\\w.])${name}\\s*\\(`, "g");
          let match: RegExpExecArray | null;
          while ((match = pattern.exec(line)) !== null) {
            const at = match.index + match[0].length - name.length - 1;
            callSites.total += 1;
            if (!isDroppedOnTheFloor(line, at)) {
              callSites.thrown += 1;
              continue;
            }
            const relative = fileHref.slice(fileHref.indexOf("/src/") + 1) || fileHref;
            offenders.push(`${relative}:${i + 1}  ${trimmed}`);
          }
        }
      });
    }
  }

  // ── THE HEADLINE ────────────────────────────────────────────────────────────────────────
  // If this fires, someone has written a guard that does nothing. The listed line constructs an
  // ApiError and discards it; the next line then runs on the value the guard was rejecting.
  assert.equal(
    offenders.length,
    0,
    `An api-errors factory is called without \`throw\`, so the error is silently discarded and ` +
      `execution continues into the case the guard was meant to reject. Add \`throw\`:\n  ` +
      offenders.join("\n  "),
  );

  // Guard the guard: if a refactor renames the helpers or moves them behind a wrapper, the sweep
  // above would find nothing and pass vacuously. It must keep seeing real call sites.
  assert.ok(
    callSites.total > 50,
    `The api-errors sweep only found ${callSites.total} call sites, which means it has stopped ` +
      `matching the real code and is now passing for the wrong reason.`,
  );
}
