import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// "The Direct Order screen in the employee portal on mobile is very zoomed in."
//
// Reported by the field force, 2026-08-16. It is not a layout bug and it is not a
// viewport bug — the viewport meta is correct (`width=device-width, initial-scale=1`,
// from Next's default merged with app/layout.tsx's `viewportFit: "cover"`).
//
// It is iOS Safari doing what it is documented to do: focus a text field whose computed
// font-size is under 16px and Safari zooms the whole page in to make it legible, then
// LEAVES IT ZOOMED after the field blurs. There is no zoom-back. The reader pinches out
// by hand, on every screen, after every tap.
//
// Android Chrome does not do this, which is why it survived: invisible on the desk, and
// invisible on half the field force's phones. Direct Orders surfaced it because it is
// the most form-heavy screen a rep touches — the submit form's shared `inputClass()` is
// `text-sm` (14px) and so is the workspace search box, so a rep raising an order was
// zoomed from the first tap to the last.
//
// The repo had already found this ONCE, on one control: the decision-actions reason box
// carries `text-base ... md:text-sm`, and the assertion guarding it in
// direct-orders-approval-window-mobile.test.ts says so in as many words. The lesson was
// never generalised, so it protected exactly one textarea out of the portal's hundreds.
//
// This test guards the general fix instead of one more component, because the trigger is
// the COMPUTED font-size — whatever class produced it. A per-component rule protects the
// files somebody remembered to change; a shell-scoped CSS floor protects every portal
// page, every component another session owns, and every control added after today.
// ─────────────────────────────────────────────────────────────────────────────

const GLOBALS = "../app/globals.css";
const PORTAL_LAYOUT = "../src/components/employee-portal/employee-portal-layout.tsx";
const ADMIN_SHELL_ROOT = "../src/components/layout/app-shell.tsx";
const ROOT_LAYOUT = "../app/layout.tsx";

/** iOS Safari's documented zoom threshold. Below this it zooms; at or above it does not. */
const IOS_ZOOM_THRESHOLD_PX = 16;

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

