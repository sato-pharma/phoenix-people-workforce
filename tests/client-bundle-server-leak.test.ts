import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// A "use client" module may never reach server-only code through its imports.
//
// This is the mirror of tests/rsc-client-function-props.test.ts: that one walks the graph out
// of server pages, this one walks it out of client components. It exists because the Direct
// Orders new-request page could not be opened in local dev AT ALL, on main:
//
//   ⨯ node:crypto
//   Module build failed: UnhandledSchemeError: Reading from "node:crypto" is not handled by
//   plugins (Unhandled scheme).
//   Import trace for requested module:
//     node:crypto
//     ./src/lib/employees/employee-photo.ts
//     ./src/lib/employees/employee-directory.ts
//     ./src/lib/sales/access-scope.ts
//     ./src/lib/direct-orders/product-family.ts
//     ./src/components/direct-orders/direct-order-submit-form.tsx   <- "use client"
//
// The form needs two pure things from product-family (which family may put several products on
// one request). product-family took them from access-scope, and access-scope pulls the
// server-only Supabase/employee-directory chain, which ends at employee-photo's `node:crypto`.
// That import is a DELIBERATE tripwire (see the comment at the top of employee-photo.ts) — it is
// meant to fail an accidental client bundle. It did. The fix was to move the two primitives into
// the dependency-free ./confidential-products.ts, exactly as official-lines.ts was split out
// before it, with access-scope re-exporting them so its ~30 server callers never noticed.
//
// NOTHING ELSE COULD HAVE CAUGHT IT, which is what makes the walk worth its cost:
//   - `next build` tree-shakes the unused chain away, so the production build stayed green and
//     the production page renders fine (measured: 307 to /login, not 500). Only dev broke.
//   - lint and typecheck never resolve bundles.
//   - the suite never builds a page.
//   - and the blast radius hides the cause. Once webpack has refused that module the dev server
//     500s EVERY later request, /api/healthz included, so it reads as "my dev server is broken"
//     rather than "this page has a bad import" — which is exactly how it survived. Clear .next,
//     healthz answers 200, and you conclude it was a stale build. It only returns when something
//     compiles that one page again.
//
// Static import edges only (`import ... from`, bare `import "..."`, and `export ... from`). A
// dynamic import() is a separate chunk and not part of this failure mode.
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

const SCAN_ROOTS = ["src", "app"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "__snapshots__"]);
const EXTENSIONS = [".ts", ".tsx", ".mts"];

/**
 * Modules that must never end up in a browser bundle, and why.
 *
 * `node:` BUILTINS ONLY, deliberately. These are the ones webpack refuses outright — it has no
 * handler for the scheme, so the module fails to build and takes the dev server with it. That is
 * the exact defect this test was written for, and the tree is clean of it.
 *
 * `@/lib/supabase/server` is NOT in this set, and that is a measured decision rather than an
 * oversight. 236 client-reachable chains end there today (permissions.ts alone accounts for most
 * of them, because half the client components import a value from it). None of them breaks a
 * build: @supabase/supabase-js bundles for the browser perfectly happily, and the service-role
 * KEY is a server-side env read that is simply undefined in a browser, so nothing leaks at
 * runtime — it is bundle weight and a bad smell, not a live exposure. Adding it here would mean
 * shipping a test that is red on main, which is a different piece of work; it is flagged as a
 * follow-up instead. Keep this list to things that genuinely cannot compile.
 */
const SERVER_ONLY_SPECIFIERS = new Map<string, string>([
  ["node:crypto", "Node builtin — webpack refuses it in a client bundle (UnhandledSchemeError)"],
  ["node:fs", "Node builtin — filesystem access has no meaning in a browser"],
  ["node:fs/promises", "Node builtin — filesystem access has no meaning in a browser"],
  ["node:child_process", "Node builtin — never reachable from the browser"],
  ["node:net", "Node builtin — never reachable from the browser"],
  ["node:dns", "Node builtin — never reachable from the browser"],
  ["node:os", "Node builtin — never reachable from the browser"],
]);

/**
 * Client entries that ALREADY leak a Node builtin. A ratchet, not a pardon — empty since
 * 2026-09-03, when the six entries measured that day (business-review, monthly-closing, the
 * portal closing view, the closing performance review, the closing period picker, and the
 * monthly attendance summary) were each split the same way the Direct Orders form was: the pure
 * values a client component needs moved into a dependency-free module
 * (monthly-closing-matrix-cells.ts, review-views.ts, closing-performance-review-regions.ts,
 * monthly-summary-note.ts), re-exported from the original for existing server callers. The list
 * may only shrink: a new entry fails the test, and so does an entry that has been fixed but left
 * behind.
 */
