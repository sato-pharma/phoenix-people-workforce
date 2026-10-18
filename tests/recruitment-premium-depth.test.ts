import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/**
 * Recruitment / ATS — the premium depth, pinned.
 *
 * 🔒 2026-09-08, quoted at the top of `admin-design-tokens.ts`: "anything current in system or
 * will be built consider godmode premium polish golden rule." Recruitment was built before that
 * and never got it: measured on `origin/main` at d5a33f761, the module drew **139** class
 * expressions carrying a panel ground and only **6** of them had any depth at all, while NO file
 * composed the shared admin tokens. Every box on the ATS sat flat on the page.
 *
 * WHAT THIS PASS DID, and the one thing it refused to do. The module draws its surfaces on
 * `border-slate-200`/`border-slate-300`, on the warm `bg-phx-paper` strips and on the WhatsApp
 * preview green — not on the panel token's ground. `--phx-line` is #e0dcd4 (warm) where
 * `border-slate-200` is #e2e8f0 (cool), so taking those surfaces onto `adminPanelClassName` would
 * have recoloured a hundred borders: a redesign wearing a depth rule's clothes. So five
 * DEPTH-ONLY tokens were added beside the panel tokens — the same shadows, named once — and each
 * surface kept its own ground. Assertion 1 is what makes that safe: it pins each depth token to
 * the panel token it was lifted from, so the two cannot drift into two different shadows.
 *
 * Nothing in the pass changed a radius, a padding, a colour or a size.
 *
 * THE FOUR CARVE-OUTS, each pinned by an assertion of its own, because the ratchet in assertion 2
 * would otherwise invite a session to "finish the job" and quietly break something the owner
 * decided:
 *
 *   · THE FORM GROUND (assertion 8). The two picker input wrappers wear the one form design's
 *     border, background and focus ring (AGENTS.md §4). They are the only flat four-sided grounds
 *     left in the module, and they stay flat.
 *   · THE SCREENING WORKSTATION WAS A CARVE-OUT UNTIL 2026-10-19 (assertion 9 now pins the
 *     opposite). It had kept the quiet look of 2026-09-12 — the screen he screens on "looks crowded
 *     and noisy" — until the owner's full-module premium sweep, where he was asked that exact
 *     question and chose "Full polish there too". His later word outranks the earlier one, so the
 *     cockpit is now held to the same zero-flat-box ratchet as every other recruitment screen.
 *   · THE PRINT VIEWS (assertion 10). `candidate-record-print.tsx` and
 *     `whatsapp-application-print.tsx` mirror a printed page; the house ink rule governs them, not
 *     this one.
 *   · ROWS, PANE DIVIDERS AND DASHED PLACEHOLDERS. A list row, a flush `border-r` pane edge and a
 *     dashed "nothing here" box are not surfaces — a shadow on each would stripe the list, seam the
 *     cockpit and make an empty state look occupied. They carry a single-edge border or a dashed
 *     one, so assertion 2's four-sided test never reaches them.
 */

const DIR = "src/components/recruitment";
const TOKENS = "src/components/admin/admin-design-tokens.ts";

/**
 * A box bordered on all four sides, on one of the grounds this module draws.
 *
 * The leading `["`]` in the boundary is not decoration. Without it the pattern misses every class
 * expression that STARTS with `border border-…` — which is the commonest shape of a flat box here,
 * and precisely the one a lifted surface loses when somebody turns a template back into a plain
 * string. A break-watch caught it escaping on 2026-10-09.
 */
const BOXED_GROUND =
  /(?:^|[\s`"])border border-(?:phx-line|slate-200|slate-300|\[#[0-9A-Fa-f]{6}\]) bg-(?:white|phx-paper|slate-50|slate-50\/60|\[#[0-9A-Fa-f]{6}\])/;

/** The one form-design carve-out: a field wrapper is recognised by its focus-within ring. */
const FORM_GROUND = "focus-within:border-orange-500";

/** Every .tsx in the module, read once, with its path relative to the module root. */
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

/**
 * Every quoted class expression in a file: a plain `"…"` attribute or `cn()` argument, and a
 * `` `…` `` template, which is what a surface composing a token produces. A surface is judged by
 * the WHOLE expression, never by its line, because a long className wraps.
 */
function classExpressions(source: string): string[] {
  return [...(source.match(/"[^"\n]*"/g) ?? []), ...(source.match(/`[^`]*`/g) ?? [])];
}

function tokenValue(tokens: string, name: string): string {
  const match = tokens.match(new RegExp(`export const ${name} =\\s*\n?\\s*"([^"]*)";`));
  assert.ok(
    match,
    `${TOKENS}: the exported token ${name} was not found. This module composes its depth out of ` +
      `it — renaming it flattens thirty-four files at once.`,
  );
  return match[1];
}

