// ─── Phoenix form design tokens ───────────────────────────────────────────────
//
// 🔒 THE FORM DESIGN GOLDEN RULE (owner, 2026-10-06): "sweep the system wide
// everywhere admin or emp any form or any thing applicable make it follow this
// form design." The design he named is the Adverse Drug Reaction Report wizard
// (`src/components/report-it/report-it-form.tsx`) — and these constants are that
// form's own class strings, lifted verbatim so there is ONE source of truth
// instead of the ~38 near-identical local `fieldClass` constants that existed
// before this file.
//
// THE IDENTITY, in one line each:
//   · square corners — no radius anywhere (the square-edge golden rule)
//   · a hairline slate-300 border on white, 40px tall, 12px of side padding
//   · orange is the ONLY accent: focus border, focus ring, step marker, the
//     required star, the progress bar
//   · labels are micro-caps — `text-phx-xs`, `font-black`, `uppercase`,
//     tracking-wide, slate-500 — never sentence-case body text
//   · the primary action is near-black, the submit is orange, back is ghost
//
// These are plain strings with no `cn()` call, so a server component may import
// this file. The components that use them live in `./form-kit.tsx`.
//
// Pinned by `tests/form-design-system.test.ts`, which also refuses a form field
// anywhere in the app that paints its own border/background/radius instead of
// importing one of these. Changing a token here changes every form in the
// system — that is the point, and it is why the test exists.

/** The canonical text/number/date/email input. 40px, square, orange focus. */
export const phxFieldClassName =
  "h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-900 transition placeholder:text-slate-400 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20 disabled:cursor-not-allowed disabled:opacity-50";

/** The canonical `<select>` / `SearchableSelect`. Identical, plus the pointer. */
export const phxSelectClassName = `${phxFieldClassName} cursor-pointer`;

/** The canonical `<textarea>`. Same skin, free height, vertical resize only. */
export const phxTextareaClassName =
  "w-full resize-y border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 transition placeholder:text-slate-400 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * A field carrying a validation error. Appended to the field token, never used
 * instead of it, so an invalid field keeps the same geometry as a valid one and
 * nothing on the row shifts when the message appears.
 */
export const phxFieldInvalidClassName =
  "border-rose-400 focus:border-rose-500 focus:ring-rose-500/20";

/**
 * The label's TYPOGRAPHY alone — for a label its container already places (a
 * flex row, a grid cell, a filter bar). Same ink, size and weight as the full
 * label token, without the block and margin that would move it.
 */
export const phxLabelTextClassName =
  "text-phx-xs font-black uppercase tracking-wide text-slate-500";

/** The micro-caps label that sits above every field. */
export const phxLabelClassName = `mb-1.5 block ${phxLabelTextClassName}`;

/** The required star. Rose, never orange — orange is the accent, not an alarm. */
export const phxRequiredMarkClassName = "ml-0.5 text-rose-600";

/** Helper text under a field. */
export const phxHintClassName = "mt-1 block text-xs leading-relaxed text-slate-400";

/** The inline message under an invalid field. */
export const phxFieldMessageClassName = "mt-1 block text-xs font-bold text-rose-700";

// ─── Buttons ──────────────────────────────────────────────────────────────────

/** Secondary / Back. */
export const phxButtonGhostClassName =
  "inline-flex items-center gap-1.5 border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 transition hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-40";

/** The primary move-forward action (Next, Save, Continue). */
export const phxButtonPrimaryClassName =
  "inline-flex items-center gap-1.5 border border-slate-900 bg-slate-900 px-5 py-2 text-sm font-bold text-white transition hover:bg-slate-800 disabled:pointer-events-none disabled:opacity-50";

/** The terminal commit action (Submit). Orange, used once per form. */
export const phxButtonAccentClassName =
  "inline-flex items-center gap-1.5 border border-orange-600 bg-orange-600 px-5 py-2 text-sm font-bold text-white transition hover:bg-orange-700 disabled:pointer-events-none disabled:opacity-50";

