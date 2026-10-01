import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// THE PORTAL PREFETCHES A PAGE'S DATA ON INTENT, NEVER FOR EVERY LINK ON SCREEN (owner, 2026-10-01:
// "the system is slow to transfer between page and page … make the medical rep role very fast").
//
// WHY THIS FILE EXISTS. The sidebar rows and the rail icons carried `<Link prefetch>` — a FULL
// prefetch, which for a dynamic page is the whole page rendered on the server: auth, loaders, RPCs.
// Opening any portal page therefore rendered ~15 others at the same moment on the one replica. One
// production load, 2026-10-01 00:57 Cairo: business-review 7.5 s, weekly-stock 6.4 s,
// /employee-portals 5.2 s, employee-360 4.8 s, weekly-sales 4.5 s — none of them clicked, and a tap
// queued behind the burst.
//
// WHAT IT PINS.
//   1. No <Link> in the portal chrome (src/components/employee-portal/**) asks for a full prefetch:
//      a bare `prefetch` or `prefetch={true}`. The default prefetches down to the page's loading.tsx,
//      which is what makes the skeleton appear on the tap.
//   2. The rows that replace it — the sidebar row, the rail's pop-out row, the bottom-nav tab and the
//      quick action — keep `unstable_dynamicOnHover`, which fetches the full page on touchstart /
//      mouseenter, the 100–400 ms before the click lands.
//   3. That prop is backed by `experimental.dynamicOnHover: true` in next.config.ts. WITHOUT THE FLAG
//      THE PROP DOES NOTHING AT ALL — Next compiles `__NEXT_DYNAMIC_ON_HOVER` in from that key, so the
//      rows would silently lose their head start and nothing anywhere would say so.
//   4. The client router cache stays on and bounded: a visited page is reused for a short while
//      (`staleTimes.dynamic` > 0), and a previous visit answers a hover prefetch for at most a minute
//      (`staleTimes.static` 30–60; 30 is Next's own schema floor).
//
// WHEN IT FIRES. Do not put `prefetch` back to make one page feel instant: it is instant for the
// person who waits, and it is the burst that makes every other tap slow. Give that page a faster
// loader instead.

const repoRoot = process.cwd();
const PORTAL_DIR = "src/components/employee-portal";
const CONFIG = "next.config.ts";

/** Every .tsx file under the portal's component folder. */
function portalFiles(dir = PORTAL_DIR): string[] {
  return readdirSync(join(repoRoot, dir)).flatMap((entry) => {
    const rel = `${dir}/${entry}`;
    if (statSync(join(repoRoot, rel)).isDirectory()) return portalFiles(rel);
    return rel.endsWith(".tsx") ? [rel] : [];
  });
}

type LinkUse = { file: string; line: number; fullPrefetch: boolean; dynamicOnHover: boolean };

/** Every <Link …> opening tag in a file, read from the syntax tree so a comment can never count. */
function linkUses(rel: string): LinkUse[] {
  const text = readFileSync(join(repoRoot, rel), "utf8");
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
        if (name === "unstable_dynamicOnHover" && isTrue) dynamicOnHover = true;
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
  // ── 1 and 2. the portal's links ───────────────────────────────────────────────────────────────
  const files = portalFiles();
  const uses = files.flatMap(linkUses);
  // Positive control: a scan that stopped reading the folder would otherwise pass with nothing found.
  assert.ok(files.length >= 20, `only ${files.length} .tsx files were read under ${PORTAL_DIR}; the scan is not seeing the folder`);
  assert.ok(uses.length >= 10, `only ${uses.length} <Link> tags were read under ${PORTAL_DIR}; the scan is not seeing them`);

  const full = uses.filter((use) => use.fullPrefetch).map((use) => `${use.file}:${use.line}`);
  assert.deepEqual(
    full,
    [],
    "a portal <Link> asks for a FULL prefetch (`prefetch` / `prefetch={true}`): that renders the whole linked page " +
      "on the server as soon as the link is on screen, and the sidebar draws ~15 of them at once. Leave `prefetch` " +
      "at its default and add `unstable_dynamicOnHover` instead.",
  );

  const onHover = (file: string) => uses.filter((use) => use.file === file && use.dynamicOnHover).length;
  const layout = `${PORTAL_DIR}/employee-portal-layout.tsx`;
  assert.ok(
    onHover(layout) >= 2,
    `${layout}: the sidebar row and the rail's pop-out row must keep \`unstable_dynamicOnHover\` — without it a tap waits ` +
      "for the whole page after the click instead of starting it at the touch",
  );
  assert.ok(onHover(`${PORTAL_DIR}/employee-portal-bottom-nav.tsx`) >= 1, "the bottom-nav tab must keep `unstable_dynamicOnHover`");
  assert.ok(onHover(`${PORTAL_DIR}/portal-bottom-nav-widgets.tsx`) >= 1, "the quick-action rows must keep `unstable_dynamicOnHover`");

  // ── 3 and 4. the config behind them ───────────────────────────────────────────────────────────
  const text = readFileSync(join(repoRoot, CONFIG), "utf8");
  const source = ts.createSourceFile(CONFIG, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const experimental = objectProperty(source, "experimental", source);
  assert.ok(experimental, `${CONFIG}: expected a literal \`experimental: { … }\` block`);

  const flag = literalMember(experimental, "dynamicOnHover", source);
  assert.ok(
    flag !== undefined && flag.kind === ts.SyntaxKind.TrueKeyword,
    `${CONFIG}: \`experimental.dynamicOnHover\` must be \`true\`. Every \`unstable_dynamicOnHover\` <Link> is a no-op ` +
      "without it — Next compiles __NEXT_DYNAMIC_ON_HOVER in from this key — so the portal would lose its touch-time " +
      "prefetch silently.",
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
    `${CONFIG}: staleTimes.static is ${staticSeconds}. It is how old a previous visit may be and still answer a hover ` +
      "prefetch: 30 is Next's schema floor, and above 60 brings back the minutes-stale pages the full prefetch served.",
  );
}
