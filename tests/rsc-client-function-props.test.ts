import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// A server component may never hand a function to a client component.
//
// This exists because it took production down. #2264 converted the CRM boards to
// desktop-table / mobile-cards and moved DoctorCoverageBoard onto the shared
// <PortalResponsiveDataList> primitive. That primitive lives in
// src/components/employee-portal/portal-primitives.tsx, which starts with "use client".
// doctor-coverage-board.tsx does NOT — it is a server component. So its
// getKey / renderCard / renderTable props had to cross the RSC boundary, and React
// refuses to serialise a function:
//
//   ⨯ Error: Functions cannot be passed directly to Client Components unless you
//     explicitly expose it by marking it with "use server".
//     digest: '923360379'
//
// Both /admin/doctor-coverage and /employee-portals/doctor-coverage returned
// "Admin workspace unavailable" for about an hour on 2026-08-21 before anyone loaded
// them signed in. Nothing in the pipeline could have caught it: lint, typecheck and the
// test suite never render a page, and an unauthenticated request 307s to /login long
// before the component runs. The failure is only reachable through a real authenticated
// render, which is exactly the check no automated gate performs.
//
// So the boundary is checked statically instead. This walks the real import graph out of
// every server entry point (app/**/page.tsx, layout.tsx and friends), stopping at each
// "use client" file, and fails if any module it reaches on the server side gives a
// function-literal prop to a component imported from a client module.
//
// Following the graph is the whole point, and a plain "does this file say use client"
// test is NOT good enough. A component with no directive is a *client* component whenever
// its only parents are client components — that is how src/components/ui/switch.tsx gets
// its onChange from payroll-history.tsx perfectly legally. Judging by the directive alone
// flags seven such pairs across payroll and outstation that have shipped and worked for
// months. Only a module a server page can actually reach is at risk.
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

const SCAN_ROOTS = ["src", "app"];

/** Directories that hold no rendered component code. */
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "__snapshots__"]);

type SourceFile = {
  /** Repo-relative, forward-slashed, e.g. "src/components/crm/doctor-coverage-board.tsx". */
  path: string;
  text: string;
};

function collectSourceFiles(): SourceFile[] {
  const files: SourceFile[] = [];

  const walk = (relativeDir: string) => {
    const absoluteDir = `${REPO_ROOT}${relativeDir}`;
    let entries: string[];
    try {
      entries = readdirSync(absoluteDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const relativePath = `${relativeDir}/${entry}`;
      if (statSync(`${REPO_ROOT}${relativePath}`).isDirectory()) {
        walk(relativePath);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      if (/\.test\.tsx?$/.test(entry)) continue;
      files.push({ path: relativePath, text: readFileSync(`${REPO_ROOT}${relativePath}`, "utf8") });
    }
  };

  for (const root of SCAN_ROOTS) walk(root);
  return files;
}

/**
 * A module is a client module when its first real statement is the "use client" directive.
 * Leading comments and blank lines are allowed before it; anything else means the directive
 * would be inert, and Next treats the file as a server module.
 */
function isClientModule(text: string): boolean {
  const withoutBlockComments = text.replace(/^\s*\/\*[\s\S]*?\*\//, "");
  for (const rawLine of withoutBlockComments.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("//")) continue;
    return /^["']use client["'];?$/.test(line);
  }
  return false;
}

/** Component-shaped exports (PascalCase) of a module — the names a JSX tag can use. */
function exportedComponentNames(text: string): Set<string> {
  const names = new Set<string>();
  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Z][A-Za-z0-9_]*)/g,
    /export\s+(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)/g,
    /export\s+default\s+(?:async\s+)?function\s+([A-Z][A-Za-z0-9_]*)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) names.add(match[1]);
  }
  return names;
}

/** Resolve an import specifier to a repo-relative path, or null when it is a package. */
function resolveSpecifier(fromPath: string, specifier: string, known: Map<string, SourceFile>): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = `src/${specifier.slice(2)}`;
  } else if (specifier.startsWith(".")) {
    const segments = fromPath.split("/").slice(0, -1);
    for (const segment of specifier.split("/")) {
      if (segment === ".") continue;
      if (segment === "..") segments.pop();
      else segments.push(segment);
    }
    base = segments.join("/");
  } else {
    return null;
  }

  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

