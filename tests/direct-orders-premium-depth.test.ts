import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/**
 * Direct orders — the premium depth, pinned.
 *
 * 🔒 2026-09-08, quoted at the top of `admin-design-tokens.ts`: "anything current in system or
 * will be built consider godmode premium polish golden rule." Direct orders was built before it
 * and had the least depth of any module measured: on `origin/main` at 5bba00cf3, **66** class
 * expressions carried a panel ground and **63 of them had no shadow at all** — two `shadow-lg` and
 * one hand-written ambient were the whole ladder — while NO file composed the shared admin tokens.
 * Eleven `<header>` elements and three `<thead>`s each wrote their own `bg-slate-900` band.
 *
 * WHAT THIS PASS DID. Where the ground already WAS the panel token's — `border border-phx-line
 * bg-white`, which is `adminPanelClassName` with the shadow removed, written across fifteen files
 * and two class constants — the surface composes the token. Where the module draws its own cool
 * slate or its own `#eef1f3` hairline, the surface KEEPS that ground and takes a depth-only token,
 * because `--phx-line` is #e0dcd4 and `border-slate-200` is #e2e8f0: swapping them would recolour
 * the module rather than light it. Nothing changed a radius, a padding, a colour or a size.
 *
 * THE TWO HAZARDS THIS SUITE EXISTS FOR, both live in this module:
 *
 *   · `"bg-slate-900 text-white"` is BOTH the three dark table heads and the SELECTED state of
 *     three tab buttons, character for character. A sweep by class string would have painted a
 *     gradient band onto a pressed tab. Assertion 4 matches a band by its ELEMENT, and assertion
 *     11 asserts the three tab states are still untouched — the inverse of the same rule.
 *   · The mobile submit bar is `fixed` over the page, so its shadow points UP (assertion 9). A
 *     downward one falls on the content the bar covers, where nobody can see it.
 *
 * THE ONE CARVE-OUT (assertion 10): the two invoice images in `direct-order-invoice-evidence.tsx`
 * sit on a grey ground with `object-contain`. An inner shadow would be hidden under the image and
 * a drop shadow would make a scanned invoice read as a floating card. They stay flat, and they are
 * the only flat four-sided grounds left in the module.
 */

const DIR = "src/components/direct-orders";
const TOKENS = "src/components/admin/admin-design-tokens.ts";

/**
 * A box bordered on all four sides, on one of the grounds this module draws.
 *
 * The leading `["`]` in the boundary is not decoration: without it the pattern misses every class
 * expression that STARTS with `border border-…`, which is the commonest flat shape here and
 * exactly what a lifted surface turns back into when somebody replaces a template with a plain
 * string. A break-watch caught that escaping on 2026-10-09.
 */