/**
 * The APPROVE half of a decision pair (owner, 2026-10-07: "add an approve-green button token to
 * the form kit"). It exists because a decision screen cannot borrow the form palette for this: on
 * a form orange is the one terminal commit and rose is a problem, so an Accept painted orange
 * reads as "submit" and one painted rose reads as "error". Green against the danger token is the
 * only pair a manager reads correctly at a glance, and before this every decision screen wrote its
 * own — one emerald, the next a different green, each at a different height. (Those examples
 * are written without their Tailwind prefixes on purpose: the palette assertion scans this whole
 * file, comments included, so naming a colour here would register it as a fifth family.)
 *
 * 🔴 ITS GEOMETRY IS THE DANGER TOKEN'S, deliberately — the two are only ever rendered side by
 * side, and a pair of different sizes is what a hand-written pair always produced.
 *
 * 🔴 USE IT ONLY AS THAT HALF. A form's own terminal commit stays `phxButtonAccentClassName`;
 * green is not a second accent and must not spread to Save, Next or Submit. `identityTests()` in
 * `tests/form-design-system.test.ts` holds the palette to slate + orange + rose + this one.
 */
export const phxButtonApproveClassName =
  "inline-flex items-center gap-1.5 border border-emerald-600 bg-emerald-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-emerald-700 disabled:pointer-events-none disabled:opacity-50";

/**
 * The SAME decision, where the geometry is not the token's to give: the dense `<Button>` primitive
 * (`h-8 px-2.5`) or a table row that already sets its own padding and font size. Those are the
 * owner's own 2026-10-06 exemption from the one form design — `h-8`/`h-9` dense table and filter
 * controls keep their density — so forcing `px-4 py-2 text-sm` on them would make an Approve
 * taller than the `variant="secondary"` button beside it.
 *
 * 🔴 COLOUR ONLY, AND IT MUST STAY THAT WAY. The border COLOUR is here so a button with a
 * hairline does not name emerald itself; the border WIDTH stays the caller's, which is why this is
 * inert on an element that has no border. No padding, no height, no font size, no border width:
 * that is the whole reason it can sit on a dense control without resizing it, and it is why the two
 * halves still match — whatever supplies the geometry supplies it to BOTH. `identityTests()` fails
 * if either dense token grows a dimension.
 */
export const phxButtonApproveDenseClassName =
  "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700";

/** The reject/destructive half at dense geometry. Colour only — see the approve twin above. */
export const phxButtonDangerDenseClassName =
  "border-rose-600 bg-rose-600 text-white hover:bg-rose-700";

/** The destructive action, and the REJECT half of a decision pair. */
export const phxButtonDangerClassName =
  "inline-flex items-center gap-1.5 border border-rose-600 bg-rose-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-rose-700 disabled:pointer-events-none disabled:opacity-50";

/** "Add another block" — dashed, full width, orange on hover. */
export const phxButtonAddBlockClassName =
  "flex w-full items-center justify-center gap-1.5 border border-dashed border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-600 transition hover:border-orange-500 hover:text-orange-600";

// ─── Surfaces ─────────────────────────────────────────────────────────────────

/** The outer card a standalone (non-admin-shell) form sits in. */
export const phxFormPanelClassName = "border border-slate-200 bg-white shadow-sm";

/** A repeating sub-block inside a form (one reaction, one medicine, one row). */
export const phxFormBlockClassName = "border border-slate-200 bg-white";

/** That block's own header strip. */
export const phxFormBlockHeaderClassName =
  "flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2.5";

/** The form-level error banner. */
export const phxFormErrorClassName =
  "border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-800";

/** The footer rule the Back/Next pair sits on. */
export const phxFormActionsClassName =
  "mt-6 flex items-center justify-between border-t border-slate-200 pt-5";

/**
 * The default field grid: one column on a phone, two from `sm`, and — because a
 * form often sits in a half-width grid cell rather than at viewport width — it
 * drops back to one at `lg` before going to two and three at `xl`/`2xl`. That
 * ladder is the fits-the-screen golden rule applied to a field row: a form never
 * scrolls sideways, it reflows.
 */
export const phxFieldGridClassName =
  "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3";

/** A two-up field grid, for forms with few fields. */
export const phxFieldGridTwoClassName = "grid grid-cols-1 gap-4 sm:grid-cols-2";

// ─── Checkable tiles ──────────────────────────────────────────────────────────

/** The checkbox/radio tile. Pass the checked state; it picks the skin. */
export function phxCheckTileClassName(checked: boolean): string {
  return [
    "flex cursor-pointer select-none items-center gap-2.5 border px-3 py-2.5 text-sm font-semibold transition",
    checked
      ? "border-orange-500 bg-orange-50 text-slate-900"
      : "border-slate-200 bg-white text-slate-600 hover:border-slate-400",
  ].join(" ");
}

/** The native box inside that tile. */
export const phxCheckInputClassName = "h-4 w-4 shrink-0 accent-orange-600";