/** Named + default bindings a file imports from each specifier. */
function importedBindings(text: string): { specifier: string; names: string[] }[] {
  const results: { specifier: string; names: string[] }[] = [];
  const importPattern = /import\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g;

  for (const match of text.matchAll(importPattern)) {
    const isTypeOnly = Boolean(match[1]);
    if (isTypeOnly) continue;

    const clause = match[2];
    const specifier = match[3];
    const names: string[] = [];

    const braced = clause.match(/\{([\s\S]*)\}/);
    if (braced) {
      for (const part of braced[1].split(",")) {
        const trimmed = part.trim();
        if (trimmed === "" || trimmed.startsWith("type ")) continue;
        const alias = trimmed.split(/\s+as\s+/);
        names.push((alias[1] ?? alias[0]).trim());
      }
    }

    const defaultBinding = clause.replace(/\{[\s\S]*\}/, "").split(",")[0]?.trim();
    if (defaultBinding && /^[A-Za-z_$][\w$]*$/.test(defaultBinding)) names.push(defaultBinding);

    if (names.length > 0) results.push({ specifier, names });
  }

  return results;
}

/**
 * Text of the JSX opening tag starting at `start` (the "<" of `<Name`), up to the "&gt;" that
 * closes it. Tracked so an arrow function's own "&gt;" and any string content are ignored:
 * only a "&gt;" at brace depth 0 and outside quotes ends a tag.
 */
function readOpeningTag(text: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (char === quote && text[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ">" && depth === 0) return text.slice(start, index + 1);
  }

  return text.slice(start);
}

/**
 * Index of `needle` in `text` at nesting depth 0 and outside quotes, or -1.
 * The depth check happens BEFORE the bracket is counted, so the closing bracket of a
 * group is correctly seen at the depth it closes — without that, `(a) || (b)` reads as
 * one parenthesised expression and gets unwrapped into nonsense.
 */
