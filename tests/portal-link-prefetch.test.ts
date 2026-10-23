import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// A LINK NEVER BUILDS A WHOLE PAGE NOBODY TAPPED — NOT WHILE IT IS ON SCREEN, NOT ON HOVER, NOT ON
// TOUCH (owner, 2026-10-01: "the system is slow to transfer between page and page … make the medical
// rep role very fast"; 2026-10-23: "the process of shifting from page to page never take more than 1
// second").
//
// WHY THIS FILE EXISTS. Twice a prefetch built pages nobody had chosen, on the one replica, and the
// page that WAS tapped queued behind them.
//   • 2026-10-01: the sidebar rows and rail icons carried `<Link prefetch>` — a FULL prefetch, the
//     whole page rendered on the server. Opening any portal page rendered ~15 others at once; one
//     load measured business-review 7.5 s, weekly-stock 6.4 s, /employee-portals 5.2 s.
//   • 2026-10-23: its replacement, `unstable_dynamicOnHover`, upgraded a link to that same full
//     page on mouseenter / touchstart. A mouse crossing the menu, or a finger scrolling it, touched
//     row after row: production logs, 14:18–14:52 Cairo, show 8 full builds — 46 s of server work —
//     in front of one rep's tap on Visits.
//
// WHAT IT PINS.
//   1. No <Link> in the portal chrome (src/components/employee-portal/**) asks for a full prefetch:
//      a bare `prefetch` or `prefetch={true}`. The default prefetches down to the page's loading.tsx,
//      which is what makes the skeleton appear on the tap.
//   2. No <Link> anywhere in src/ or app/ carries `unstable_dynamicOnHover`, and next.config.ts does
//      not turn `experimental.dynamicOnHover` on — the prop does nothing without the flag, and the
//      flag does nothing without the prop, so each half is refused on its own.
//   3. The type shim that declared the prop is gone, so putting the prop back fails the typecheck too.
//   4. The client router cache stays on and bounded: a visited page is reused for a short while
//      (`staleTimes.dynamic` > 0), and a prefetched entry answers a tap for at most a minute
//      (`staleTimes.static` 30–60; 30 is Next's own schema floor).
//
// WHEN IT FIRES. Do not bring back a full or hover prefetch to make one page feel instant: it is
// instant for the person who waits, and it is the burst that makes every other tap slow. Give that
// page a faster loader instead.

const repoRoot = process.cwd();
const PORTAL_DIR = "src/components/employee-portal";
const CONFIG = "next.config.ts";
const HOVER_PROP = "unstable_dynamicOnHover";
const RETIRED_SHIM = "src/types/next-link-dynamic-on-hover.d.ts";

/** Every .tsx file under a folder. */
function tsxFiles(dir: string): string[] {
  return readdirSync(join(repoRoot, dir)).flatMap((entry) => {
    const rel = `${dir}/${entry}`;
    if (statSync(join(repoRoot, rel)).isDirectory()) return tsxFiles(rel);
    return rel.endsWith(".tsx") ? [rel] : [];
  });
}

type LinkUse = { file: string; line: number; fullPrefetch: boolean; dynamicOnHover: boolean };

