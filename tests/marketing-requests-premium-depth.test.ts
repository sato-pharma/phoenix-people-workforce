import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

/**
 * Marketing requests, the ROI report and the Coverage Report — the owner's premium-polish golden
 * rule, applied 2026-10-09, and the guards that keep it.
 *
 * 🔒 2026-09-08, quoted at the top of `admin-design-tokens.ts`: "anything current in system or will
 * be built consider godmode premium polish golden rule." Measured the night the Approvals Hub was
 * polished, this was the next module with no real depth anywhere: 53 surfaces across seven
 * components drew `border border-phx-line bg-white` — `adminPanelClassName` with its shadow taken
 * out — and the only depth in the folder was `shadow-sm`, Tailwind's weakest blur, which reads as a
 * slightly dirty edge rather than as a card sitting on paper. Zero `shadow-[…]` in 53 surfaces.
 *
 * 🔴 WHY A TEST AND NOT A COMMENT. These files have no class constants of their own — every
 * className is written inline, twice in strings 1,000 lines apart — so nothing stops an eighth file,
 * or the next panel in one of these seven, from re-typing the flat border. The guards are therefore
 * ratchets at ZERO on the flat shape and on the hand-drawn dark band, plus the shared tokens read at
 * their SOURCE, which is the one assertion no amount of grepping this folder can make: a component
 * only ever names the token, so a later "tidy-up" that strips the shadows out of
 * `admin-design-tokens.ts` would leave every file here reading correct and every screen flat.
 *
 * WHAT THIS PASS DELIBERATELY DID NOT DO, so nobody "finishes the job" later:
 *   - It did not touch a radius. These files carry `rounded-[4px]`…`rounded-[8px]` and
 *     `rounded-none` from before; the admin shell zeroes every radius in CSS, and changing the
 *     portal-visible ones is a look decision for the owner, not a side effect of adding depth.
 *   - It did not restyle the tone alerts (amber/rose/emerald/slate notices). They are state
 *     colours, not surfaces.
 *   - It did not take the closed multiselect control onto a panel token: its border, background and
 *     focus ring belong to the one form design (AGENTS.md §4), so only depth was added. Assertion 9
 *     pins that carve-out, because the flat-ratchet in assertion 1 would otherwise invite a session
 *     to "fix" it onto a token and quietly break the form language.
 */

const DIR = "src/components/marketing-requests";
const TOKENS = "src/components/admin/admin-design-tokens.ts";

/** The ground that IS the panel token minus its shadow. */
const FLAT_GROUND = "border border-phx-line bg-white";

/** The seven components this pass covered, read once. Any new .tsx here is covered too. */
function moduleFiles(): Array<{ name: string; source: string }> {
  return readdirSync(DIR)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => ({ name, source: readFileSync(`${DIR}/${name}`, "utf8") }));
}

/**
 * Every quoted class expression in a file: a plain `"…"` attribute or `cn()` argument, and a
 * `` `…` `` template, which is what a composed token produces. A surface is judged by the WHOLE
 * expression, never by its line, because a long className wraps.
 */