function indexAtTopLevel(text: string, needle: string): number {
  let depth = 0;
  let quote: string | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (char === quote && text[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (depth === 0 && text.startsWith(needle, index)) return index;
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
  }

  return -1;
}

/** The balanced `{…}` value a prop is given, without its braces, or null if it never closes. */
function readBracedValue(tag: string, openBraceIndex: number): string | null {
  let depth = 0;
  let quote: string | null = null;

  for (let index = openBraceIndex; index < tag.length; index += 1) {
    const char = tag[index];

    if (quote) {
      if (char === quote && tag[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return tag.slice(openBraceIndex + 1, index);
    }
  }

  return null;
}

/**
 * Strip the wrappers that hide a function from a naive `={(a) => …}` match: enclosing
 * parentheses, and a trailing `as T` / `satisfies T`.
 *
 * This is not a hypothetical evasion. It is what a session reaches for the moment the
 * compiler objects to the prop's type, and it defeated the FIRST attempt to reproduce the
 * plan-approvals crash on 2026-08-28: written as `planHref={((planId) => …) as never}` the
 * check stayed green, so the break-it step wrongly read as "the guard does not fire". React
 * serialises none of these any better than the bare literal — a cast changes the type, not
 * the value.
 */
function unwrapValue(expression: string): string {
  let current = expression.trim();

  for (;;) {
    const before = current;

    for (const keyword of [" as ", " satisfies "]) {
      const at = indexAtTopLevel(current, keyword);
      if (at !== -1) current = current.slice(0, at).trim();
    }

    if (current.startsWith("(") && current.endsWith(")")) {
      const inner = current.slice(1, -1);
      // Only when those two really are a matching pair, so `(a) || (b)` survives intact.
      if (indexAtTopLevel(inner, ")") === -1) current = inner.trim();
    }

    if (current === before) return current;
  }
}

/** Does this already-unwrapped expression begin a function literal? */
function isFunctionLiteral(expression: string): boolean {
  const body = expression.replace(/^async\s+/, "").trim();
  if (/^function\b/.test(body)) return true;
  // `id => …` — a single parameter needs no parentheses.
  if (/^[A-Za-z_$][\w$]*\s*=>/.test(body)) return true;
  // `(…) => …`, including `({ a }: { a: () => void }): T => …`, where the parameter list
  // and the return type both contain their own arrows and parens. The old
  // `\([^()]*\)` could not survive a single nested paren.
  if (!body.startsWith("(")) return false;
  return indexAtTopLevel(body, "=>") !== -1;
}

/**
 * Names this module declares as functions.
 *
 * A function REFERENCE crosses the boundary exactly as fatally as a literal —
 * `<ClientThing onSave={handleSave} />` serialises no better than `onSave={() => …}` — and
 * the original check saw only literals, so the most ordinary spelling of the bug was the
 * one it could not see.
 *
 * Deliberately conservative in two ways, because a false positive here turns the required
 * `validate` job red for everyone: only a name THIS file proves to be a function counts (an
 * imported one never does), and a Server Action is excluded, since `"use server"` is the one
 * legal way to hand a function across and it announces itself in the declaration.
 */
function locallyDeclaredFunctions(text: string): Set<string> {
  const names = new Set<string>();
  // A Server Action's directive is the FIRST statement of its body, so look exactly there.
  // A flat "next N characters" window is NOT good enough: it reads forward past the end of
  // this declaration into the next one, so a single Server Action anywhere below would
  // exempt every ordinary function above it. That is a bug this file's own self-checks
  // caught on the first run.
  const isServerAction = (at: number) => {
    const brace = text.indexOf("{", at);
    if (brace === -1) return false;
    return /^\s*["']use server["']/.test(text.slice(brace + 1, brace + 60));
  };

  for (const match of text.matchAll(
    /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  )) {
    if (!isServerAction(match.index)) names.add(match[1]);
  }

  for (const match of text.matchAll(
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*([^\n]*)/g,
  )) {
    if (isFunctionLiteral(unwrapValue(match[2])) && !isServerAction(match.index)) names.add(match[1]);
  }

  return names;
}

/** Props in an opening tag whose value is a function — literal, wrapped, or a local reference. */
function functionValuedProps(openingTag: string, localFunctions: Set<string>): string[] {
  const found: string[] = [];

  for (const match of openingTag.matchAll(/\s([A-Za-z][\w]*)=\{/g)) {
    const raw = readBracedValue(openingTag, match.index + match[0].length - 1);
    if (raw === null) continue;
    // An inline Server Action is legal, and says so in its own body.
    if (/["']use server["']/.test(raw)) continue;

    const value = unwrapValue(raw);
    if (isFunctionLiteral(value) || localFunctions.has(value)) found.push(match[1]);
  }

  return [...new Set(found)];
}

/** Files Next renders on the server unless they opt out — the roots of the server graph. */
const SERVER_ENTRY_FILE = /\/(page|layout|template|default|route)\.tsx?$/;

/**
 * Every module a server entry point can reach without crossing a "use client" boundary.
 * Those, and only those, run as server components.
 */
function serverRenderedModules(files: SourceFile[], byPath: Map<string, SourceFile>): Set<string> {
  const reached = new Set<string>();
  const queue: string[] = [];

  for (const file of files) {
    if (!file.path.startsWith("app/")) continue;
    if (!SERVER_ENTRY_FILE.test(file.path)) continue;
    if (isClientModule(file.text)) continue;
    queue.push(file.path);
    reached.add(file.path);
  }

  while (queue.length > 0) {
    const current = queue.pop() as string;
    const file = byPath.get(current);
    if (!file) continue;

    for (const { specifier } of importedBindings(file.text)) {
      const resolved = resolveSpecifier(current, specifier, byPath);
      if (!resolved || reached.has(resolved)) continue;
      const target = byPath.get(resolved);
      if (!target) continue;
      // A client module is a boundary: it renders on the client, and so does everything
      // below it. Serialising a function INTO it is the bug; what it does inside is fine.
      if (isClientModule(target.text)) continue;
      reached.add(resolved);
      queue.push(resolved);
    }
  }

  return reached;
}

/**
 * The detector's own checks, on synthetic tags rather than on the repo.
 *
 * The repo-wide sweep below is a NEGATIVE assertion — it passes when it finds nothing — so it
 * reports exactly the same green whether the detector works or has quietly stopped matching
 * anything at all. Every shape here is therefore stated twice: what must be caught, and what
 * must NOT be, because a false positive turns the required `validate` job red for everyone.
 */
function assertDetectorRecognisesEvasions() {
  const props = (tag: string, locals: string[] = []) => functionValuedProps(tag, new Set(locals));

  // ── Must be caught: React serialises none of these.
  assert.deepEqual(props("<X href={(id) => go(id)} />"), ["href"], "the plain arrow literal the guard was originally built for");
  assert.deepEqual(
    props("<X href={((id) => go(id)) as never} />"),
    ["href"],
    'a function behind a type assertion must be caught — this is the gap: on 2026-08-28 the plan-approvals crash was "reproduced" as `{((planId) => …) as never}`, the check stayed green, and that read as the guard not firing. A cast changes the type, not the value',
  );
  assert.deepEqual(props("<X href={((id) => go(id))} />"), ["href"], "a redundantly parenthesised arrow is still an arrow");
  assert.deepEqual(props("<X href={((id) => go(id)) satisfies Foo} />"), ["href"], "`satisfies` hides a function exactly as `as` does");
  assert.deepEqual(props("<X f={async () => go()} />"), ["f"], "an async arrow");
  assert.deepEqual(props("<X f={function () { return 1; }} />"), ["f"], "a function expression");
  assert.deepEqual(
    props("<X render={({ a }: { a: () => void }) => a} />"),
    ["render"],
    "a parameter list containing its own parens — the old `\\([^()]*\\)` could not survive one level of nesting",
  );
  assert.deepEqual(
    props("<X onSave={handleSave} />", ["handleSave"]),
    ["onSave"],
    "a function REFERENCE crosses the boundary exactly as fatally as a literal, and is the more ordinary spelling of the bug",
  );

  // ── Must NOT be caught: each of these is legal, and flagging one blocks every merge.
  assert.deepEqual(props("<X title={label} />"), [], "an ordinary value prop");
  assert.deepEqual(props("<X count={items.length} />"), [], "a property access");
  assert.deepEqual(props("<X data={rows.map((r) => r.id)} />"), [], "an arrow passed to `.map` — the PROP is the resulting array, not a function");
  assert.deepEqual(props("<X style={{ color: 'red' }} />"), [], "an object literal");
  assert.deepEqual(props("<X flag={(a) || (b)} />"), [], "two parenthesised operands are not one parenthesised function");
  assert.deepEqual(props("<X action={saveThing} />"), [], "an IMPORTED name is never assumed to be a function — only what this file proves");
  assert.deepEqual(
    props('<X action={async () => { "use server"; await save(); }} />'),
    [],
    'an inline Server Action is the one legal way to hand a function across, and it announces itself',
  );

  // ── The reference check depends on reading declarations correctly.
  const declared = locallyDeclaredFunctions(
    [
      "function handleSave() {}",
      "const renderRow = (row) => row.id;",
      "const makeThing = function () {};",
      "const label = 'Total';",
      "const total = items.reduce((sum, n) => sum + n, 0);",
      'async function saveIt() { "use server"; }',
    ].join("\n"),
  );
  assert.ok(declared.has("handleSave"), "a function declaration is a function");
  assert.ok(declared.has("renderRow"), "a const arrow is a function");
  assert.ok(declared.has("makeThing"), "a const function expression is a function");
  assert.ok(!declared.has("label"), "a string constant is not a function");
  assert.ok(!declared.has("total"), "a reduce RESULT is a number, even though an arrow appears on the line");
  assert.ok(!declared.has("saveIt"), "a Server Action is excluded — passing one is legal");
}

export function runRscClientFunctionPropTests() {
  assertDetectorRecognisesEvasions();

  const files = collectSourceFiles();
  assert.ok(files.length > 500, `expected the src/app scan to find plenty of files, found ${files.length}`);

  const byPath = new Map(files.map((file) => [file.path, file]));

  const clientExports = new Map<string, Set<string>>();
  for (const file of files) {
    if (isClientModule(file.text)) clientExports.set(file.path, exportedComponentNames(file.text));
  }

  const serverRendered = serverRenderedModules(files, byPath);

  // Self-checks. Without these the whole test passes vacuously the moment import
  // resolution or the directive check breaks, which is exactly how a guard rots.
  assert.ok(
    serverRendered.size > 100,
    `expected the server graph to reach plenty of modules, reached ${serverRendered.size} — import resolution is probably broken`,
  );
  // The anchor was src/components/crm/doctor-coverage-board.tsx — the file whose RSC violation took
  // /admin/doctor-coverage down on 2026-08-21 — until the owner retired that board on 2026-08-28
  // and its pages became redirect stubs. The board file still exists but nothing server-rendered
  // imports it, so it can no longer prove the graph walker works. Moved to its surviving twin,
  // exactly as the old message instructed: brick-coverage-board.tsx is a server component built
  // from the same tables and still reached by /admin/brick-coverage.
  assert.ok(
    serverRendered.has("src/components/crm/brick-coverage-board.tsx"),
    'the server graph must still reach src/components/crm/brick-coverage-board.tsx — this test only means something while a real CRM board is reachable. If that board is deliberately made a client component, move this anchor to another server component rather than deleting it.',
  );
  assert.ok(
    !serverRendered.has("src/components/payroll/dashboard/payroll-history.tsx"),
    "payroll-history.tsx is reached only through client parents — if the graph now calls it server-rendered, the boundary check has stopped stopping at \"use client\" and this test will report false positives",
  );

  assert.ok(
    clientExports.size > 50,
    `expected many "use client" modules, found ${clientExports.size} — the directive check is probably broken`,
  );
  assert.ok(
    clientExports.get("src/components/employee-portal/portal-primitives.tsx")?.has("PortalResponsiveDataList"),
    'portal-primitives.tsx must still register as a client module exporting PortalResponsiveDataList — this test is worthless if it stops seeing it',
  );

  const violations: string[] = [];

  for (const file of files) {
    if (!serverRendered.has(file.path)) continue;

    // Component name → the client module it came from.
    const clientComponents = new Map<string, string>();
    for (const { specifier, names } of importedBindings(file.text)) {
      const resolved = resolveSpecifier(file.path, specifier, byPath);
      if (!resolved) continue;
      const exports = clientExports.get(resolved);
      if (!exports) continue;
      for (const name of names) {
        if (exports.has(name)) clientComponents.set(name, resolved);
      }
    }

    const localFunctions = locallyDeclaredFunctions(file.text);

    for (const [component, source] of clientComponents) {
      const tagPattern = new RegExp(`<${component}(?=[\\s/>])`, "g");
      for (const match of file.text.matchAll(tagPattern)) {
        const openingTag = readOpeningTag(file.text, match.index);
        const functionProps = functionValuedProps(openingTag, localFunctions);
        if (functionProps.length === 0) continue;

        const line = file.text.slice(0, match.index).split("\n").length;
        violations.push(
          `${file.path}:${line} — server component passes ${functionProps
            .map((prop) => `\`${prop}\``)
            .join(", ")} to <${component}>, a client component from ${source}`,
        );
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    [
      "A server component is passing a function to a client component. React cannot serialise it,",
      'so the page 500s at render time with "Functions cannot be passed directly to Client Components".',
      'Fix it by adding "use client" to the server file, or by inlining what the client primitive does',
      "(see src/components/crm/doctor-coverage-board.tsx for the second option).",
      "",
      ...violations,
    ].join("\n"),
  );
}
