import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/**
 * The employee portal — the premium depth, pinned.
 *
 * 🔒 2026-09-08, quoted at the top of `admin-design-tokens.ts`: "anything current in system or
 * will be built consider godmode premium polish golden rule." The portal was the largest body of
 * flat surface left in the app: measured on `origin/main` at d9a9d438d, **326** class expressions
 * across 83 components drew a box bordered on all four sides and **189 of them carried no depth at
 * all**, while NO portal file composed the shared tokens — the portal had instead grown FOUR local
 * `cardShadow` constants holding THREE different values (`shadow-sm`,
 * `shadow-[0_1px_3px_rgba(15,23,42,0.08)]` twice, `shadow-[0_1px_3px_rgba(15,23,42,0.06)]`) plus a
 * `CARD` constant on a fifth. Four materials for one job, which is the drift the tokens exist to
 * end; each constant now points at a token, so the name stays where callers expect it and the
 * value has one home.
 *
 * WHY THE TOKENS COME FROM `components/admin/`. They are platform tokens that happen to live in a
 * file named for the shell that needed them first — `admin-design-system.tsx` is already rendered
 * by 52 of the portal's own pages, as `tests/admin-shell-palette-scope.test.ts` records. Depth
 * carries no colour, so none of it is shell-scoped: the five values are `rgba(15,23,42,…)`
 * shadows, identical inside `.admin-shell` and inside `.employee-portal-shell`. Giving the portal
 * a second vocabulary for the same five shadows is how an app ends up with two materials, which is
 * exactly what the four `cardShadow` constants already proved.
 *
 * EVERY SURFACE KEEPS ITS OWN GROUND. The portal draws `border-slate-200` (#e2e8f0, cool) and the
 * warm `--phx-line` (#e0dcd4) side by side, plus its own hex hairlines; the palette remap that
 * warms slate is scoped to `.admin-shell` and never reaches here. So a surface takes a depth-ONLY
 * token and nothing else changes — not a radius, not a padding, not a colour, not a size.
 *
 * THE THREE CARVE-OUTS, each with its own assertion, and each one HIS and not a matter of taste:
 *
 *   · THE REP'S HONOUR STRIP (assertion 4). His ruling, 2026-10-03: *"the page became so crowded.
 *     I want only a strip telling the rank in company and line, then buttons telling the export or
 *     share. That simple, easy cake — not all over-engineered."* Lifting its bar and its three
 *     chips re-ornaments precisely what he cut. All four of its grounds stay flat.
 *   · ANYTHING THAT REACHES PAPER (assertion 6). A class string carrying a `print:` modifier is on
 *     a surface the expense and excuses dashboards print, and a shadow on paper is ink the house
 *     ink rule does not allow. Three sites, flat on purpose.
 *   · THE INVOICE IMAGE FRAME (assertion 5). `object-contain` on a grey ground is a photograph of
 *     a document: an inner shadow hides under the image and a drop shadow makes a scan read as a
 *     floating card.
 *
 * AND ONE FILE THIS PASS WAS NOT ALLOWED TO ENTER (assertion 10): `identity-card.tsx` is a
 * protected file (CLAUDE.md) and no session edits it without his approval for that specific
 * change. It draws no four-sided ground at all, so the rule and the work never collided — the
 * assertion pins both halves, because a later pass that "finishes the portal" would reach for it.
 */

const DIR = "src/components/employee-portal";
const TOKENS = "src/components/admin/admin-design-tokens.ts";
const TOKEN_IMPORT = 'from "@/components/admin/admin-design-tokens"';

/**
 * A box bordered on all four sides, on one of the grounds the portal draws.
 *
 * The leading `["`]` in the boundary is not decoration: without it the pattern misses every class
 * expression that STARTS with `border border-…`, which is the commonest flat shape here. A
 * break-watch caught that escaping on the recruitment pass, 2026-10-09.
 */
