// ─────────────────────────────────────────────────────────────────────────────
// THE LANDING BANNER — the Super Admin overview ONLY.
//
// Added 2026-09-03 at the owner's instruction: "the landing command center needs a banner, but
// not a block like the before", then scoped in his next breath — "don't touch the banner of the
// finance manager or the SFE, leave them as they are, I'm talking about the super admin and the
// HR team". Finance keeps `FinanceOwnerBanner`, SFE keeps `SfeDepartmentBanner`, and the CEO
// command center was not named and is left alone.
//
// HR IS DELIBERATELY NOT HERE, AND THAT IS NOT THE INSTRUCTION BEING IGNORED.
// He did name the HR team ("and HR Yasmine and Aya"), and this component was briefly mounted on
// `HrCommandCenter` for both seats. In parallel, another session answered the SAME need from a
// later instruction of his — the identity back in the employee portal's language, narrow, a
// height he set himself at under 96px — and shipped `PhoenixIdentityStrip` there in #3037, which
// merged first. Mounting this banner as well would have stacked two identity bars on one page,
// which is precisely the thickness he was removing. So HR keeps the merged strip and this stays
// on the one surface that has no other identity bar. If he ever wants the two seats to read like
// the Super Admin landing instead, REPLACE the strip — never add this above it.
//
// WHAT "NOT A BLOCK" MEANS, MECHANICALLY
// The thing removed earlier the same day was `AdminHeroFrame` holding `CeoHeroIdentity`: a
// full-bleed band at `p-5 sm:p-6 lg:p-7` with four decorative layers, the viewer's photo, a
// greeting and a role chip, which cost most of the first fold before any real content. This is
// the opposite trade and holds it in three ways:
//
//   1. `px-5 py-4` — the same vertical footprint as an ordinary section header, which is the
//      rule `SfeDepartmentBanner` and `FinanceOwnerBanner` already state in their own comments:
//      a banner that pushes the figures down the page costs more than it adds.
//   2. ONE wrapping row. Not a stack. Adding a second line here is how this becomes the block
//      again, so if a caller ever wants more in it, the answer is a shorter `title`.
//   3. No photo, no greeting, no clock. Those were the removed block's entire content and the
//      name and role are already in the topbar chip on every page of the shell, from
//      `resolveViewerIdentityFromPage`. Repeating them was saying the same thing twice.
//
// It earns its 40 pixels by carrying a live status the landing page did not state at the top
// before — the reader learns whether anything needs them without scrolling to find out.
//
// The look is deliberately NOT invented. Dark slate ground, a warm ember lighting it from the
// centre, a hairline top and bottom, the Sato mark in the right corner: that is the established
// house banner, copied from the two siblings above so this reads as the same system rather than
// as a one-off. (The wordmark is white, which is why this only ever sits on a dark ground.)
// ─────────────────────────────────────────────────────────────────────────────

/** `clear` is the good news and takes the emerald the pages below already use for it. */
export type CommandCenterBannerStatus = "attention" | "clear";