const BOXED_GROUND =
  /(?:^|[\s`"])border border-(?:phx-line|slate-200|slate-300|slate-400|\[#[0-9A-Fa-f]{6}\]) bg-(?:white|slate-50|slate-50\/60|\[#[0-9A-Fa-f]{6}\])/;

/** The carve-out: an image frame, recognised by the class that makes it one. */
const IMAGE_FRAME = "object-contain";

function moduleFiles(): Array<{ name: string; source: string }> {
  const out: Array<{ name: string; source: string }> = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(rel ? `${DIR}/${rel}` : DIR, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith(".tsx")) out.push({ name: next, source: readFileSync(`${DIR}/${next}`, "utf8") });
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
    `${TOKENS}: the exported token ${name} was not found. This module composes its depth out of ` +
      `it — renaming it flattens twenty-four files at once.`,
  );
  return match[1];
}

export function runDirectOrdersPremiumDepthTests() {
  const files = moduleFiles();
  const tokens = readFileSync(TOKENS, "utf8");
  assert.ok(files.length >= 30, `${DIR}: only ${files.length} components found — the walk is wrong.`);

  // 1. NO SURFACE DRAWS A FOUR-SIDED GROUND WITH NO DEPTH. The ratchet is ZERO, not a count: the
  //    only flat boxes left are the two invoice image frames, and assertion 10 pins those.
  const flat: string[] = [];
  let grounded = 0;
  for (const { name, source } of files) {
    for (const value of classExpressions(source)) {
      if (!BOXED_GROUND.test(value)) continue;
      grounded += 1;
      if (value.includes(IMAGE_FRAME)) continue;
      if (/shadow-|Depth(ClassName)?\}/.test(value)) continue;
      flat.push(`${name}: ${value.slice(0, 90)}…`);
    }
  }
  assert.ok(
    grounded >= 35,
    `${DIR}: only ${grounded} four-sided panel grounds were found, so this assertion is no longer ` +
      `measuring the module — 37 were lifted by the pass. The walk or the ground pattern is wrong.`,
  );
  assert.deepEqual(
    flat,
    [],
    `${DIR}: ${flat.length} surface(s) draw a box on all four sides with no depth — ` +
      `${flat.join(" | ")}. A page-level box composes adminPanelClassName (or takes ` +
      `adminPanelDepthClassName when it must keep its own slate ground), a box inside one takes ` +
      `adminSoftDepthClassName, a read-only well or an edge strip takes adminRecessedDepthClassName.`,
  );

  // 2. THE MODULE COMPOSES THE SHARED TOKENS. Matched on the EXACT import path: a substring match
  //    on "admin-design-tokens" also accepts `admin-design-tokens-renamed`.
  const tokenUsers = files.filter(({ source }) =>
    source.includes('from "@/components/admin/admin-design-tokens"'),
  ).length;
  assert.ok(
    tokenUsers >= 20,
    `${DIR}: only ${tokenUsers} file(s) compose the shared admin tokens, expected at least 20. ` +
      `Before this pass it was ZERO.`,
  );

  // 3. EVERY TOKEN THIS MODULE LEANS ON CARRIES DEPTH AND NO RADIUS, read at its source. The radius
  //    half is the live hazard: the pre-#3114 tokens carried `rounded-[18px]` ALONGSIDE the
  //    shadows, so restoring them out of git history re-rounds every corner — and the shared
  //    report view here is a PUBLIC page, outside the admin shell, where nothing zeroes a radius.
  for (const name of [
    "adminPanelClassName",
    "adminPanelHeaderClassName",
    "adminPanelDepthClassName",
    "adminSoftDepthClassName",
    "adminRecessedDepthClassName",
    "adminControlDepthClassName",
    "adminThumbBarDepthClassName",
  ]) {
    const value = tokenValue(tokens, name);
    assert.ok(
      !/(^|[\s:])rounded(-|\s|$)/.test(value),
      `${TOKENS}: ${name} is "${value}" and carries a radius. The square-edge golden rule admits ` +
        `none, and this module's shared report view renders outside the admin shell.`,
    );
    assert.ok(
      value.includes("shadow-[") || value.includes("linear-gradient("),
      `${TOKENS}: ${name} is "${value}" — no shadow and no gradient. Flattening it flattens this ` +
        `whole module, which is what the owner's 2026-09-08 rule reversed.`,
    );
  }

  // 4. A DARK BAND IS THE SHARED BAND, MATCHED BY ITS ELEMENT. Eleven headers and three table heads
  //    wrote their own `bg-slate-900` here; fourteen copies drift the moment one is touched. The
  //    match is on the ELEMENT and never on the class, because `"bg-slate-900 text-white"` is also
  //    the pressed state of three tabs in this module — see assertion 11.
  const ownBand: string[] = [];
  for (const { name, source } of files) {
    for (const tag of source.match(/<(?:tr|thead|header)\b[^>]*>/g) ?? []) {
      if (/bg-slate-900|bg-\[#0F172A\]/.test(tag)) ownBand.push(`${name}: ${tag.slice(0, 80)}`);
    }
  }
  assert.deepEqual(
    ownBand,
    [],
    `${DIR}: ${ownBand.join(" | ")} draw(s) its own dark band. Use adminPanelHeaderClassName and ` +
      `leave only the padding and the type at the call site.`,
  );
  const bandUsers = files.filter(({ source }) => source.includes("adminPanelHeaderClassName")).length;
  assert.ok(
    bandUsers >= 12,
    `${DIR}: only ${bandUsers} file(s) use adminPanelHeaderClassName, expected at least 12 — the ` +
      `eleven desk headers and the three dark table heads wear it. Losing it is a look change the ` +
      `owner did not ask for.`,
  );

  // 5. A LIFTED BUTTON THAT CAN BE DISABLED DROPS ITS LIFT. A greyed control still floating reads
  //    as clickable, and on these screens the control attaches an invoice or releases a held order.
  const stillLifted: string[] = [];
  for (const { name, source } of files) {
    for (const value of classExpressions(source)) {
      if (!value.includes("adminControlDepthClassName")) continue;
      if (!/\bdisabled:/.test(value)) continue;
      if (!value.includes("disabled:shadow-none")) stillLifted.push(`${name}: ${value.slice(0, 90)}…`);
    }
  }
  assert.deepEqual(
    stillLifted,
    [],
    `${DIR}: a lifted button keeps its shadow while disabled — ${stillLifted.join(" | ")}. Add ` +
      `disabled:shadow-none beside the disabled styling.`,
  );

  // 6. A RECESSED SURFACE IS NOT LIFTED. The grey wells, the strips at a panel's edges and the two
  //    tab trays sit BELOW the page; a drop shadow on one says it floats above the panel it is cut
  //    into, which is the easiest way to make this pass look wrong.
  const liftedWells: string[] = [];
  for (const { name, source } of files) {
    for (const value of classExpressions(source)) {
      if (!/bg-slate-50(?:\/60)?[\s`"]/.test(value)) continue;
      if (/adminPanelDepthClassName|adminSoftDepthClassName/.test(value)) {
        liftedWells.push(`${name}: ${value.slice(0, 90)}…`);
      }
    }
  }
  assert.deepEqual(
    liftedWells,
    [],
    `${DIR}: ${liftedWells.join(" | ")} — a recessed surface was given a DROP shadow. The grey ` +
      `wells and the strips at a panel's edges take adminRecessedDepthClassName, whose depth is an ` +
      `inner shadow.`,
  );

  // 7. THE MOBILE SUBMIT BAR'S SHADOW POINTS UP. It is `fixed` over the page on a phone, so a
  //    downward shadow falls on content the bar is covering and the bar reads as painted on.
  const thumb = tokenValue(tokens, "adminThumbBarDepthClassName");
  assert.ok(
    /shadow-\[0_-\d/.test(thumb),
    `${TOKENS}: adminThumbBarDepthClassName is "${thumb}" — a bar fixed over the page needs an ` +
      `UPWARD shadow (shadow-[0_-8px_…]).`,
  );
  const workspace = files.find(({ name }) => name === "workspace/direct-orders-workspace.tsx");
  assert.ok(workspace, `${DIR}: workspace/direct-orders-workspace.tsx is gone.`);
  const bar = workspace.source.match(/className=\{?`?[^"`]*fixed inset-x-0 bottom-0[^"`]*`?\}?/);
  assert.ok(bar, `${DIR}/workspace/direct-orders-workspace.tsx: the fixed submit bar was not found.`);
  assert.ok(
    bar[0].includes("adminThumbBarDepthClassName"),
    `${DIR}/workspace/direct-orders-workspace.tsx: the submit bar is ${bar[0].slice(0, 120)} — it ` +
      `must take adminThumbBarDepthClassName, not a shadow of its own.`,
  );

  // 8. THE INVOICE IMAGE FRAMES STAY FLAT. This is the carve-out assertion 1 would otherwise invite
  //    a session to "fix": an inner shadow lands under the image and a drop shadow makes a scanned
  //    invoice read as a floating card rather than as the document it is.
  const frames = files.flatMap(({ name, source }) =>
    classExpressions(source)
      .filter((value) => value.includes(IMAGE_FRAME) && BOXED_GROUND.test(value))
      .map((value) => ({ name, value })),
  );
  assert.ok(
    frames.length >= 2,
    `${DIR}: the invoice image frames (${IMAGE_FRAME} on a bordered grey ground) were not found — ` +
      `they are the carve-out this assertion protects.`,
  );
  const liftedFrames = frames
    .filter(({ value }) => /shadow-|Depth(ClassName)?\}/.test(value))
    .map(({ name, value }) => `${name}: ${value.slice(0, 90)}…`);
  assert.deepEqual(
    liftedFrames,
    [],
    `${DIR}: ${liftedFrames.join(" | ")} — an invoice image frame took depth. The image covers an ` +
      `inner shadow and a drop shadow turns a scanned document into a card.`,
  );

  // 9. THE THREE PRESSED TABS ARE STILL A FILLED ACTION, NOT A BAND. The inverse of assertion 4,
  //    and the reason it matches on the element: `"bg-slate-900 text-white"` here is three tab
  //    buttons' selected state. If a later sweep puts the band's gradient on them, a pressed tab
  //    starts wearing a panel header's treatment and this assertion is what says so.
  const pressedTabs = files.flatMap(({ name, source }) =>
    classExpressions(source)
      .filter((value) => value === '"bg-slate-900 text-white"')
      .map(() => name),
  );
  assert.ok(
    pressedTabs.length >= 3,
    `${DIR}: the pressed-tab state "bg-slate-900 text-white" now appears ${pressedTabs.length} ` +
      `time(s), expected at least 3. A filled dark ACTION is not a surface — if a sweep moved the ` +
      `tabs onto adminPanelHeaderClassName, a pressed tab is now wearing a panel header's gradient.`,
  );
}