/** The shadow classes inside a token's value, in order. */
function shadowsOf(value: string): string[] {
  return value.match(/(?:hover:)?shadow-\[[^\]]*\]/g) ?? [];
}

export function runRecruitmentPremiumDepthTests() {
  const files = moduleFiles();
  const tokens = readFileSync(TOKENS, "utf8");
  assert.ok(files.length >= 60, `${DIR}: only ${files.length} components found — the walk is wrong.`);

  // 1. EACH DEPTH-ONLY TOKEN IS THE PANEL TOKEN'S OWN SHADOW. This is the assertion that makes the
  //    depth-only tokens safe to exist: the day one of them is "tuned", the module stops matching
  //    the Approvals Hub and the Coverage Report, and nothing on screen says so. Pinned as an
  //    EQUALITY on the shadow part, so either side drifting is caught.
  for (const [depthName, groundName] of [
    ["adminPanelDepthClassName", "adminPanelClassName"],
    ["adminSoftDepthClassName", "adminSoftPanelClassName"],
    ["adminRecessedDepthClassName", "adminInsetPanelClassName"],
  ]) {
    const depth = shadowsOf(tokenValue(tokens, depthName));
    const ground = shadowsOf(tokenValue(tokens, groundName));
    assert.deepEqual(
      depth,
      ground,
      `${TOKENS}: ${depthName} is ${JSON.stringify(depth)} but ${groundName} carries ` +
        `${JSON.stringify(ground)}. They are meant to be ONE shadow under two names — a surface ` +
        `keeping its own border must still read as the same material as a surface on the token.`,
    );
  }

  // 2. NO SURFACE DRAWS A FOUR-SIDED GROUND WITH NO DEPTH. The ratchet is ZERO, not a count: after
  //    this pass the only flat boxes left in the module are the two form-field wrappers, and
  //    assertion 8 pins those deliberately. A new flat box here is a surface somebody drew without
  //    reading the rule.
  const flat: string[] = [];
  let grounded = 0;
  for (const { name, source } of files) {
    if (name.endsWith("-print.tsx")) continue;
    for (const value of classExpressions(source)) {
      if (!BOXED_GROUND.test(value)) continue;
      grounded += 1;
      if (value.includes(FORM_GROUND)) continue;
      if (/shadow-|Depth(ClassName)?\}/.test(value)) continue;
      flat.push(`${name}: ${value.slice(0, 90)}…`);
    }
  }
  assert.ok(
    grounded >= 80,
    `${DIR}: only ${grounded} four-sided panel grounds were found, so this assertion is no longer ` +
      `measuring the module. 87 were lifted by the pass — the walk or the ground pattern is wrong.`,
  );
  assert.deepEqual(
    flat,
    [],
    `${DIR}: ${flat.length} surface(s) draw a box on all four sides with no depth — ` +
      `${flat.join(" | ")}. A page-level box takes adminPanelDepthClassName, a box inside one ` +
      `takes adminSoftDepthClassName, a read-only well or an edge strip takes ` +
      `adminRecessedDepthClassName.`,
  );

  // 3. THE MODULE COMPOSES THE SHARED TOKENS. Matched on the EXACT import path: a substring match
  //    on "admin-design-tokens" also accepts `admin-design-tokens-renamed`, so the guard would
  //    survive the import being pointed at a copy.
  const tokenUsers = files.filter(({ source }) =>
    source.includes('from "@/components/admin/admin-design-tokens"'),
  ).length;
  assert.ok(
    tokenUsers >= 30,
    `${DIR}: only ${tokenUsers} file(s) compose the shared admin tokens, expected at least 30. ` +
      `Before this pass it was ZERO and every box on the ATS was flat.`,
  );

  // 4. EVERY TOKEN THIS MODULE LEANS ON CARRIES DEPTH AND NO RADIUS, read at its source. The radius
  //    half is the live hazard: the pre-#3114 tokens carried `rounded-[18px]` ALONGSIDE the
  //    shadows, so restoring them out of git history re-rounds every corner.
  for (const name of [
    "adminPanelClassName",
    "adminPanelHeaderClassName",
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
        `none, and nothing zeroes it outside the admin shell.`,
    );
    assert.ok(
      value.includes("shadow-[") || value.includes("linear-gradient("),
      `${TOKENS}: ${name} is "${value}" — no shadow and no gradient. Flattening it flattens this ` +
        `whole module, which is what the owner's 2026-09-08 rule reversed.`,
    );
  }

  // 5. A LIFTED BUTTON THAT CAN BE DISABLED DROPS ITS LIFT. A greyed control still floating reads
  //    as clickable, and several of these run an import or send a WhatsApp message.
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

  // 6. THE DARK BANDS ARE THE SHARED BAND, NOT A LOCAL bg-slate-900. Two panel headers in the share
  //    links view and the week grid's table head wore their own copy; a copy drifts the moment one
  //    of them is touched.
  //
  //    MATCHED BY THE ELEMENT, NEVER BY THE CLASS. The week grid's band read exactly
  //    `"bg-slate-900 text-white"` — the same string, character for character, as the SELECTED
  //    state of a button in four other files here. A filled dark action is not a surface, so the
  //    only thing that separates them is what the class is on: a <tr>, a <thead> or a <header> is
  //    a band; a <button> is a choice somebody made.
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
    bandUsers >= 2,
    `${DIR}: only ${bandUsers} file(s) use adminPanelHeaderClassName. The share-links view's two ` +
      `panel headers and the interview week grid's table head wear it — losing it is a look change ` +
      `the owner did not ask for.`,
  );

  // 7. A RECESSED SURFACE IS NOT LIFTED. A read-only well, a dialog's edge strip and a toolbar tray
  //    sit BELOW the page; giving one a drop shadow says it floats above the panel it is cut into,
  //    which is the single easiest way to make this pass look wrong.
  const liftedWells: string[] = [];
  for (const { name, source } of files) {
    for (const value of classExpressions(source)) {
      if (!/bg-slate-50(?:\/60)?[\s`"]|bg-phx-paper[\s`"]/.test(value)) continue;
      if (/adminPanelDepthClassName|adminSoftDepthClassName/.test(value)) {
        liftedWells.push(`${name}: ${value.slice(0, 90)}…`);
      }
    }
  }
  assert.deepEqual(
    liftedWells,
    [],
    `${DIR}: ${liftedWells.join(" | ")} — a recessed surface was given a DROP shadow. The grey ` +
      `wells and the strips at a dialog's edges take adminRecessedDepthClassName, whose depth is ` +
      `an inner shadow.`,
  );

  // 8. THE TWO FORM-FIELD WRAPPERS KEEP THE FORM GROUND. This is the carve-out assertion 2 would
  //    otherwise invite a session to "fix": a wrapper around an <input> wears the one form design's
  //    border, background and focus ring (AGENTS.md §4), and a field that floats off the page is
  //    not what that design says.
  const formWrappers = files.flatMap(({ name, source }) =>
    classExpressions(source)
      .filter((value) => value.includes(FORM_GROUND))
      .map((value) => ({ name, value })),
  );
  assert.ok(
    formWrappers.length >= 2,
    `${DIR}: the picker field wrappers (${FORM_GROUND}) were not found — they are the carve-out ` +
      `this assertion exists to protect.`,
  );
  const liftedFields = formWrappers
    .filter(({ value }) => /shadow-|Depth(ClassName)?\}/.test(value))
    .map(({ name, value }) => `${name}: ${value.slice(0, 90)}…`);
  assert.deepEqual(
    liftedFields,
    [],
    `${DIR}: ${liftedFields.join(" | ")} — a form field took depth. Its border, background and ` +
      `focus ring belong to the one form design (AGENTS.md §4); only a surface takes depth here.`,
  );

  // 9. THE SCREENING WORKSTATION WEARS THE PREMIUM LOOK TOO (owner, 2026-10-19). It had been the
  //    one carve-out since 2026-09-12 ("looks crowded and noisy"); asked during the full-module sweep
  //    whether it should stay quiet, he chose "Full polish there too". So the cockpit composes the
  //    shared depth tokens like every other screen, and assertion 2 now reaches it. Restoring the
  //    quiet look would undo his later word.
  const cockpit = files.filter(({ name }) => name.startsWith("workstation/"));
  const liftedCockpit = cockpit.filter(({ source }) =>
    source.includes('from "@/components/admin/admin-design-tokens"'),
  );
  assert.ok(
    liftedCockpit.length >= 4,
    `${DIR}/workstation: only ${liftedCockpit.length} of ${cockpit.length} cockpit file(s) compose the ` +
      `admin depth tokens. The owner chose full premium polish for the workstation on 2026-10-19.`,
  );

  // 10. THE PRINT VIEWS TAKE NO DEPTH. They mirror a printed page, where a drop shadow is either
  //     invisible or a grey smear, and the house ink rule governs them instead.
  const liftedPrint = files
    .filter(({ name }) => name.endsWith("-print.tsx"))
    .filter(({ source }) => source.includes('from "@/components/admin/admin-design-tokens"'))
    .map(({ name }) => name);
  assert.deepEqual(
    liftedPrint,
    [],
    `${DIR}: ${liftedPrint.join(", ")} took the admin depth tokens. A print view mirrors paper — ` +
      `the house ink rule governs it, not the premium polish rule.`,
  );
}