/** Every <Link …> opening tag in a file, read from the syntax tree so a comment can never count. */
function linkUses(rel: string, text = readFileSync(join(repoRoot, rel), "utf8")): LinkUse[] {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const uses: LinkUse[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === "Link") {
      let fullPrefetch = false;
      let dynamicOnHover = false;
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue;
        const name = attribute.name.getText(source);
        const init = attribute.initializer;
        const isTrue =
          init === undefined ||
          (ts.isJsxExpression(init) && init.expression !== undefined && init.expression.kind === ts.SyntaxKind.TrueKeyword);
        if (name === "prefetch" && isTrue) fullPrefetch = true;
        // Any value at all: `={false}` today is one edit from `={true}`, and the prop has no use here.
        if (name === HOVER_PROP) dynamicOnHover = true;
      }
      uses.push({
        file: rel,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        fullPrefetch,
        dynamicOnHover,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

/** The object literal assigned to `name` anywhere in the config, e.g. `experimental: { … }`. */
function objectProperty(root: ts.Node, name: string, source: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === name &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** A property of a literal object, by name, as its initializer node. */
function literalMember(object: ts.ObjectLiteralExpression, name: string, source: ts.SourceFile): ts.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && property.name.getText(source) === name) return property.initializer;
  }
  return undefined;
}

function numericMember(object: ts.ObjectLiteralExpression, name: string, source: ts.SourceFile): number {
  const value = literalMember(object, name, source);
  assert.ok(value && ts.isNumericLiteral(value), `${CONFIG}: staleTimes.${name} must be a plain number literal`);
  return Number(value.text);
}

export function runPortalLinkPrefetchTests() {
  // ── 1. the portal's links never full-prefetch ────────────────────────────────────────────────
  const portal = tsxFiles(PORTAL_DIR);
  const portalUses = portal.flatMap((file) => linkUses(file));
  // Positive control: a scan that stopped reading the folder would otherwise pass with nothing found.
  assert.ok(portal.length >= 20, `only ${portal.length} .tsx files were read under ${PORTAL_DIR}; the scan is not seeing the folder`);
  assert.ok(portalUses.length >= 10, `only ${portalUses.length} <Link> tags were read under ${PORTAL_DIR}; the scan is not seeing them`);

  const full = portalUses.filter((use) => use.fullPrefetch).map((use) => `${use.file}:${use.line}`);
  assert.deepEqual(
    full,
    [],
    "a portal <Link> asks for a FULL prefetch (`prefetch` / `prefetch={true}`): that renders the whole linked page " +
      "on the server as soon as the link is on screen, and the sidebar draws ~15 of them at once. Leave `prefetch` " +
      "at its default.",
  );

  // ── 2. no link anywhere upgrades on hover or touch ───────────────────────────────────────────
  const everywhere = [...tsxFiles("src"), ...tsxFiles("app")];
  assert.ok(everywhere.length >= 500, `only ${everywhere.length} .tsx files were read under src/ and app/; the scan is not seeing them`);
  // Only a file that names the prop can carry it, so only those are parsed; the tree then decides,
  // so the comments that explain why it is gone never count.
  const hover = everywhere
    .flatMap((file) => {
      const text = readFileSync(join(repoRoot, file), "utf8");
      return text.includes(HOVER_PROP) ? linkUses(file, text) : [];
    })
    .filter((use) => use.dynamicOnHover)
    .map((use) => `${use.file}:${use.line}`);
  assert.deepEqual(
    hover,
    [],
    `a <Link> carries \`${HOVER_PROP}\`: it builds the whole linked page on the server the moment a mouse or a ` +
      "finger crosses it, and the page actually tapped queues behind every one it crossed (8 builds, 46 s of server " +
      "work, in front of one rep's tap on 2026-10-23). Leave it out and give the slow page a faster loader.",
  );
  // Self-check: the detector really does see the prop on a Link, in both spellings it can take.
  assert.equal(linkUses("probe.tsx", `const a = <Link href="/x" ${HOVER_PROP}>x</Link>;`)[0]?.dynamicOnHover, true);
  assert.equal(linkUses("probe.tsx", `const a = <Link href="/x" ${HOVER_PROP}={false} />;`)[0]?.dynamicOnHover, true);
  assert.equal(linkUses("probe.tsx", `// ${HOVER_PROP}\nconst a = <Link href="/x" />;`)[0]?.dynamicOnHover, false);

  // ── 3. the type shim that declared the prop stays gone ───────────────────────────────────────
  assert.ok(
    !existsSync(join(repoRoot, RETIRED_SHIM)),
    `${RETIRED_SHIM} is back: it declared \`${HOVER_PROP}\` on next/link's type, which is the one thing that let ` +
      "the prop compile. Without it, putting the prop back fails the typecheck as well as this test.",
  );

  // ── 4. the config ────────────────────────────────────────────────────────────────────────────
  const text = readFileSync(join(repoRoot, CONFIG), "utf8");
  const source = ts.createSourceFile(CONFIG, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const experimental = objectProperty(source, "experimental", source);
  assert.ok(experimental, `${CONFIG}: expected a literal \`experimental: { … }\` block`);

  const flag = literalMember(experimental, "dynamicOnHover", source);
  assert.ok(
    flag === undefined || flag.kind === ts.SyntaxKind.FalseKeyword,
    `${CONFIG}: \`experimental.dynamicOnHover\` is set. It is what makes a \`${HOVER_PROP}\` <Link> build the full ` +
      "page on hover or touch; leave the key out (Next's default is off).",
  );

  const staleTimes = literalMember(experimental, "staleTimes", source);
  assert.ok(staleTimes && ts.isObjectLiteralExpression(staleTimes), `${CONFIG}: expected a literal \`experimental.staleTimes\``);
  const dynamic = numericMember(staleTimes, "dynamic", source);
  const staticSeconds = numericMember(staleTimes, "static", source);
  assert.ok(
    dynamic > 0 && dynamic <= 60,
    `${CONFIG}: staleTimes.dynamic is ${dynamic}. Above 0 is what makes going back to a page he just left instant; ` +
      "above 60 starts showing him a page older than a minute.",
  );
  assert.ok(
    staticSeconds >= 30 && staticSeconds <= 60,
    `${CONFIG}: staleTimes.static is ${staticSeconds}. It is how old a prefetched entry may be and still answer a ` +
      "tap: 30 is Next's schema floor, and above 60 brings back the minutes-stale pages the full prefetch served.",
  );
}
