import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * At 1024px the sales page header squeezed its own headline into a column narrower than the title.
 *
 * Measured 2026-09-16 on the real pages (headless Chromium, dev-auth request headers, classic
 * scrollbars, display scale 100%), 1024x900:
 *
 *   /employee-portals/targets as a National Sales Manager
 *     main = 621px                  <- the portal sidebar takes the rest of the 1024
 *     headline column = 100px       <- a 150px ring + the "Measured" aside (~405px, shrink-0) took the row
 *     h1 "Targets" 113 > 100, stats row 170 > 100, 2,261px² of stat text painted UNDER the ring
 *   /employee-portals/sales-vs-target, same viewer
 *     headline column = 132px, stats row 170 > 132, 555px² of stat text under the ring
 *
 * The cause was the breakpoint. Both headers put the ring and aside BESIDE the headline from `lg`
 * (1024px), but next to the portal sidebar that leaves the headline a usable column only from 1280px
 * (356px there). Fixed by moving the side-by-side row to `xl`: below 1280px the ring and aside sit
 * under the headline — the layout the band already had below 1024px — and nothing at 1280px and
 * above changes. The display scale does not rescue it: 100% is one of the five steps a reader can
 * pick, and the breakpoints follow the viewport, not the zoom.
 *
 * Pinned by SHAPE, on comment-stripped source, as tests/section-card-header-fits-a-phone.test.ts
 * does, so the prose above cannot satisfy the assertions. tests/rep-targets.test.ts already pins
 * the rep's own Targets view; this file pins the rest:
 *
 *   1. CommandBand's besideFrom="xl" really moves all three row classes to `xl:`, and the default
 *      stays `lg`, so the bands that pass no prop (Make It Happen, pharmacy actions) are untouched.
 *   2. Every <CommandBand> handed BOTH a ring and an aside passes besideFrom="xl".
 *   3. The Sales vs Target header, drawn inline, goes side by side from `xl`, never `lg`.
 */

const COMMAND_BAND = "src/components/sales/target-visuals.tsx";
const TARGETS_WORKSPACE = "src/components/sales/targets-workspace.tsx";
const VS_TARGET = "src/components/sales/vs-target/vs-target-dashboard.tsx";
const SOURCE_ROOTS = ["src", "app"];

/** Drop block comments and whole-line `//` comments. Deliberately not brace-aware: see the note in
 * tests/portal-chrome-never-clips-text.test.ts about a brace-aware variant eating a component. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function tokens(className: string): string[] {
  return className.split(/\s+/).filter(Boolean);
}

/** The three classes that put the ring and aside BESIDE the headline, from one breakpoint up. */
function besideAt(breakpoint: "lg" | "xl"): string[] {
  return [`${breakpoint}:flex-row`, `${breakpoint}:items-center`, `${breakpoint}:justify-between`];
}

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * The TOP-LEVEL attribute text of every opening <CommandBand …> tag. Anything inside `{…}` — the
 * ring's own JSX, a template literal — is blanked, so a nested element's props can never be read as
 * the band's own, and a `>` inside a prop cannot end the tag early.
 */
function commandBandTags(source: string): string[] {
  const tags: string[] = [];
  const opener = /<CommandBand(?=[\s/>])/g;
  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    let depth = 0;
    let topLevel = "";
    for (let i = match.index + match[0].length; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      else if (depth === 0 && ch === ">") break;
      topLevel += depth === 0 && ch !== "}" ? ch : " ";
    }
    tags.push(topLevel);
  }
  return tags;
}

