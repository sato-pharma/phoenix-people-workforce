import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

// THE SALES ANALYTICS MODULE IS RETIRED (owner, 2026-09-17: "drop and retire the sales analytics module").
//
// Its weekly dashboards added stock across weeks, and he chose to retire the module rather than fix
// it. Every page under /admin/analytics and /employee-portals/sales-analytics was deleted, except
// ONE: /admin/analytics/monthly-closing/details, the Finance Manager's closing export, which was
// never part of the module's dashboards. For an old address (a bookmark, a link already sent), he
// chose "the nearest page that stays": the weekly dashboards land on Weekly Sales, everything else
// on Monthly Closing, each in its own shell. next.config.ts declares those redirects.
//
// This file pins four things:
//   1. THE PAGES ARE GONE — no route file sits under either tree except the one export page.
//   2. EVERY OLD ADDRESS LANDS RIGHT — next.config.ts's redirects are run through Next's OWN matcher,
//      first match wins, exactly as the server does. Each of the 29 addresses lands on the chosen page
//      with a permanent redirect, every destination is a real page, and the export page is caught by
//      nothing (a `:path*` source also matches its bare folder, which is how a careless widening would
//      swallow it).
//   3. NOTHING LINKS BACK IN — no string literal in src/ or app/ points into either tree, apart from
//      the export page. A link to a redirect is a slow link, and one to a page later retired is a 404.
//   4. THE CEO AND SFE MANAGER SHORTCUTS — they opened Monthly Closing Analytics, and the owner chose
//      the Monthly Closing page as their new target.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const MONTHLY_CLOSING = "/sales/monthly-closing";
const WEEKLY_SALES = "/sales/weekly/dashboard";
const PORTAL_MONTHLY_CLOSING = "/employee-portals/monthly-closing";
const PORTAL_WEEKLY_SALES = "/employee-portals/weekly-sales";

/** The one page the retirement left in the admin tree: the Finance Manager's closing export. */
const EXPORT_PAGE = "/admin/analytics/monthly-closing/details";
const RETIRED_TREES = ["/admin/analytics", "/employee-portals/sales-analytics"];

/** Every page the module served on 2026-09-17, and where the owner's rule sends it. */
const RETIRED_ADDRESSES: Record<string, string> = {
  "/admin/analytics": MONTHLY_CLOSING,
  "/admin/analytics/executive-comparison": MONTHLY_CLOSING,
  "/admin/analytics/monthly-closing": MONTHLY_CLOSING,
  "/admin/analytics/monthly-closing/by-employee": MONTHLY_CLOSING,
  "/admin/analytics/monthly-closing/by-line": MONTHLY_CLOSING,
  "/admin/analytics/reconciliation": MONTHLY_CLOSING,
  "/admin/analytics/source-sales": MONTHLY_CLOSING,
  "/admin/analytics/source-sales/by-area": MONTHLY_CLOSING,
  "/admin/analytics/source-sales/by-customer": MONTHLY_CLOSING,
  "/admin/analytics/source-sales/by-line": MONTHLY_CLOSING,
  "/admin/analytics/source-sales/by-product": MONTHLY_CLOSING,
  "/admin/analytics/weekly-sales": WEEKLY_SALES,
  "/admin/analytics/weekly-sales/by-distributor": WEEKLY_SALES,
  "/admin/analytics/weekly-sales/detail": WEEKLY_SALES,
  "/employee-portals/sales-analytics": PORTAL_MONTHLY_CLOSING,
  "/employee-portals/sales-analytics/executive-comparison": PORTAL_MONTHLY_CLOSING,
  "/employee-portals/sales-analytics/monthly-closing": PORTAL_MONTHLY_CLOSING,
  "/employee-portals/sales-analytics/monthly-closing/by-employee": PORTAL_MONTHLY_CLOSING,
  "/employee-portals/sales-analytics/monthly-closing/by-line": PORTAL_MONTHLY_CLOSING,
  "/employee-portals/sales-analytics/monthly-closing/details": PORTAL_MONTHLY_CLOSING,
  "/employee-portals/sales-analytics/reconciliation": PORTAL_MONTHLY_CLOSING,
  "/employee-portals/sales-analytics/source-sales": PORTAL_MONTHLY_CLOSING,
  "/employee-portals/sales-analytics/source-sales/by-area": PORTAL_MONTHLY_CLOSING,
  "/employee-portals/sales-analytics/source-sales/by-customer": PORTAL_MONTHLY_CLOSING,
  "/employee-portals/sales-analytics/source-sales/by-line": PORTAL_MONTHLY_CLOSING,
  "/employee-portals/sales-analytics/source-sales/by-product": PORTAL_MONTHLY_CLOSING,
  "/employee-portals/sales-analytics/weekly-sales": PORTAL_WEEKLY_SALES,
  "/employee-portals/sales-analytics/weekly-sales/by-distributor": PORTAL_WEEKLY_SALES,
  "/employee-portals/sales-analytics/weekly-sales/detail": PORTAL_WEEKLY_SALES,
};