const BOXED_GROUND =
  /(?:^|[\s`"])border border-(?:phx-line|slate-200|slate-300|slate-400|\[#[0-9A-Fa-f]{6}\]) bg-(?:white|slate-50|slate-50\/60|\[#[0-9A-Fa-f]{6}\])/;

/** The carve-outs, each recognised by something in the markup rather than by a count. */
const IMAGE_FRAME = /object-contain|object-cover/;
const REACHES_PAPER = /\bprint:/;
const HONOUR_STRIP = "rep-honour-strip.tsx";
const PROTECTED_CARD = "identity-card.tsx";

/** Anything that puts a shadow on the surface, token or hand-written. */
const CARRIES_DEPTH = /shadow-|Depth(?:ClassName)?\}|adminPanelClassName|adminSoftPanelClassName/;

function moduleFiles(): Array<{ name: string; source: string }> {
  const out: Array<{ name: string; source: string }> = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(rel ? `${DIR}/${rel}` : DIR, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith(".tsx")) {
        out.push({ name: next, source: readFileSync(`${DIR}/${next}`, "utf8") });
      }
    }
  };
  walk("");
  return out;
}

/** Every quoted class expression: a plain `"…"` and a `` `…` `` template, judged whole. */
function classExpressions(source: string): string[] {
  return [...(source.match(/"[^"\n]*"/g) ?? []), ...(source.match(/`[^`]*`/g) ?? [])];
}

function tokenValue(tokens: string, name: string): string {
  const match = tokens.match(new RegExp(`export const ${name} =\\s*\n?\\s*"([^"]*)";`));
  assert.ok(
    match,
    `${TOKENS}: the exported token ${name} was not found. Forty-seven portal files compose it — ` +
      `renaming it flattens the whole portal at once.`,
  );
  return match[1];
}