export function CommandCenterBanner({
  name,
  roleLabel,
  showMark = true,
  status,
  statusLabel,
}: {
  /**
   * THE PERSON, and this is the nameplate. Owner, 2026-09-03, on seeing the surface label here:
   * "I don't want it to be called the System Administrator Overview, I want it by name."
   *
   * The name only — no portrait, no "Good evening". Those were the removed block's content and
   * bringing either back is how this becomes that block again.
   */
  name: string;
  /** Under the name: her job title, or his role. The surface, in one short line. */
  roleLabel: string;
  /**
   * The Sato mark in the right corner. Off where another dark bar carrying the same mark sits
   * directly beneath this one — on the Super Admin overview the "Sato Pharma" section header is
   * 1px below, and two logos 40px apart read as a rendering fault, not as branding.
   */
  showMark?: boolean;
  status: CommandCenterBannerStatus;
  /** Short. "All clear", "11 approvals · 5 signals" — a state, never a sentence. */
  statusLabel: string;
}) {
  const isClear = status === "clear";

  return (
    <div className="relative overflow-hidden border-b-0 bg-slate-900 px-5 py-4 text-center">
      {/* Depth, back to front: a warm ember centred behind the nameplate so the bar is lit rather
          than flat, then a hairline top and bottom to frame it.

          `border-b-0` is load-bearing, not noise. This bar is a direct child of
          `divide-y divide-slate-200`, so the parent draws a slate-200 rule beneath it — and the
          very next band is another `bg-slate-900` bar. A light rule between two identical darks
          reads as a bright seam splitting what should be one block; it measured
          `oklch(0.929 0.011 86)` against bars otherwise byte-identical. Tailwind v4 wraps
          `divide-*` in `:where()`, so this plain utility outranks it with no `!`. The amber
          hairline below is the intended finish. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_58%_130%_at_50%_50%,rgba(249,115,22,0.09)_0%,rgba(249,115,22,0.03)_45%,transparent_76%)]"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent_0%,rgba(249,115,22,0.75)_50%,transparent_100%)]"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-[linear-gradient(90deg,transparent_0%,rgba(248,181,107,0.3)_50%,transparent_100%)]"
      />

      {/* `sm:px-16` reserves the right-hand lane for the absolutely-placed mark below, and only
          when there IS one. Without it a long name runs underneath the logo instead of wrapping
          clear of it — the mark cannot push text out of its way, because it is out of flow
          precisely so it cannot shift the centred name off-centre. */}
      <div
        className={
          showMark
            ? "relative flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 sm:px-16"
            : "relative flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5"
        }
      >
        <h2 className="bg-[linear-gradient(180deg,#FFFFFF_0%,#FFE7CF_60%,#F8B56B_100%)] bg-clip-text text-sm font-black uppercase tracking-[0.14em] text-transparent">
          {name}
        </h2>

        {/* Ornament, and ornament only — `hidden sm:block` because the row WRAPS at 375px and a
            separator that lands first on the second line reads as a dangling bullet. The three
            parts stay legible without it: a gold nameplate, a slate role, and a lit status. Same
            treatment `FinanceOwnerBanner` gives its own tapered rules and diamonds. */}
        <span aria-hidden="true" className="hidden h-1 w-1 rotate-45 bg-phx-accent sm:block" />

        <span className="text-phx-xs font-semibold uppercase tracking-[0.22em] text-slate-400">{roleLabel}</span>

        <span aria-hidden="true" className="hidden h-1 w-1 rotate-45 bg-phx-accent sm:block" />

        {/* An UPRIGHT square, and deliberately not `rounded-full`: `app/globals.css` zeroes
            border-radius on every element inside `.admin-shell` — a LOCKED house rule that names
            dots explicitly — so a rounded class here would compute to 0px anyway and read in the
            source as a circle that does not exist. Measured: `borderRadius: "0px"`.

            The shape still carries the meaning. The two separators beside it are the same square
            rotated 45°, so ornament reads as a diamond and this one, sitting square and lit,
            reads as a light reporting something. */}
        <span className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={
              isClear
                ? "h-1.5 w-1.5 bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]"
                : "h-1.5 w-1.5 bg-phx-accent shadow-[0_0_8px_rgba(249,115,22,0.95)]"
            }
          />
          <span
            className={
              isClear
                ? "text-phx-xs font-semibold uppercase tracking-[0.22em] text-emerald-300"
                : "text-phx-xs font-semibold uppercase tracking-[0.22em] text-[#F8B56B]"
            }
          >
            {statusLabel}
          </span>
        </span>
      </div>

      {/* Right corner, absolutely placed so it cannot shift the centred name off-centre. Hidden
          below `sm` because at 375px there is no lane to put it in. */}
      {showMark ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt="SATO Pharma"
          className="absolute right-5 top-1/2 hidden h-7 w-auto -translate-y-1/2 opacity-95 sm:block"
          src="/brand/sato-pharma-logo.png"
        />
      ) : null}
    </div>
  );
}
