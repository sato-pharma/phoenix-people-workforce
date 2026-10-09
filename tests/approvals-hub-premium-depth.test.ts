import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

/**
 * The Approvals Hub — the owner's premium-polish golden rule, and the one thing holding its look
 * together across 22 files.
 *
 * 🔒 2026-09-08, quoted at the top of `admin-design-tokens.ts`: "anything current in system or will
 * be built consider godmode premium polish golden rule." Measured 2026-10-09, this module was the
 * largest in the app with NO depth at all — zero shadows in 22 components, and its dominant surface
 * shape was `border border-phx-line bg-white`, which is `adminPanelClassName` with the shadow
 * removed. Thirty surfaces across fifteen files, each written out by hand.
 *
 * 🔴 WHY A TEST AND NOT A COMMENT: this module has no class constants of its own. Every className
 * is inline, so there is no single place a reader can look to see what a panel is supposed to be —
 * and that is exactly how thirty hand-written copies happened in the first place. The guards below
 * are therefore ratchets at ZERO on the flat shapes, plus the shared tokens read at their source.
 * A sixteenth file drawing its own flat panel fails here rather than being noticed by eye, and a
 * later "tidy-up" that strips the shadows back out of the tokens fails here too.
 *
 * It does NOT pin the module's existing `rounded-full` dots and `rounded-sm` buttons. They pre-date
 * this pass, the admin shell zeroes every radius in CSS, and changing them is a look decision for
 * the owner rather than a side effect of adding depth — they are reported, not quietly redesigned.
 */

const DIR = "src/components/approvals-hub";
const TOKENS = "src/components/admin/admin-design-tokens.ts";

/** The hub's own files, read once. */
function hubFiles(): Array<{ name: string; source: string }> {
  return readdirSync(DIR)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => ({ name, source: readFileSync(`${DIR}/${name}`, "utf8") }));
}

function tokenValue(tokens: string, name: string): string {
  const match = tokens.match(new RegExp(`export const ${name} =\\s*\n?\\s*"([^"]*)";`));
  assert.ok(
    match,
    `${TOKENS}: the exported token ${name} was not found. The Approvals Hub composes its surfaces ` +
      `out of it — renaming it flattens fifteen files at once.`,
  );
  return match[1];
}