export function runEmployeePortalMobileInputZoomTests() {
  const css = read(GLOBALS);

  // ── The floor exists, and it is a MOBILE floor ─────────────────────────────
  // Sliced out of the file as one block so every assertion below reads the same rule.
  // Matched on the selector rather than on a comment, so re-wording the comment cannot
  // make this pass while the rule is gone.
  const blockStart = css.indexOf(".employee-portal-shell input:not([type=\"checkbox\"])");
  assert.notEqual(
    blockStart,
    -1,
    "app/globals.css must floor portal form controls at 16px on phones. Without it, iOS Safari " +
      "zooms the page on every field focus and never zooms back — the 'very zoomed in' report " +
      "from the field force, 2026-08-16.",
  );

  // The @media wrapper is what keeps this off desktop. Found by walking BACK to the nearest
  // @media, not by searching the whole file for one — a file-wide search would happily match
  // some other component's media query and call an unwrapped, desktop-wide rule fine.
  const mediaAt = css.lastIndexOf("@media", blockStart);
  assert.notEqual(mediaAt, -1, "the 16px floor must sit inside a media query, never apply at every width");
  const mediaHeader = css.slice(mediaAt, css.indexOf("{", mediaAt));
  const maxWidth = /max-width:\s*(\d+)px/.exec(mediaHeader);
  assert.ok(
    maxWidth,
    `the floor must be bounded by a max-width media query so desktop keeps its density — the ` +
      `owner's "desktop shows full tables, mobile gets cards" rule depends on it. Found: "${mediaHeader.trim()}"`,
  );
  // 767px is the underside of Tailwind's `md`, which is the breakpoint the one pre-existing
  // fix (decision-actions' `md:text-sm`) already used. Two different mobile boundaries in one
  // portal is how a control ends up 14px at 760px wide on one screen and 16px on the next.
  assert.equal(
    Number(maxWidth[1]),
    767,
    `the mobile boundary must be 767px — the underside of Tailwind's md:, which the portal's ` +
      `existing mobile rules and the decision-actions md:text-sm fix already use`,
  );

  const block = css.slice(blockStart, css.indexOf("}", css.indexOf("{", blockStart)) + 1);

  // ── HEADLINE: the floor is at least 16px ───────────────────────────────────
  // The whole defect is one number. A floor of 15px is not a partial fix — iOS zooms on 15px
  // exactly as it zooms on 14px, so a "nearly right" value here ships the bug at full strength
  // while every other assertion in this file stays green.
  const floor = /font-size:\s*max\(\s*(\d+)px/.exec(block);
  assert.ok(
    floor,
    `the rule must set a font-size FLOOR via max(), not a flat size: max() lets a deliberately ` +
      `larger control keep its size and moves only the ones under the zoom threshold. Found: ` +
      `"${block.replace(/\s+/g, " ")}"`,
  );
  assert.ok(
    Number(floor[1]) >= IOS_ZOOM_THRESHOLD_PX,
    `portal form controls must be at least ${IOS_ZOOM_THRESHOLD_PX}px on a phone — found ` +
      `${floor[1]}px. iOS Safari zooms the viewport on focus at anything below ${IOS_ZOOM_THRESHOLD_PX}px ` +
      `and does not zoom back, so 15px ships the reported bug at full strength.`,
  );
  // `1em` on font-size resolves against the PARENT, so max(16px, 1em) raises the small ones and
  // leaves a larger control alone. A flat `16px` would SHRINK any control deliberately set bigger.
  assert.match(
    block,
    /max\(\s*\d+px\s*,\s*1em\s*\)/,
    "the floor must be max(16px, 1em), not a flat 16px — a flat value shrinks any control that was " +
      "deliberately set larger, which turns a mobile fix into a mobile regression somewhere else",
  );

  // ── It covers all three control types, in EVERY shell ──────────────────────
  // <select> and <textarea> zoom exactly as <input> does. The submit form uses all three —
  // Product and Deal are selects, the approver note is a textarea — so covering only <input>
  // would leave a rep zoomed by the second field on the screen that prompted this.
  //
  // Both shells, because until 2026-08-28 this rule named `.employee-portal-shell` alone and was
  // the ONLY max-width:767px block in globals.css — so `.admin-shell` had no floor whatsoever and
  // the identical defect was live on every admin page on a phone, unreported only because those
  // users are usually at a desk. It surfaced while planning the two new HR accounts, which the
  // owner placed on the admin shell: without the floor they would have shipped carrying the exact
  // bug the portal was fixed for. A shell added later (an HR shell is planned) must be added here
  // on its first day — a missing floor is invisible on a desk and constant on a phone.
  for (const shell of ["employee-portal-shell", "admin-shell"]) {
    for (const control of ["input", "select", "textarea"]) {
      assert.match(
        block,
        new RegExp(`\\.${shell} ${control}\\b`),
        `<${control}> inside .${shell} triggers the same iOS focus-zoom as every other control and ` +
          `must carry the same 16px floor`,
      );
    }
  }
  // Checkbox and radio render no text and never trigger the zoom; excluding them keeps the rule
  // from touching controls whose box size is drawn from font-size in some browsers.
  assert.match(
    block,
    /input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)/,
    "checkbox and radio must stay excluded — they render no text, never trigger the zoom, and " +
      "some browsers size their box from font-size",
  );

  // ── The selector actually matches something ────────────────────────────────
  // The load-bearing link, and the one most likely to break silently: the rule is scoped to
  // `.employee-portal-shell`, so renaming that class on the chrome root would leave this whole
  // file green while every portal control went back to 14px.
  const layout = read(PORTAL_LAYOUT);
  assert.match(
    layout,
    /className="employee-portal-shell /,
    "the portal chrome root must still carry `employee-portal-shell` — every rule in globals.css's " +
      "portal section, including the 16px floor, selects on that class and silently matches nothing " +
      "without it",
  );

  // Same link for the admin shell, which the two HR accounts sit on. The class is applied inside a
  // template literal on the admin branch of the shell root, so it is matched on `admin-shell ` with
  // the trailing space that precedes the interpolated background class — renaming or dropping it
  // would leave every assertion above green while every admin control on a phone went back to 14px
  // and iOS resumed zooming on each focus.
  assert.match(
    read(ADMIN_SHELL_ROOT),
    /admin-shell \$\{/,
    "the admin chrome root must still carry `admin-shell` — the square-corner rules, the table " +
      "styling and the 16px mobile floor all select on that class and silently match nothing without it",
  );

  // ── The viewport is NOT the fix ────────────────────────────────────────────
  // The one-line "fix" for focus-zoom found in every search result is `maximum-scale=1` or
  // `user-scalable=no`. It works by forbidding the reader to zoom AT ALL — including the
  // deliberate pinch-zoom someone uses to read a pharmacy name in Arabic, or an 8pt total. That
  // is a WCAG 1.4.4 failure and it would land on a field force that reads two scripts on a phone
  // in a car. Banned here so nobody "simplifies" the CSS floor into it later.
  const rootLayout = read(ROOT_LAYOUT);
  for (const banned of ["maximumScale", "userScalable", "maximum-scale", "user-scalable"]) {
    assert.ok(
      !rootLayout.includes(banned),
      `app/layout.tsx must not disable pinch-zoom (${banned}): it suppresses the focus-zoom symptom ` +
        `by taking zoom away from the reader entirely — a WCAG 1.4.4 failure, on a field force that ` +
        `reads Arabic and English on a phone. Fix the font-size, never the viewport.`,
    );
  }
  // …and the viewport itself must still be a real mobile viewport. Without width=device-width a
  // phone lays the page out at 980px and scales it down, which is the OPPOSITE complaint.
  assert.match(
    rootLayout,
    /viewportFit:\s*"cover"/,
    "the root viewport must keep viewportFit: cover — safe-area insets on notched devices resolve " +
      "to 0 without it, and Next merges width=device-width, initial-scale=1 underneath it",
  );
}
