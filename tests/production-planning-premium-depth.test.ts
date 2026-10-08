import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Production Planner — the premium-polish golden rule, and the square edge BEHIND the indirection.
 *
 * 🔒 The owner's rule of 2026-09-08, quoted at the top of `admin-design-tokens.ts`: "Remove this
 * rule 'NO MORE PREMIUM POLISH' and anything current in system or will be built consider godmode
 * premium polish golden rule." The planner was built after that instruction and never received it
 * — measured 2026-10-09, the whole module carried ZERO shadows while every other admin surface in
 * the app sits on the shared two-layer depth, which is what made four of its sections read as
 * content lying on the page rather than panels on it.
 *
 * 🔴 THE REASON THIS FILE EXISTS RATHER THAN A COMMENT. The polish was applied by moving the
 * module's four class constants onto the SHARED tokens, and that indirection costs the
 * fits-the-screen test its sight: `production-planning-fits-the-screen.test.ts` harvests class
 * tokens from this file's own literals, so `${adminPanelClassName}` is one opaque token to it. If a
 * session ever restores the pre-#3114 tokens out of git history — the exact mistake
 * `admin-design-tokens.ts` warns about, because those carried `rounded-[18px]` and `rounded-full`
 * ALONGSIDE the shadows — the square-edge golden rule would break in the employee portal, where
 * nothing zeroes a radius, and the planner's own guard would not see it. So this file reads the
 * tokens' real values and checks them: depth yes, radius no.
 *
 * 🔴 AND THE DEPTH ITSELF IS PINNED, not just the absence of corners. A later flat pass that
 * reverts these four constants to `border border-slate-300 bg-white` would be a silent undo of an
 * owner instruction — the kind of change that reads as tidying.
 */

const WORKSPACE = "src/components/production-planning/production-planning-workspace.tsx";
const TOKENS = "src/components/admin/admin-design-tokens.ts";

/** One shared token's literal value, read out of the tokens file rather than assumed. */
function tokenValue(tokensSource: string, name: string): string {
  const match = tokensSource.match(new RegExp(`export const ${name} =\\s*\n?\\s*"([^"]*)";`));
  assert.ok(
    match,
    `${TOKENS}: the exported token ${name} was not found. The planner composes its panels out of ` +
      `it, so renaming it silently flattens the module — move the module's constants with it.`,
  );
  return match[1];
}