const KNOWN_LEAKS = new Set<string>([]);

type SourceFile = { path: string; text: string };

function collectSourceFiles(): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (absDir: string, relDir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || entry.startsWith("_wt-")) continue;
      const abs = `${absDir}/${entry}`;
      const rel = relDir ? `${relDir}/${entry}` : entry;
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!EXTENSIONS.some((ext) => entry.endsWith(ext))) continue;
      if (entry.endsWith(".d.ts")) continue;
      files.push({ path: rel, text: readFileSync(abs, "utf8") });
    }
  };
  for (const root of SCAN_ROOTS) walk(`${REPO_ROOT}${root}`, root);
  return files;
}

/** True when the file carries the "use client" directive above its imports. */
function isClientEntry(text: string): boolean {
  const head = text.slice(0, 4000);
  const directive = head.search(/^\s*["']use client["']\s*;?\s*$/m);
  if (directive < 0) return false;
  const firstImport = head.search(/^\s*import\s/m);
  return firstImport < 0 || directive < firstImport;
}

/**
 * True when an import clause is erased at compile time and so never reaches a bundle.
 *
 * This distinction is the whole difference between a real leak and noise. Dozens of client
 * components legitimately take `PhoenixRole` / `AccessContext` as TYPES from modules that are
 * server-only at runtime — `import type { PhoenixRole } from "@/lib/auth/permissions"` compiles
 * to nothing at all. Counting those reported 100+ "violations" on a tree whose pages all load.
 * Both spellings are erased: a `import type { … }` clause, and a `import { type A, type B }`
 * clause in which EVERY binding is marked. One unmarked binding makes the whole import real.
 */
function isTypeOnlyClause(clause: string): boolean {
  const trimmed = clause.trim();
  if (/^type\s/.test(trimmed)) return true;
  const braced = trimmed.match(/^\{([\s\S]*)\}$/);
  if (!braced) return false;
  const bindings = braced[1]
    .split(",")
    .map((binding) => binding.trim())
    .filter((binding) => binding.length > 0);
  return bindings.length > 0 && bindings.every((binding) => /^type\s/.test(binding));
}

/** Every static import / re-export specifier in a file that survives into a bundle. */
function importSpecifiers(text: string): string[] {
  const found: string[] = [];
  const clausePatterns = [
    /^[ \t]*import\s+([^;]*?)\s*from\s*["']([^"']+)["']/gm,
    /^[ \t]*export\s+([^;]*?)\s*from\s*["']([^"']+)["']/gm,
  ];
  for (const pattern of clausePatterns) {
    for (const match of text.matchAll(pattern)) {
      if (isTypeOnlyClause(match[1])) continue;
      found.push(match[2]);
    }
  }
  // Bare side-effect imports (`import "./x"`) carry no clause and are always emitted.
  for (const match of text.matchAll(/^[ \t]*import\s*["']([^"']+)["']/gm)) found.push(match[1]);
  return found;
}

/**
 * Resolve a specifier to a repo-relative file, or null when it is external.
 *
 * `@/*` maps to ["./*", "./src/*"] in tsconfig — ROOT FIRST. That order is load-bearing:
 * `@/lib/utils` is the root lib/utils.ts, not src/lib/utils.ts.
 */
function resolveSpecifier(fromPath: string, specifier: string): string | null {
  let bases: string[];
  if (specifier.startsWith("@/")) {
    const rest = specifier.slice(2);
    bases = [rest, `src/${rest}`];
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const dir = fromPath.split("/").slice(0, -1);
    for (const part of specifier.split("/")) {
      if (part === "." || part === "") continue;
      if (part === "..") dir.pop();
      else dir.push(part);
    }
    bases = [dir.join("/")];
  } else {
    return null;
  }
  for (const base of bases) {
    for (const ext of EXTENSIONS) {
      if (existsSync(`${REPO_ROOT}${base}${ext}`)) return `${base}${ext}`;
    }
    for (const ext of EXTENSIONS) {
      if (existsSync(`${REPO_ROOT}${base}/index${ext}`)) return `${base}/index${ext}`;
    }
  }
  return null;
}

export async function runClientBundleServerLeakTests(): Promise<void> {
  const files = collectSourceFiles();
  const byPath = new Map(files.map((file) => [file.path, file] as const));
  const specifierCache = new Map<string, string[]>();
  const specifiersFor = (path: string): string[] => {
    let cached = specifierCache.get(path);
    if (!cached) {
      cached = importSpecifiers(byPath.get(path)?.text ?? "");
      specifierCache.set(path, cached);
    }
    return cached;
  };

  const clientEntries = files.filter((file) => isClientEntry(file.text)).map((file) => file.path);
  assert.ok(
    clientEntries.length > 50,
    `expected the walk to find many "use client" modules, found ${clientEntries.length} — the detector is broken`,
  );
  assert.ok(
    clientEntries.includes("src/components/direct-orders/direct-order-submit-form.tsx"),
    'the Direct Orders submit form must be seen as a "use client" entry — it is the module this test was written for',
  );

  // Breadth-first out of every client entry, carrying the chain that reached each module so a
  // failure reads like webpack's own import trace instead of merely naming the offender.
  const violationsByEntry = new Map<string, string[]>();
  for (const entry of clientEntries) {
    const seen = new Set<string>([entry]);
    const queue: { path: string; chain: string[] }[] = [{ path: entry, chain: [entry] }];
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      for (const specifier of specifiersFor(next.path)) {
        const reason = SERVER_ONLY_SPECIFIERS.get(specifier);
        if (reason) {
          const existing = violationsByEntry.get(entry) ?? [];
          existing.push(
            `    reaches ${specifier} — ${reason}\n    via ${[...next.chain, specifier].join("\n     -> ")}`,
          );
          violationsByEntry.set(entry, existing);
          continue;
        }
        const resolved = resolveSpecifier(next.path, specifier);
        if (!resolved || seen.has(resolved) || !byPath.has(resolved)) continue;
        seen.add(resolved);
        queue.push({ path: resolved, chain: [...next.chain, resolved] });
      }
    }
  }

  const leaking = [...violationsByEntry.keys()].sort();

  // A NEW leak is a failure. An OLD one is a debt this test measures and holds still.
  const added = leaking.filter((entry) => !KNOWN_LEAKS.has(entry));
  assert.deepEqual(
    added,
    [],
    `a "use client" module newly reaches a Node builtin — webpack cannot build it, and the dev server ` +
      `then 500s EVERY request until it is fixed:\n\n${added
        .map((entry) => `${entry}\n${(violationsByEntry.get(entry) ?? []).join("\n")}`)
        .join("\n\n")}\n\nSplit the pure values into a dependency-free module, as ` +
      `src/lib/sales/confidential-products.ts and src/lib/sales/official-lines.ts both do.`,
  );

  // And a FIXED one must be struck off, so the list can only ever shrink.
  const stale = [...KNOWN_LEAKS].filter((entry) => !violationsByEntry.has(entry)).sort();
  assert.deepEqual(
    stale,
    [],
    `these no longer leak — remove them from KNOWN_LEAKS so the ratchet keeps its grip:\n  ${stale.join("\n  ")}`,
  );

  // The specific split this test was written for, pinned so a later tidy-up cannot quietly
  // re-merge the modules and reopen the leak.
  const productFamily = byPath.get("src/lib/direct-orders/product-family.ts");
  assert.ok(productFamily, "src/lib/direct-orders/product-family.ts must exist");
  assert.ok(
    !importSpecifiers(productFamily.text).includes("@/lib/sales/access-scope"),
    "product-family.ts must NOT import @/lib/sales/access-scope — it is reached from a client component; " +
      "take RESTRICTED_PRODUCT_CODES / isHeadOfficeLine from @/lib/sales/confidential-products instead",
  );

  // access-scope must keep re-exporting them, or its existing server callers break.
  const accessScope = byPath.get("src/lib/sales/access-scope.ts");
  assert.ok(accessScope, "src/lib/sales/access-scope.ts must exist");
  for (const name of ["RESTRICTED_PRODUCT_CODES", "isHeadOfficeLine", "normalizeLineKey"]) {
    assert.ok(
      new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(accessScope.text),
      `access-scope.ts must keep re-exporting ${name} for its existing server callers`,
    );
  }

  console.log(
    `  client-bundle server leak: ${clientEntries.length} "use client" entries walked, 0 reach server-only code`,
  );
}