export function runApprovalsHubPremiumDepthTests() {
  const files = hubFiles();
  const tokens = readFileSync(TOKENS, "utf8");
  assert.ok(files.length >= 20, `${DIR}: only ${files.length} components found — the glob is wrong.`);

  // 1. THE FLAT PANEL IS GONE, AND STAYS GONE. `border border-phx-line bg-white` is the shared
  //    panel token minus its shadow, so after this pass it can only ever be a surface that was
  //    written by hand instead of composed.
  const flat = files
    .filter(({ source }) => source.includes("border border-phx-line bg-white"))
    .map(({ name }) => name);
  assert.deepEqual(
    flat,
    [],
    `${DIR}: ${flat.join(", ")} still draw(s) a flat panel. That shape IS adminPanelClassName ` +
      `without its shadow — compose the token (adminSoftPanelClassName for a list row, a filter ` +
      `bar or an empty state) rather than re-typing the border.`,
  );

  // 2. THE DARK HEADER BAND IS ONE TOKEN. Thirteen copies of `bg-slate-900` drift the moment one of
  //    them is touched, and this band is what makes a panel read as part of the hub.
  //    The band's signature is its padding and the grey hairline it used to carry — NOT the colour
  //    alone, because a filled `bg-slate-900` ACTION (the acknowledge button) is an action and not
  //    a surface, and sweeping the colour would demand that button take a header's treatment.
  const ownBand = files
    .filter(({ source }) =>
      /border-b border-phx-line bg-slate-900|bg-slate-900 px-\d+(\.\d+)? py-2\.5|bg-slate-900 px-\d+(\.\d+)? py-3\b/.test(
        source,
      ),
    )
    .map(({ name }) => name);
  assert.deepEqual(
    ownBand,
    [],
    `${DIR}: ${ownBand.join(", ")} draw(s) its own dark header band. Use adminPanelHeaderClassName ` +
      `and keep only the padding at the call site.`,
  );
  const bandUsers = files.filter(({ source }) => source.includes("adminPanelHeaderClassName")).length;
  assert.ok(
    bandUsers >= 10,
    `${DIR}: only ${bandUsers} file(s) use the shared header band, expected at least 10. If the ` +
      `band was removed from the hub's panels, that is a look change the owner did not ask for.`,
  );

  // 3. EVERY SURFACE TOKEN THIS MODULE LEANS ON CARRIES DEPTH AND NO RADIUS, read at its source —
  //    the assertion no amount of grepping this folder can make, because the folder only ever
  //    names the token. The radius half is the live hazard: the pre-#3114 tokens carried
  //    `rounded-[18px]` ALONGSIDE the shadows, and the employee portal, which renders these same
  //    components, has no rule zeroing a radius.
  for (const name of ["adminPanelClassName", "adminSoftPanelClassName", "adminPanelHeaderClassName"]) {
    const value = tokenValue(tokens, name);
    assert.ok(
      !/(^|[\s:])rounded(-|\s|$)/.test(value),
      `${TOKENS}: ${name} is "${value}" and carries a radius. The square-edge golden rule admits ` +
        `none, and the portal twin of this hub zeroes nothing.`,
    );
    const hasDepth = value.includes("shadow-[") || value.includes("linear-gradient(");
    assert.ok(
      hasDepth,
      `${TOKENS}: ${name} is "${value}" — no shadow and no gradient. Flattening it flattens the ` +
        `whole Approvals Hub, which is what the owner's 2026-09-08 rule reversed.`,
    );
  }

  // 4. The header band keeps the HERO's warm third stop and the accent hairline. A flat near-black
  //    band is what the hero's own note calls an unstyled div, and a grey line under black is
  //    invisible — those two are the entire reason the band became a token rather than a colour.
  const band = tokenValue(tokens, "adminPanelHeaderClassName");
  assert.ok(
    band.includes("#1C0E02"),
    `${TOKENS}: adminPanelHeaderClassName is "${band}" and lost the hero's warm third stop.`,
  );
  assert.ok(
    /border-b border-orange/.test(band),
    `${TOKENS}: adminPanelHeaderClassName is "${band}" — the hairline under the band must carry the ` +
      `module accent. A grey border under a near-black band renders as nothing at all.`,
  );

  // 5. The mobile thumb bar's shadow points UP. It is fixed over the page, so a downward shadow is
  //    drawn into content nobody can see — the one place in the module where the default is wrong.
  const decision = files.find(({ name }) => name === "decision-actions.tsx");
  assert.ok(decision, `${DIR}: decision-actions.tsx is gone.`);
  const bar = decision.source.match(/className="fixed inset-x-0[^"]*"/);
  assert.ok(bar, `${DIR}/decision-actions.tsx: the fixed thumb bar's className was not found.`);
  assert.ok(
    /shadow-\[0_-\d/.test(bar[0]),
    `${DIR}/decision-actions.tsx: the thumb bar is ${bar[0]} — its shadow must point upward ` +
      `(shadow-[0_-8px_…]). It floats over the page, so a downward shadow falls on hidden content.`,
  );

  // 6. A FILLED ACTION THAT LIFTS AND CAN BE DISABLED MUST DROP THE LIFT WHEN DISABLED. A greyed
  //    button still floating reads as clickable, which on this screen is the screen where money
  //    moves.
  const offenders: string[] = [];
  for (const { name, source } of files) {
    for (const value of source.match(/className="[^"]*"/g) ?? []) {
      const lifts = /shadow-\[0_1px_2px_rgba\(15,23,42,0\.2\)/.test(value);
      if (!lifts) continue;
      if (!/\bdisabled:/.test(value)) continue;
      if (!value.includes("disabled:shadow-none")) offenders.push(`${name}: ${value.slice(0, 90)}…`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `${DIR}: a lifted action keeps its shadow while disabled — ${offenders.join(" | ")}. Add ` +
      `disabled:shadow-none beside the disabled styling.`,
  );
}