/** Addresses that must reach their own page, never a redirect. */
const MUST_NOT_REDIRECT = [
  EXPORT_PAGE,
  `${EXPORT_PAGE}/`,
  "/Admin/Analytics/Monthly-Closing/Details",
  MONTHLY_CLOSING,
  WEEKLY_SALES,
  PORTAL_MONTHLY_CLOSING,
  PORTAL_WEEKLY_SALES,
  "/admin/analytics-overview",
  "/employee-portals/sales-analytics-archive",
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** The URL folder an app/ file serves: route groups `(x)` and parallel slots `@x` add no segment. */
function urlFolderOf(appFile: string): string {
  const segments = relative(join(repoRoot, "app"), appFile).split(/[\\/]/).slice(0, -1);
  const kept = segments.filter((segment) => !/^\(.*\)$/.test(segment) && !segment.startsWith("@"));
  return `/${kept.join("/")}`;
}

function insideRetiredTree(address: string): boolean {
  const path = address.split(/[?#]/)[0].replace(/\/+$/, "");
  if (path.toLowerCase() === EXPORT_PAGE) return false;
  return RETIRED_TREES.some((tree) => path.toLowerCase() === tree || path.toLowerCase().startsWith(`${tree}/`));
}

type Redirect = { source: string; destination: string; permanent: boolean | null; order: number };

/**
 * next.config.ts's redirects, read from the source file's syntax tree. Every entry must be a plain
 * literal object, or this simulation would not be looking at what the server runs.
 */
function declaredRedirects(): Redirect[] {
  const text = readFileSync(join(repoRoot, "next.config.ts"), "utf8");
  const file = ts.createSourceFile("next.config.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const returnedArray = (node: ts.Node): ts.ArrayLiteralExpression | undefined =>
    ts.isReturnStatement(node) && node.expression && ts.isArrayLiteralExpression(node.expression)
      ? node.expression
      : node.forEachChild(returnedArray);
  const redirectsList = (node: ts.Node): ts.ArrayLiteralExpression | undefined =>
    (ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) && node.name.getText(file) === "redirects"
      ? returnedArray(node)
      : node.forEachChild(redirectsList);
  const list = redirectsList(file);
  assert.ok(list, "expected next.config.ts to return a literal array from redirects()");
  return list.elements.map((element, order) => {
    assert.ok(ts.isObjectLiteralExpression(element), `redirects() entry ${order + 1} must be a literal object`);
    const entry: ts.ObjectLiteralExpression = element;
    const read = (name: string) =>
      entry.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && property.name.getText(file) === name)
        ?.initializer;
    const source = read("source");
    const destination = read("destination");
    const permanent = read("permanent");
    assert.ok(source && ts.isStringLiteral(source), `redirects() entry ${order + 1} must have a literal source`);
    assert.ok(destination && ts.isStringLiteral(destination), `redirects() entry ${order + 1} must have a literal destination`);
    return {
      source: source.text,
      destination: destination.text,
      permanent:
        permanent?.kind === ts.SyntaxKind.TrueKeyword ? true : permanent?.kind === ts.SyntaxKind.FalseKeyword ? false : null,
      order,
    };
  });
}

type PathMatcher = (pathname: string) => false | object;

/** Next's own redirect matcher, built with the options its router uses for a `redirects()` entry. */
function nextRedirectMatcher(source: string): PathMatcher {
  const require = createRequire(import.meta.url);
  const { getPathMatch } = require("next/dist/shared/lib/router/utils/path-match.js") as {
    getPathMatch: (path: string, options: Record<string, unknown>) => PathMatcher;
  };
  const { modifyRouteRegex } = require("next/dist/lib/redirect-status.js") as {
    modifyRouteRegex: (regex: string, restrictedPaths?: string[]) => string;
  };
  return getPathMatch(source, {
    strict: true,
    removeUnnamedParams: true,
    sensitive: false,
    regexModifier: (regex: string) => modifyRouteRegex(regex, ["/_next"]),
  });
}

/** Every string a file spells in code — literals and template heads — never its comments. */
function codeStrings(file: ts.SourceFile): { text: string; line: number }[] {
  const found: { text: string; line: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)) {
      found.push({ text: node.text, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 });
    }
    node.forEachChild(visit);
  };
  visit(file);
  return found;
}

function parse(relativePath: string): ts.SourceFile {
  const text = readFileSync(join(repoRoot, relativePath), "utf8");
  return ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true, relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

export function runSalesAnalyticsRetiredTests() {
  const appFiles = walk(join(repoRoot, "app"));
  const pageFolders = new Set(appFiles.filter((file) => /[\\/]page\.(tsx|ts|jsx|js)$/.test(file)).map(urlFolderOf));

  // ── 1. The pages are gone ─────────────────────────────────────────────────
  const leftBehind = appFiles
    .filter((file) => {
      const folder = urlFolderOf(file);
      return folder !== EXPORT_PAGE && insideRetiredTree(folder);
    })
    .map((file) => relative(repoRoot, file));
  assert.deepEqual(
    leftBehind,
    [],
    "a file serves a page inside the retired Sales Analytics module again. The owner retired it on 2026-09-17; " +
      "only the Finance Manager's export page may stay under /admin/analytics",
  );
  assert.ok(pageFolders.has(EXPORT_PAGE), "the Finance Manager's closing export page must survive the retirement");

  // ── 2. Every old address lands on the page the owner chose ────────────────
  const redirects = declaredRedirects().map((entry) => ({ ...entry, matches: nextRedirectMatcher(entry.source) }));
  const firstMatch = (address: string) => redirects.find((entry) => entry.matches(address) !== false) ?? null;

  const landings = Object.keys(RETIRED_ADDRESSES).map((address) => {
    const hit = firstMatch(address);
    return { address, lands: hit ? hit.destination : "(no redirect: a 404)", permanent: hit?.permanent ?? null };
  });
  assert.deepEqual(
    landings.map(({ address, lands }) => `${address} -> ${lands}`),
    Object.entries(RETIRED_ADDRESSES).map(([address, destination]) => `${address} -> ${destination}`),
    "an old Sales Analytics address must land on the nearest page that stays (owner, 2026-09-17): " +
      "the weekly dashboards on Weekly Sales, everything else on Monthly Closing, in the same shell",
  );
  assert.deepEqual(
    landings.filter((landing) => landing.permanent !== true).map((landing) => landing.address),
    [],
    "a retired address must redirect permanently — the pages are deleted, not moved for a while",
  );
  for (const destination of new Set(Object.values(RETIRED_ADDRESSES))) {
    assert.ok(pageFolders.has(destination), `the redirect destination ${destination} must be a real page, or the redirect only moves the 404`);
  }
  assert.deepEqual(
    MUST_NOT_REDIRECT.map((address) => ({ address, caughtBy: firstMatch(address)?.source ?? null })).filter((row) => row.caughtBy !== null),
    [],
    "a redirect catches a page that stays — above all the Finance Manager's export at /admin/analytics/monthly-closing/details, " +
      "which a `:path*` source over /admin/analytics or its monthly-closing folder would swallow",
  );

  // ── 3. Nothing in the app links back into the retired module ──────────────
  const linksIn: string[] = [];
  for (const file of [...walk(join(repoRoot, "src")), ...appFiles]) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    if (!RETIRED_TREES.some((tree) => text.includes(tree))) continue;
    const relativePath = relative(repoRoot, file).split("\\").join("/");
    for (const { text: value, line } of codeStrings(parse(relativePath))) {
      if (value.startsWith("/") && insideRetiredTree(value)) linksIn.push(`${relativePath}:${line} ${value}`);
    }
  }
  assert.deepEqual(
    linksIn,
    [],
    "code still points into the retired Sales Analytics module. Link the page the owner chose instead " +
      "(Monthly Closing or Weekly Sales); only the Finance Manager's export page may be named",
  );

  // ── 4. The CEO and SFE Manager shortcuts open Monthly Closing ─────────────
  const phaseB = parse("src/components/admin/ceo-phase-b.tsx");
  const sourceOfSalesRows: string[] = [];
  phaseB.forEachChild(function visit(node): void {
    if (ts.isObjectLiteralExpression(node)) {
      const value = (name: string) => {
        const property = node.properties.find(
          (candidate): candidate is ts.PropertyAssignment => ts.isPropertyAssignment(candidate) && candidate.name.getText(phaseB) === name,
        );
        return property && ts.isStringLiteral(property.initializer) ? property.initializer.text : null;
      };
      if (value("label") === "Source of Sales") sourceOfSalesRows.push(value("href") ?? "(no href)");
    }
    node.forEachChild(visit);
  });
  assert.deepEqual(
    sourceOfSalesRows,
    [MONTHLY_CLOSING, MONTHLY_CLOSING],
    "the CEO's and the SFE Manager's Source of Sales shortcuts must open the Monthly Closing page, the owner's choice " +
      "when Monthly Closing Analytics was retired (2026-09-17)",
  );
  for (const relativePath of ["src/components/admin/ceo-phase-b.tsx", "src/components/admin/ceo-sos-tables.tsx"]) {
    const file = parse(relativePath);
    const fullSosLinks: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === "Link" && node.getText(file).includes("Full SoS")) {
        const href = node.openingElement.attributes.properties.find(
          (attribute): attribute is ts.JsxAttribute => ts.isJsxAttribute(attribute) && attribute.name.getText(file) === "href",
        );
        fullSosLinks.push(href?.initializer && ts.isStringLiteral(href.initializer) ? href.initializer.text : "(not a literal)");
      }
      node.forEachChild(visit);
    };
    visit(file);
    assert.deepEqual(
      fullSosLinks,
      [MONTHLY_CLOSING],
      `the CEO dashboard's "Full SoS" link in ${relativePath} must open the Monthly Closing page (owner, 2026-09-17)`,
    );
  }
}
