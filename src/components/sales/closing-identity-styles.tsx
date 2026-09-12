"use client";

import { CLOSING_FONT_STACK, CLOSING_GRID_LINE, CLOSING_IDENTITY } from "@/lib/sales/closing-identity";

/**
 * The premium closing workbook's identity, applied to a whole closing SCREEN.
 *
 * Owner, 2026-09-12: "brand the front end closing as the premium xlsx sato identity". The matrix
 * paints itself (closing-matrix-table.tsx); this is everything around it — the hero band, the chips,
 * the filter bar, the family summary, the buttons — on both the admin workspace and the employee
 * portal view.
 *
 * WHY A STYLESHEET AND NOT EDITS. Two things on these pages are painted by `app/globals.css`, not by
 * the components at all:
 *
 *   `.admin-shell thead th { background-color: #000000 !important }` and its hairline
 *   `border: 1px solid rgba(249,115,22,.22) !important` on every th and td,
 *
 * with an identical pair under `.employee-portal-shell`. They are deliberate house rules that reach
 * "every current and future page" in each shell, so the family summary table was still rendering a
 * BLACK header and ORANGE rules after its own classes had been rewritten navy — the source said one
 * thing and the emitted page said another. Re-tinting a shared component instead would repaint every
 * other admin page with it. A wrapper class is the only lever that is both strong enough to win and
 * narrow enough to stop at this screen.
 *
 * WHY IT REDEFINES A TOKEN RATHER THAN LISTING UTILITIES. `--phx-accent` is the orange every
 * `text-phx-accent` / `bg-phx-accent` / `border-phx-accent` utility resolves through
 * (`--color-phx-accent: var(--phx-accent)` in globals.css). Setting the variable on the wrapper
 * re-tints all of them at once — including the ones a future edit adds — where an enumerated list
 * would silently miss whatever it did not name.
 *
 * 🔴 AND WHY IT MUST SET BOTH FAMILIES. `--color-phx-accent: var(--phx-accent)` lives in an
 * `@theme inline` block, so it is declared on `:root` — and a custom property's `var()` is
 * substituted where it is DECLARED, not where it is used. `--color-phx-accent` therefore computes
 * to the literal orange at `:root` and INHERITS that resolved orange into every descendant;
 * redefining `--phx-accent` further down cannot reach back and change it. Measured on the rendered
 * page: with only the raw token set, this wrapper's own button read
 * `--phx-accent: #0B78B7` and `--color-phx-accent: #f97316` at the same time, and painted orange.
 * That is the whole failure mode — the half-fix leaves the page looking almost right, so whatever
 * still reads through a `--color-*` bridge (`bg-primary` does, via `--phoenix-primary`) is the one
 * orange control left on a navy page. Set the raw token, the bridge, and the legacy alias together.
 *
 * THE MATRIX IS EXCLUDED BY NAME. `table:not(.phx-closing-grid)` — the grid's own scoped stylesheet
 * is the more specific of the two for its coloured headers but NOT for its plain ones, so without
 * this exclusion the two would be deciding a cascade tie by source order, which is exactly the kind
 * of coupling that breaks the next time either file moves.
 */
export const CLOSING_SURFACE_CLASS = "phx-closing-identity";

export function ClosingIdentityStyles() {
  return (
    <style>{`
      .${CLOSING_SURFACE_CLASS} {
        /* The raw tokens — what a hand-written rule reads (var(--phx-accent), color-mix(...)). */
        --phx-accent: ${CLOSING_IDENTITY.corporateBlue};
        --phx-accent-hover: ${CLOSING_IDENTITY.secondaryNavy};
        --phx-accent-press: ${CLOSING_IDENTITY.primaryNavy};
        --phx-accent-soft: ${CLOSING_IDENTITY.lightBlue};
        --phx-accent-line: ${CLOSING_IDENTITY.corporateBlue};
        /* The @theme bridge — what every Tailwind *-phx-accent utility reads. Already substituted
           at :root, so it does NOT follow the raw token above and has to be set here as well. */
        --color-phx-accent: ${CLOSING_IDENTITY.corporateBlue};
        --color-phx-accent-hover: ${CLOSING_IDENTITY.secondaryNavy};
        --color-phx-accent-press: ${CLOSING_IDENTITY.primaryNavy};
        --color-phx-accent-soft: ${CLOSING_IDENTITY.lightBlue};
        --color-phx-accent-line: ${CLOSING_IDENTITY.corporateBlue};
        /* The legacy alias and its own bridge — bg-primary / text-primary resolve through these
           (--color-primary: var(--phoenix-primary), and --phoenix-primary: var(--phx-accent)).
           "Publish to portal" is a bg-primary button, and it was the last orange control left. */
        --phoenix-primary: ${CLOSING_IDENTITY.corporateBlue};
        --phoenix-primary-hover: ${CLOSING_IDENTITY.secondaryNavy};
        --color-primary: ${CLOSING_IDENTITY.corporateBlue};
        --color-primary-hover: ${CLOSING_IDENTITY.secondaryNavy};
        --ring: ${CLOSING_IDENTITY.corporateBlue};
        --phx-ink: ${CLOSING_IDENTITY.primaryNavy};
        --phx-ink-2: ${CLOSING_IDENTITY.mainText};
        --phx-ink-soft: ${CLOSING_IDENTITY.mutedText};
        font-family: ${CLOSING_FONT_STACK};
      }
      .${CLOSING_SURFACE_CLASS} table:not(.phx-closing-grid) thead th {
        background-color: ${CLOSING_IDENTITY.secondaryNavy} !important;
        color: ${CLOSING_IDENTITY.white} !important;
      }
      .${CLOSING_SURFACE_CLASS} table:not(.phx-closing-grid) th,
      .${CLOSING_SURFACE_CLASS} table:not(.phx-closing-grid) td {
        border: 1px solid ${CLOSING_GRID_LINE} !important;
      }
    `}</style>
  );
}