export function runEmployeePortalPremiumDepthTests() {
  const files = moduleFiles();
  const tokens = readFileSync(TOKENS, "utf8");
  assert.ok(files.length >= 75, `${DIR}: only ${files.length} components found — the walk is wrong.`);

  // 1. NO SURFACE DRAWS A FOUR-SIDED GROUND WITH NO DEPTH. The ratchet is ZERO once the three
  //    carve-outs are set aside, never a tolerance — 189 were flat before this pass, and a count
  //    would quietly re-admit them one at a time.
  const flat: string[] = [];
  let grounded = 0;
  for (const { name, source } of files) {
    const base = name.split("/").pop() ?? name;
    for (const value of classExpressions(source)) {
      if (!BOXED_GROUND.test(value)) continue;
      grounded += 1;
      if (base === HONOUR_STRIP || IMAGE_FRAME.test(value) || REACHES_PAPER.test(value)) continue;
      if (CARRIES_DEPTH.test(value)) continue;
      flat.push(`${name}: ${value.slice(0, 90)}…`);
    }
  }
  assert.ok(
    grounded >= 300,
    `${DIR}: only ${grounded} four-sided grounds were found, so this assertion is no longer ` +
      `measuring the portal — 326 were counted when the pass ran. The walk or the ground ` +
      `pattern is wrong, which would make assertion 1 pass by seeing nothing.`,
  );
  assert.deepEqual(
    flat,
    [],
    `${DIR}: ${flat.length} surface(s) draw a box on all four sides with no depth — ` +
      `${flat.join(" | ")}. Choose by where the surface sits: a page-level card takes ` +
      `adminPanelDepthClassName, a box nested inside one adminSoftDepthClassName, a read-only ` +
      `well or a scroller adminRecessedDepthClassName, a button adminControlDepthClassName, a ` +
      `pill or segmented group adminChipDepthClassName. The ground it already draws stays.`,
  );

  // 2. THE PORTAL COMPOSES THE SHARED TOKENS. Matched on the EXACT import path: a substring match
  //    on "admin-design-tokens" would also accept `admin-design-tokens-renamed`.
  const tokenUsers = files.filter(({ source }) => source.includes(TOKEN_IMPORT)).length;
  assert.ok(
    tokenUsers >= 40,
    `${DIR}: only ${tokenUsers} file(s) compose the shared tokens, expected at least 40. Before ` +
      `this pass it was ZERO, and the portal held four local cardShadow constants instead.`,
  );

  // 3. EVERY TOKEN THE PORTAL LEANS ON CARRIES DEPTH AND NO RADIUS, read at its source. The radius
  //    half is live here in a way it is not in an admin module: the share-card page under
  //    `app/share/card/` renders portal markup OUTSIDE both shells, where nothing zeroes a radius,
  //    and the pre-#3114 tokens carried `rounded-[18px]` alongside their shadows — so restoring
  //    one out of git history re-rounds corners the square-edge golden rule forbids.
  for (const name of [
    "adminPanelDepthClassName",
    "adminSoftDepthClassName",
    "adminRecessedDepthClassName",
    "adminControlDepthClassName",
    "adminChipDepthClassName",
  ]) {
    const value = tokenValue(tokens, name);
    assert.ok(
      !/(^|[\s:])rounded(-|\s|$)/.test(value),
      `${TOKENS}: ${name} is "${value}" and carries a radius. The square-edge golden rule admits ` +
        `no round corner, and these tokens are appended to surfaces that already set their own.`,
    );
    assert.ok(
      /shadow-\[/.test(value),
      `${TOKENS}: ${name} is "${value}" — no shadow and no gradient, so every surface composing ` +
        `it is flat again with nothing else going red.`,
    );
  }

  // 4. HIS HONOUR STRIP STAYS FLAT (2026-10-03: "that simple, easy cake — not all
  //    over-engineered"). The inverse of assertion 1: a sweep that "finishes the portal" would
  //    lift the one surface he explicitly stripped back.
  const strip = files.find(({ name }) => name.split("/").pop() === HONOUR_STRIP);
  assert.ok(strip, `${DIR}/${HONOUR_STRIP} was not found — it carries his 2026-10-03 ruling.`);
  const stripGrounds = classExpressions(strip.source).filter((value) => BOXED_GROUND.test(value));
  assert.ok(
    stripGrounds.length >= 4,
    `${DIR}/${HONOUR_STRIP}: ${stripGrounds.length} four-sided ground(s) found, expected at least ` +
      `4 — if the strip were rebuilt this assertion would stop protecting anything.`,
  );
  const liftedInStrip = stripGrounds.filter((value) => CARRIES_DEPTH.test(value));
  assert.deepEqual(
    liftedInStrip,
    [],
    `${DIR}/${HONOUR_STRIP}: ${liftedInStrip.length} surface(s) took depth. The owner cut two ` +
      `full-width medals and an export panel down to ONE bar on 2026-10-03 — "not all ` +
      `over-engineered" — so lighting its bar or its chips restores the ornament he removed.`,
  );

  // 5. AN INVOICE IMAGE FRAME IS NOT A SURFACE. A photograph of a document on a grey ground: an
  //    inner shadow hides under the image, a drop shadow makes a scan read as a floating card.
  const liftedFrames: string[] = [];
  let frames = 0;
  for (const { name, source } of files) {
    for (const value of classExpressions(source)) {
      if (!BOXED_GROUND.test(value) || !IMAGE_FRAME.test(value)) continue;
      frames += 1;
      if (CARRIES_DEPTH.test(value)) liftedFrames.push(`${name}: ${value.slice(0, 80)}…`);
    }
  }
  assert.ok(frames >= 1, `${DIR}: no image frame on a bordered ground was found — assertion 5 is measuring nothing.`);
  assert.deepEqual(
    liftedFrames,
    [],
    `${DIR}: an invoice image frame took depth — ${liftedFrames.join(" | ")}. ` +
      `A frame recognised by object-contain stays flat.`,
  );

  // 6. THIS PASS'S DEPTH DOES NOT GO ONTO PAPER. The expense and excuses dashboards print, and a
  //    shadow printed is grey ink the house ink rule does not allow — so no class string carrying
  //    a `print:` modifier composes one of the five tokens. Narrow on purpose: SIX printed
  //    surfaces in `nsm-team-expenses-dashboard-impl.tsx` and
  //    `personal-expense-workload-dashboard.tsx` already carried their own hand-written
  //    `shadow-[…]` before this pass and were left exactly as they were — stripping those is a
  //    separate decision about an existing look, not part of adding depth.
  const tokenOnPaper: string[] = [];
  let paper = 0;
  for (const { name, source } of files) {
    for (const value of classExpressions(source)) {
      if (!BOXED_GROUND.test(value) || !REACHES_PAPER.test(value)) continue;
      paper += 1;
      if (/Depth(?:ClassName)?\}/.test(value)) tokenOnPaper.push(`${name}: ${value.slice(0, 80)}…`);
    }
  }
  assert.ok(paper >= 3, `${DIR}: only ${paper} print-modified ground(s) found, expected at least 3.`);
  assert.deepEqual(
    tokenOnPaper,
    [],
    `${DIR}: ${tokenOnPaper.length} printed surface(s) took a depth token — ` +
      `${tokenOnPaper.join(" | ")}. A class string carrying a print: modifier is on paper, and a ` +
      `shadow there is ink.`,
  );

  // 7. NO LOCAL CONSTANT HOLDS A SHADOW OF ITS OWN. This is the defect the pass found rather than
  //    one it imagined: four cardShadow constants with three different values. A fifth would
  //    re-split the material with nothing else going red, so the constants may NAME a token and
  //    never hold a literal.
  const localShadows: string[] = [];
  for (const { name, source } of files) {
    for (const match of source.matchAll(/^const\s+(\w+)\s*=\s*"([^"]*shadow[^"]*)";/gm)) {
      localShadows.push(`${name}: const ${match[1]} = "${match[2]}"`);
    }
  }
  assert.deepEqual(
    localShadows,
    [],
    `${DIR}: ${localShadows.length} local constant(s) hold a shadow literal — ` +
      `${localShadows.join(" | ")}. Point the constant at a token ` +
      `(const cardShadow = adminPanelDepthClassName) so one value has one home.`,
  );

  // 8. A DISABLED CONTROL DOES NOT KEEP ITS LIFT. `adminControlDepthClassName` grows on hover, so
  //    a greyed button that goes on floating still reads as clickable.
  const floatingDisabled: string[] = [];
  for (const { name, source } of files) {
    for (const value of classExpressions(source)) {
      if (!value.includes("adminControlDepthClassName")) continue;
      if (!/disabled:(?!shadow-none)/.test(value)) continue;
      if (value.includes("disabled:shadow-none")) continue;
      floatingDisabled.push(`${name}: ${value.slice(0, 90)}…`);
    }
  }
  assert.deepEqual(
    floatingDisabled,
    [],
    `${DIR}: ${floatingDisabled.length} control(s) keep their shadow while disabled — ` +
      `${floatingDisabled.join(" | ")}. Pair adminControlDepthClassName with ` +
      `disabled:shadow-none wherever the control has a disabled state.`,
  );

  // 9. AN IN-FLOW WELL IS NOT GIVEN A DROP SHADOW. A scroller or a read-only well sits INSIDE the
  //    page, and a surface cut into the page cannot also float above it.
  //
  //    `absolute` and `fixed` are excluded deliberately, and finding out why is what this
  //    assertion cost: a dropdown list and the flyout sidebar both scroll AND float, and both
  //    already carried a large ambient shadow of their own (the sidebar's is
  //    `0_24px_70px/0.18`). Those are overlays — a layer above the page SHOULD cast downward —
  //    so "it scrolls" is not the test; "it is in the flow" is. Only token-composed depth is
  //    policed here, because a hand-written overlay shadow is not this pass's work.
  const wrongWells: string[] = [];
  for (const { name, source } of files) {
    for (const value of classExpressions(source)) {
      if (!BOXED_GROUND.test(value)) continue;
      if (!/overflow-y-auto|max-h-\d|font-mono|whitespace-pre/.test(value)) continue;
      if (/\b(?:absolute|fixed)\b/.test(value)) continue;
      if (/adminRecessedDepthClassName/.test(value)) continue;
      if (!/Depth(?:ClassName)?\}/.test(value)) continue; // assertion 1 owns the flat case
      wrongWells.push(`${name}: ${value.slice(0, 90)}…`);
    }
  }
  assert.deepEqual(
    wrongWells,
    [],
    `${DIR}: ${wrongWells.length} read-only well(s) or scroller(s) were given a DROP shadow — ` +
      `${wrongWells.join(" | ")}. Use adminRecessedDepthClassName: its shadow is inset.`,
  );

  // 10. THE PROTECTED IDENTITY CARD WAS NOT TOUCHED. `identity-card.tsx` is locked by the owner
  //     (CLAUDE.md) and must always render through PhoenixSignatureCard. It draws no four-sided
  //     ground, so this pass had nothing to do in it — and a later sweep that assumed otherwise
  //     would edit a protected file without his approval.
  const card = files.find(({ name }) => name.split("/").pop() === PROTECTED_CARD);
  assert.ok(card, `${DIR}/${PROTECTED_CARD} was not found — it is a protected file, not an optional one.`);
  assert.ok(
    !card.source.includes(TOKEN_IMPORT),
    `${DIR}/${PROTECTED_CARD} now composes the depth tokens. It is a PROTECTED file: show the ` +
      `owner the exact change and wait for his approval of that specific change first.`,
  );
  const cardGrounds = classExpressions(card.source).filter((value) => BOXED_GROUND.test(value));
  assert.deepEqual(
    cardGrounds,
    [],
    `${DIR}/${PROTECTED_CARD} now draws ${cardGrounds.length} four-sided ground(s). It drew none ` +
      `when the depth pass ran, which is the only reason the pass could skip a protected file ` +
      `without leaving a flat surface behind. Raise it with the owner rather than lifting it.`,
  );

  // 11. THE PORTAL DOES NOT REDEFINE A TOKEN. One material, one source: a portal-local copy of a
  //     depth token is how the app ends up with two ladders that drift.
  const redefined: string[] = [];
  for (const { name, source } of files) {
    for (const match of source.matchAll(/export const (\w*Depth\w*)\s*=/g)) {
      redefined.push(`${name}: ${match[1]}`);
    }
  }
  assert.deepEqual(
    redefined,
    [],
    `${DIR}: ${redefined.length} depth token(s) are defined inside the portal — ` +
      `${redefined.join(" | ")}. Import the five from ${TOKENS}; a second definition is a second ` +
      `material, which is what the four cardShadow constants already cost.`,
  );

  // "raise the employee portal screens' fonts too" (owner, 2026-11-09): nothing on a portal screen is drawn below
  // 11px. Every .tsx under the portal's components and pages is read, so a new screen is held to it too. Three are
  // left as measured: the honour strip's line labels, sized to fit the owner's own locked strip (tests/rep-rank-
  // badges.test.ts); the phone bottom bar, whose label widths are measured at 10px (src/config/sidebar-metrics.ts,
  // tests/sidebar-label-width.test.ts) and would need a fresh browser measurement to move; and the WORKFORCE word
  // under the Phoenix bird, which is the logo lockup.
  const wordmark = "mt-1 text-phx-4xs font-black leading-none tracking-[0.34em] text-[#F05A1A]";
  let screens = 0;
  for (const folder of ["src/components/employee-portal", "app/employee-portals"]) {
    for (const entry of readdirSync(folder, { recursive: true, encoding: "utf8" })) {
      if (!entry.endsWith(".tsx")) continue;
      const file = `${folder}/${entry.replace(/\\/g, "/")}`;
      screens++;
      if (file.endsWith("/rep-honour-strip.tsx") || file.endsWith("/employee-portal-bottom-nav.tsx")) continue;
      const text = readFileSync(file, "utf8").split(wordmark).join("");
      assert.ok(!/text-phx-(?:2xs|3xs|4xs)\b|text-\[(?:[1-9]|10)px\]/.test(text), `${file}: no text below 11px on a portal screen`);
    }
  }
  assert.ok(screens >= 300, `the floor read every portal screen (${screens})`);
}