export function runSalesCommandBandFitsALaptopTests() {
  // ── 1. besideFrom="xl" moves the whole row to xl; the default stays lg ──────────────────────
  const band = stripComments(readFileSync(COMMAND_BAND, "utf8"));
  const signature = band.match(/export function CommandBand\(\{([\s\S]*?)\}: \{/);
  assert.ok(
    signature,
    `${COMMAND_BAND}: CommandBand is no longer declared as \`export function CommandBand({ … }: { … })\`. ` +
      `Re-point this test at wherever the band chooses its row breakpoint — do not drop it.`,
  );
  assert.match(
    signature[1],
    /\bbesideFrom = "lg"/,
    `${COMMAND_BAND}: CommandBand's besideFrom must default to "lg". Every band that passes no prop ` +
      `was measured and signed off with the ring beside the headline from 1024px; changing the ` +
      `default moves all of them at once.`,
  );

  const row = band.match(/cn\(\s*"([^"]*)",\s*besideFrom === "xl"\s*\?\s*"([^"]*)"\s*:\s*"([^"]*)",?\s*\)/);
  assert.ok(
    row,
    `${COMMAND_BAND}: CommandBand no longer builds its row as cn("<base>", besideFrom === "xl" ? "<xl>" : "<lg>"). ` +
      `Re-point this test at whatever lays out the headline and the ring — do not drop it.`,
  );
  const [base, xlRow, lgRow] = [tokens(row[1]), tokens(row[2]), tokens(row[3])];
  for (const token of [...besideAt("lg"), ...besideAt("xl")]) {
    assert.ok(
      !base.includes(token),
      `${COMMAND_BAND}: the band's base row classes "${row[1]}" carry "${token}". The base must stay a ` +
        `column: a breakpoint in it applies whichever besideFrom a page passes.`,
    );
  }
  for (const token of besideAt("xl")) {
    assert.ok(
      xlRow.includes(token),
      `${COMMAND_BAND}: besideFrom="xl" gives "${row[2]}", which is missing "${token}". From 1280px the ` +
        `ring and aside must sit beside the headline exactly as they did before — the move to xl ` +
        `is a breakpoint change, not a new look.`,
    );
  }
  assert.ok(
    !xlRow.some((token) => token.startsWith("lg:")),
    `${COMMAND_BAND}: besideFrom="xl" gives "${row[2]}", which still carries an lg: class. At 1024px ` +
      `in the portal that squeezed the headline column to 100px, with the stat figures painted under ` +
      `the ring.`,
  );
  for (const token of besideAt("lg")) {
    assert.ok(
      lgRow.includes(token),
      `${COMMAND_BAND}: the default besideFrom="lg" gives "${row[3]}", which is missing "${token}".`,
    );
  }

  // ── 2. HEADLINE: a band carrying BOTH a ring and an aside sits beside its headline from xl ───
  const bandsWithRingAndAside: { file: string; beside: boolean }[] = [];
  for (const file of SOURCE_ROOTS.flatMap((root) => tsxFiles(root))) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const tag of commandBandTags(source)) {
      if (!/(^|\s)ring=/.test(tag) || !/(^|\s)aside=/.test(tag)) continue;
      bandsWithRingAndAside.push({ file: file.split(path.sep).join("/"), beside: /(^|\s)besideFrom="xl"/.test(tag) });
    }
  }
  assert.ok(
    bandsWithRingAndAside.some((entry) => entry.file === TARGETS_WORKSPACE),
    `${TARGETS_WORKSPACE}: found no <CommandBand> with both ring= and aside= there. The Targets header ` +
      `is the band this test was written for — re-point the scan, do not let it pass on nothing.`,
  );
  for (const entry of bandsWithRingAndAside) {
    assert.ok(
      entry.beside,
      `${entry.file}: a <CommandBand> is handed both a ring and an aside but does not pass ` +
        `besideFrom="xl". The ring and aside together are ~405px and never shrink, so from 1024px they ` +
        `take the row and leave the headline the rest: 100px on the portal Targets page, measured ` +
        `2026-09-16, with "Targets" 113px wide and the stat figures painted under the ring.`,
    );
  }

  // ── 3. HEADLINE: the Sales vs Target inline header goes side by side from xl, never lg ──────
  const vsTarget = stripComments(readFileSync(VS_TARGET, "utf8"));
  const header = vsTarget.match(
    /<div className="([^"]*)">\s*<div className="min-w-0">\s*<p className="[^"]*">\{kicker\}<\/p>\s*<h1 className="[^"]*">\s*Sales vs Target\s*<\/h1>/,
  );
  assert.ok(
    header,
    `${VS_TARGET}: the header no longer renders its headline column (kicker, then the "Sales vs Target" ` +
      `h1) directly inside a row <div> with a literal className. Re-point this test at whatever lays ` +
      `out the headline beside the ring — do not drop it.`,
  );
  const vsRow = tokens(header[1]);
  for (const token of besideAt("lg")) {
    assert.ok(
      !vsRow.includes(token),
      `${VS_TARGET}: the header row is "${header[1]}" — "${token}" is back. From 1024px that puts the ` +
        `150px ring and the "Measured" aside beside the headline, and in the portal the headline ` +
        `column measured 132px with the 170px stats row spilling under the ring.`,
    );
  }
  for (const token of besideAt("xl")) {
    assert.ok(
      vsRow.includes(token),
      `${VS_TARGET}: the header row is "${header[1]}", which is missing "${token}". From 1280px the ring ` +
        `and aside must still sit beside the headline, exactly as before.`,
    );
  }
}