export function runProductionPlanningPremiumDepthTests() {
  const source = readFileSync(WORKSPACE, "utf8");
  const tokens = readFileSync(TOKENS, "utf8");

  // 1. The module composes the SHARED tokens. A hand-rolled shadow here would drift from the rest
  //    of the admin shell the first time the shared one is tuned, which is the whole reason the
  //    tokens file exists.
  for (const name of ["adminPanelClassName", "adminSoftPanelClassName", "adminInsetPanelClassName"]) {
    assert.ok(
      new RegExp(`\\b${name}\\b`).test(source),
      `${WORKSPACE}: ${name} is not imported any more. The planner's panels, cards and notices are ` +
        `the shared admin surfaces — a local shadow literal is how two admin pages end up with two ` +
        `different depths.`,
    );
  }

  // 2. Each of the module's four surface constants resolves to the right shared token. These are
  //    the four that carry nearly every class in the file: the panel, the desktop table, the
  //    mobile card and the recessed notice.
  const expected: Record<string, { token: string; keep: readonly string[] }> = {
    PANEL: { token: "adminPanelClassName", keep: ["px-4", "py-4"] },
    TABLE: { token: "adminPanelClassName", keep: ["hidden", "w-full", "table-fixed", "lg:table"] },
    CARD: { token: "adminSoftPanelClassName", keep: ["px-3", "py-3", "lg:hidden"] },
    NOTICE: { token: "adminInsetPanelClassName", keep: ["px-3", "py-2"] },
  };
  for (const [name, { token, keep }] of Object.entries(expected)) {
    const match = source.match(new RegExp(`^const ${name} = \`([^\`]*)\`;$`, "m"));
    assert.ok(
      match,
      `${WORKSPACE}: the ${name} class constant is gone or is no longer a template literal. All ` +
        `four compose a shared admin token; a plain string here means the depth was removed.`,
    );
    const value = match[1];
    assert.ok(
      value.includes(`\${${token}}`),
      `${WORKSPACE}: ${name} is "${value}" and no longer composes ${token}. The owner's premium ` +
        `polish rule (2026-09-08) makes depth the default for anything built from then on, and this ` +
        `module shipped flat — reverting it is an undo of an instruction, not a tidy-up.`,
    );
    for (const layout of keep) {
      assert.ok(
        value.split(/\s+/).includes(layout),
        `${WORKSPACE}: ${name} is "${value}" and lost "${layout}". The depth pass changed no box's ` +
          `size on purpose — that is what kept the measured fits-the-screen result valid.`,
      );
    }
  }

  // 3. 🔴 THE SQUARE EDGE, READ THROUGH THE INDIRECTION. This is the assertion the planner's own fit
  //    test cannot make any more, and the one a history-restoring session would trip.
  for (const name of ["adminPanelClassName", "adminSoftPanelClassName", "adminInsetPanelClassName"]) {
    const value = tokenValue(tokens, name);
    assert.ok(
      !/(^|[\s:])rounded(-|\s|$)/.test(value),
      `${TOKENS}: ${name} is "${value}" and carries a radius. The square-edge golden rule admits ` +
        `none, and the employee portal renders these same tokens WITHOUT the admin shell's ` +
        `"[class*=rounded] { border-radius: 0 }" rule — so one token would produce two looks again.`,
    );
    assert.ok(
      value.includes("shadow-["),
      `${TOKENS}: ${name} is "${value}" and carries no shadow. The planner leans on it for the ` +
        `whole module's depth, so flattening the token flattens five tabs at once.`,
    );
  }

  // 4. Every desktop table is the shared panel. One table left on a hairline border is the state
  //    the module shipped in, and it reads as a grid drawn on the page.
  const tableTags = [...source.matchAll(/<table className=(\{[^}]*\}|"[^"]*")/g)].map((match) => match[1]);
  assert.equal(
    tableTags.length,
    5,
    `${WORKSPACE}: found ${tableTags.length} tables, expected 5. A new one needs the TABLE constant ` +
      `(and its own colgroup and card list — see production-planning-fits-the-screen.test.ts).`,
  );
  for (const [index, tag] of tableTags.entries()) {
    assert.ok(
      tag.includes("TABLE"),
      `${WORKSPACE}: table ${index + 1} is className=${tag} instead of the shared TABLE constant. ` +
        `A literal className is how one table keeps the flat border the other four lost.`,
    );
  }

  // 5. The KPI tile. It is the first thing a reader looks at on this screen and it was grounded on
  //    grey with a hairline border; it now sits on the panel with a 3px accent across the top —
  //    absolutely positioned inside the existing padding, so the tile's own box never changed and
  //    the 375px clipping measured on 2026-10-06 cannot come back through this pass.
  const tile = source.match(/function Tile\(\{[\s\S]*?\n\}\n/);
  assert.ok(tile, `${WORKSPACE}: the Tile component was not found.`);
  assert.ok(
    tile[0].includes("absolute inset-x-0 top-0 h-[3px]"),
    `${WORKSPACE}: the KPI tile lost its accent bar. The bar is the module's one piece of colour ` +
      `on a white panel and it is what separates a headline figure from a bordered box.`,
  );
  assert.ok(
    tile[0].includes("adminPanelClassName"),
    `${WORKSPACE}: the KPI tile no longer sits on the shared panel. "bg-slate-50" under a hairline ` +
      `border is the flat ground this pass removed.`,
  );
  assert.ok(
    !/border-slate-300 bg-slate-50/.test(tile[0]),
    `${WORKSPACE}: the KPI tile is back on the flat grey ground.`,
  );
  assert.ok(
    tile[0].includes("px-3 py-3"),
    `${WORKSPACE}: the KPI tile's padding changed. At 375px the admin shell gives each tile a 105px ` +
      `content box against the 124px the planner's own total needs — the measured clip of ` +
      `2026-10-06 — so the tile's geometry is deliberately untouched by the depth pass.`,
  );

  // 6. Section headings carry the page header's own rail, mirrored for Arabic. Two accents drawn
  //    separately drift; and on an RTL line a `left-0` rail sits at the END of the title, which is
  //    the defect the header's own two constants exist to avoid.
  const sectionTitle = source.match(/function SectionTitle\(\{[\s\S]*?\n\}\n/);
  assert.ok(sectionTitle, `${WORKSPACE}: the SectionTitle component was not found.`);
  assert.ok(
    sectionTitle[0].includes("RTL_HEADER_RAIL") && sectionTitle[0].includes("LTR_HEADER_RAIL"),
    `${WORKSPACE}: SectionTitle does not use both rails. A single rail here renders on the wrong ` +
      `side of every heading in one of the two languages — the module is read in both.`,
  );
  assert.ok(
    /S\.dir === "rtl" \? "pr-3" : "pl-3"/.test(sectionTitle[0]),
    `${WORKSPACE}: SectionTitle's padding no longer follows the rail. Without it the title sits ` +
      `under its own accent on one side and floats away from it on the other.`,
  );
  const railGradients = [...source.matchAll(/linear-gradient\(180deg,#F97316/g)].length;
  assert.equal(
    railGradients,
    2,
    `${WORKSPACE}: ${railGradients} copies of the rail gradient. There are exactly two — the same ` +
      `rail mirrored — and a third is a second accent that will drift from the header's.`,
  );

  // 7. 🔴 THE RATCHET, AT ZERO. The flat surface shape the module shipped with must not come back,
  //    in a new section or in a restored constant. `border border-slate-300 bg-white` followed by
  //    padding IS that shape; the quiet BUTTON uses the same colours deliberately and carries its
  //    own shadow, so the guard looks for the padded-surface spelling rather than the colours.
  //    The quiet BUTTON uses those same colours deliberately and carries its own hairline shadow,
  //    so the guard reads whole class EXPRESSIONS and asks each padded hairline ground for depth —
  //    rather than banning three colours, which would have made this assertion fail on a control
  //    that is already correct.
  const classExpressions = [
    ...[...source.matchAll(/className="([^"]*)"/g)].map((match) => match[1]),
    ...[...source.matchAll(/className=\{`([^`]*)`\}/g)].map((match) => match[1]),
    ...[...source.matchAll(/^const [A-Z_]+ =\s*((?:\s*"[^"]*"\s*\+?)+);/gm)].map((match) => match[1]),
    ...[...source.matchAll(/^const [A-Z_]+ = `([^`]*)`;$/gm)].map((match) => match[1]),
  ];
  const flatSurfaces = classExpressions.filter(
    (value) =>
      /border border-slate-300 bg-white/.test(value) &&
      /\bpx-\d/.test(value) &&
      !value.includes("shadow-"),
  );
  assert.deepEqual(
    flatSurfaces,
    [],
    `${WORKSPACE}: ${flatSurfaces.length} flat panel ground(s) are back. Every surface in this ` +
      `module composes a shared admin token now; a hairline border with no depth is what the ` +
      `owner's premium polish rule removed from the whole app.`,
  );
}