function classExpressions(source: string): string[] {
  return [...(source.match(/"[^"\n]*"/g) ?? []), ...(source.match(/`[^`]*`/g) ?? [])];
}

function tokenValue(tokens: string, name: string): string {
  const match = tokens.match(new RegExp(`export const ${name} =\\s*\n?\\s*"([^"]*)";`));
  assert.ok(
    match,
    `${TOKENS}: the exported token ${name} was not found. This module composes its surfaces out of ` +
      `it — renaming it flattens seven files at once.`,
  );
  return match[1];
}

export function runMarketingRequestsPremiumDepthTests() {
  const files = moduleFiles();
  const tokens = readFileSync(TOKENS, "utf8");
  assert.ok(files.length >= 7, `${DIR}: only ${files.length} components found — the glob is wrong.`);

  // 1. NO SURFACE DRAWS THE FLAT GROUND WITH NO DEPTH. After this pass the ground survives only on
  //    interactive things that keep their own surface — a button, a chip, the form control — and
  //    every one of those carries a shadow of its own. A structural surface composes a token.
  const flat: string[] = [];
  let grounded = 0;
  for (const { name, source } of files) {
    for (const value of classExpressions(source)) {
      if (!value.includes(FLAT_GROUND)) continue;
      grounded += 1;
      if (!value.includes("shadow-")) flat.push(`${name}: ${value.slice(0, 100)}…`);
    }
  }
  assert.deepEqual(
    flat,
    [],
    `${DIR}: ${flat.join(" | ")} — a surface draws "${FLAT_GROUND}" with no shadow at all. That ` +
      `shape IS adminPanelClassName without its depth: compose the token (adminSoftPanelClassName ` +
      `for an inner box, a filter bar or an empty state), or, for a control that must keep the form ` +
      `ground, add the two-layer shadow beside it.`,
  );

  // The ratchet has to be measuring something. A regex that matches nothing passes forever, which
  // is the failure mode every source-reading test here keeps repeating.
  assert.ok(
    grounded >= 15,
    `${DIR}: only ${grounded} class expression(s) carrying "${FLAT_GROUND}" were parsed, expected at ` +
      `least 15 — the class-expression reader is broken, so assertion 1 proves nothing.`,
  );

  // 2. THE PANELS ARE COMPOSED, NOT RE-TYPED. Six of the seven files render a structural surface;
  //    only the multiselect is a pure control. If the token use disappears, the look went back to
  //    hand-written borders even if nothing reads as "flat" yet.
  //    Matched on the EXACT import path: a substring match on "admin-design-tokens" also accepts
  //    `admin-design-tokens-renamed`, so the guard would have survived the import being pointed at
  //    a module that does not exist (watched escaping a break-and-watch probe, 2026-10-09).
  const tokenUsers = files.filter(({ source }) =>
    source.includes('from "@/components/admin/admin-design-tokens"'),
  ).length;
  assert.ok(
    tokenUsers >= 6,
    `${DIR}: only ${tokenUsers} file(s) compose the shared admin tokens, expected at least 6.`,
  );

  // 3. THE DARK TABLE-HEADER BAND IS ONE TOKEN. The Coverage Report had three copies of
  //    `bg-slate-900` on three <tr>s; three copies drift the moment one is touched. Matched by the
  //    band's own signature — the hairline above it and the uppercase header type — never by the
  //    colour alone, because a filled dark ACTION is an action, not a surface.
  const ownBand = files
    .filter(({ source }) =>
      /border-b border-phx-line bg-slate-900|bg-slate-900[^"`]*uppercase/.test(source),
    )
    .map(({ name }) => name);
  assert.deepEqual(
    ownBand,
    [],
    `${DIR}: ${ownBand.join(", ")} draw(s) its own dark header band. Use adminPanelHeaderClassName ` +
      `and leave only the padding and the type at the call site.`,
  );
  const bandUsers = files.filter(({ source }) => source.includes("adminPanelHeaderClassName")).length;
  assert.ok(
    bandUsers >= 1,
    `${DIR}: nothing uses adminPanelHeaderClassName any more. The Coverage Report's three table ` +
      `headers wear it — losing it is a look change the owner did not ask for.`,
  );

  // 4. EVERY TOKEN THIS MODULE LEANS ON CARRIES DEPTH AND NO RADIUS, read at its source. The radius
  //    half is the live hazard, not a formality: the pre-#3114 tokens carried `rounded-[18px]`
  //    ALONGSIDE the shadows, so restoring them out of git history re-rounds every corner — and the
  //    employee portal, which renders marketing ROI for a rep, zeroes nothing in CSS.
  for (const name of ["adminPanelClassName", "adminSoftPanelClassName", "adminPanelHeaderClassName"]) {
    const value = tokenValue(tokens, name);
    assert.ok(
      !/(^|[\s:])rounded(-|\s|$)/.test(value),
      `${TOKENS}: ${name} is "${value}" and carries a radius. The square-edge golden rule admits ` +
        `none, and the portal renders these same components with nothing zeroing it.`,
    );
    assert.ok(
      value.includes("shadow-[") || value.includes("linear-gradient("),
      `${TOKENS}: ${name} is "${value}" — no shadow and no gradient. Flattening it flattens this ` +
        `whole module, which is what the owner's 2026-09-08 rule reversed.`,
    );
  }

  // 5. THE PANEL TOKEN'S DEPTH IS TWO LAYERS. One soft blur reads as a dirty edge; a hairline
  //    contact shadow under a wide ambient one is what says "above the page". `shadow-sm`, which
  //    this module used to carry, is the single-layer version of exactly this mistake.
  const panel = tokenValue(tokens, "adminPanelClassName");
  assert.ok(
    (panel.match(/rgba\(/g) ?? []).length >= 2,
    `${TOKENS}: adminPanelClassName is "${panel}" and carries one shadow layer. Two layers — a ` +
      `1px contact shadow plus a wide ambient one — are what make a surface read as depth.`,
  );

  // 6. A LIFTED BUTTON THAT CAN BE DISABLED DROPS ITS LIFT. A greyed control still floating reads
  //    as clickable, and on these screens the control runs a 20-second report query.
  const stillLifted: string[] = [];
  for (const { name, source } of files) {
    for (const value of classExpressions(source)) {
      if (!value.includes("shadow-[0_1px_2px_rgba(15,23,42,0.06)")) continue;
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

  // 7. THE FLOATING DROPDOWN READS AS FLOATING. It is a popover over a filter panel that already
  //    carries the panel token, so it needs MORE ambient spread than the surface under it —
  //    `shadow-lg`, what it had, is weaker than the panel it opens over.
  const multi = files.find(({ name }) => name === "roi-multi-select.tsx");
  assert.ok(multi, `${DIR}: roi-multi-select.tsx is gone.`);
  const popover = multi.source.match(/className="absolute left-0 top-full[^"]*"/);
  assert.ok(popover, `${DIR}/roi-multi-select.tsx: the dropdown panel's className was not found.`);
  assert.ok(
    /shadow-\[[^"]*_(1[89]|[2-9]\d)px_/.test(popover[0]),
    `${DIR}/roi-multi-select.tsx: the dropdown is ${popover[0]} — it needs a wide ambient shadow ` +
      `(an 18px+ vertical offset). It opens OVER a panel that already has depth of its own.`,
  );

  // 8. THE CLOSED CONTROL KEEPS THE FORM GROUND. This is the carve-out assertion 1 would otherwise
  //    invite someone to remove: a <summary> that behaves as a select wears the one form design's
  //    border, background and focus ring (AGENTS.md §4) and takes depth only.
  const summary = multi.source.match(/className="flex min-h-\[58px\][^"]*"/);
  assert.ok(summary, `${DIR}/roi-multi-select.tsx: the closed control's className was not found.`);
  assert.ok(
    summary[0].includes(FLAT_GROUND) && !summary[0].includes("adminSoftPanelClassName"),
    `${DIR}/roi-multi-select.tsx: the closed control is ${summary[0].slice(0, 110)}… — it must keep ` +
      `the FORM ground "${FLAT_GROUND}" and add only depth. Putting it on a panel token changes a ` +
      `form field's border and background, which the one form design owns.`,
  );
  assert.ok(
    summary[0].includes("shadow-["),
    `${DIR}/roi-multi-select.tsx: the closed control carries no depth at all.`,
  );
}
