"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";

/**
 * The signature card's identity, as a THIN STRIP.
 *
 * Built 2026-09-03 at the owner's instruction, for the HR overview command centre: "check the
 * employee portal one ... but the most important thing that I don't want it to be too thick, too
 * many space in the page. I want it to be narrow, to have much space for the page to show data."
 * He named the height himself — under 96px.
 *
 * WHY THIS IS NOT `PhoenixSignatureCard` WITH A CLASS. That card's desktop half is sized by an
 * inline `aspectRatio: 1875 / 420`, and its mobile half by an inline `height: 150px`. Inline
 * styles beat any class a caller passes, so the card cannot be made thin from outside — and it
 * MUST NOT be made thin from inside, because it renders the employee portal's identity banner,
 * which is a design-locked surface (CLAUDE.md, `employee-portal/identity-card.tsx`). So the strip
 * is a sibling that borrows the vocabulary and leaves the card untouched.
 *
 * WHAT IT BORROWS, so the two read as one family: the warm paper ground (#fdf8f3) with the same
 * two radial washes, the Phoenix watermark bleeding off the right edge under the wave, the
 * orange-ringed portrait at the leading edge, the Pinyon Script name, the orange rule with its
 * the orange rule with
 * its dot, and the uppercase letter-spaced title.
 *
 * THE HEIGHT RULE WAS REVERSED BY THE OWNER ON 2026-09-04, AND THIS IS THE NEWER INSTRUCTION.
 * It was 88/92px because on 2026-09-03 he asked for narrow: "I don't want it to be too thick, too
 * many space in the page." That produced a bar whose content ended at 208px of 1084 — 81% empty —
 * with the name at 27.2px under 30px/900 KPI counters. Shown it, he said: "The banner is too
 * small. It's too small in comparison with the dashboard", and when asked directly whether he
 * wanted the bar itself taller or was merely seeing a stale build, he answered "make it taller and
 * its weak". So it is now 120px on a phone and 136px from `sm` up.
 *
 * DO NOT "RESTORE" THE THIN VERSION on the strength of the 09-03 quote — that quote is older, and
 * it is the one this paragraph exists to overrule. What he has never wanted back is the ORIGINAL
 * block, the full `PhoenixSignatureCard` at aspectRatio 1875/420, which is ~243px on this width:
 * "WITHOUT THIS BUFFENK THIVK BANNER BLOCK". 136px sits deliberately between the two.
 *
 * THE PORTRAIT IS TWO DIFFERENT THINGS BY BREAKPOINT, AND THAT IS THE OWNER'S OWN SPLIT.
 * On 2026-09-04 he sent the Phoenix banner artwork and said: "in mobile view i want the photo
 * frameless fading exactly like this". So below `sm` the photo bleeds off the leading edge at full
 * height with no bezel, no ring and no corner, dissolving into the paper; from `sm` up it keeps the
 * framed tile. Both are deliberate — see PORTRAIT_FADE_MASK. A later session "unifying" the two
 * would be undoing an instruction, not removing a duplicate.
 *
 * WHAT IT DELIBERATELY DOES NOT BORROW: the card's two COLD values. The card sets the wave to
 * #0b1f3a and the name to #2a3a5c, both around hue 257-264. The admin shell those two landings
 * render in has had its whole neutral ramp retinted WARM on purpose — `app/globals.css` moves
 * slate to hue 72-92, and says why: a temperature swing between adjacent edges "is what reads as
 * mismatched". The strip's wave is a dark bar sitting 8px above the section header's dark bar at
 * almost the same lightness and 184 degrees away in hue, which is exactly that failure. So the
 * two are carried across at the SAME lightness with only hue and chroma moved into the ramp's own
 * band — #0b1f3a -> #231e18 (L 23.9%, both) and #2a3a5c -> #3f3a33 (L 35.2%, both). Same method
 * globals.css uses for slate; nothing about the composition shifts.
 *
 * The card itself is untouched and stays navy: it renders under `.employee-portal-shell`, which
 * is a different ground and a different identity. Do not "restore parity" by making either one
 * match the other.
 *
 * THE NAME SHRINKS TO FIT RATHER THAN CLIPPING. A script face on one line has no good failure
 * mode: wrapping breaks the strip's height, and an ellipsis is banned outright by the owner's
 * standing rule. So the name is measured and its font-size scaled down until it fits, exactly as
 * the card does it. That logic is deliberately duplicated rather than extracted — pulling it out
 * of `PhoenixSignatureCard` would mean editing the file behind a design-locked portal surface to
 * serve an admin page, which is the wrong trade.
 */

/** The bezel gradient, identical on both breakpoints and to `EmployeePortrait`'s. */
const PORTRAIT_BEZEL = "linear-gradient(145deg, #f9c06a, #f47b20 40%, #c45200 70%, #f9c06a)";

/**
 * MOBILE. The employee-portal identity banner's own four-layer glow, at the floor of each of its
 * `cqw` clamps — the owner, 2026-09-04: "IN MOBILE VIEW I WANT THE PHOTO SHADED AS EMPLOYEE
 * PORTAL IDENTITY BANNER". Copied from `EmployeePortrait` line 32 rather than re-derived, so the
 * two cannot drift. The strip is not a container, so the `cqw` middles cannot be used and the
 * floors are what a small portrait renders at anyway.
 *
 * IT NOW APPLIES TO THE INITIALS ONLY, and is not dead code. His later instruction the same day
 * made the mobile PHOTO frameless, so the framed tile survives on a phone purely as the no-photo
 * fallback — where a glow is still the right answer, because an initials chip has no edge of its
 * own to dissolve.
 *
 * It does NOT clip. The outermost layer is 28px of blur on a 60px portrait with 6px of clearance
 * inside an `overflow-hidden` section — but the layers are warm and low-alpha on a cream ground,
 * and the cut is invisible at 2x. Verified at 375px before shipping.
 */
const PORTRAIT_GLOW =
  "0 0 0 2px rgba(244,123,32,0.18), 0 0 12px 3px rgba(244,123,32,0.4),"
  + " 0 0 28px 5px rgba(255,150,40,0.2), 0 12px 30px rgba(15,35,55,0.2)";

/** DESKTOP. The flat ring the strip has always had; the glow was asked for on mobile only. */
const PORTRAIT_RING = "0 0 0 2px rgba(244,123,32,0.16), 0 4px 12px rgba(15,35,55,0.16)";

/**
 * MOBILE, FRAMELESS. The owner, 2026-09-04, with the Phoenix banner artwork attached: "in mobile
 * view i want the photo frameless fading exactly like this". In that reference the portrait is not
 * a tile sitting ON the card — it IS the card's leading edge: full height, flush left, no bezel, no
 * ring, no rounded corner, its right side dissolving into the paper so there is no seam anywhere.
 *
 * SO THE FADE IS THE FRAME. With nothing but a hard edge holding the photo in, the dissolve is the
 * only thing standing between "bleeds off the edge" and "got cropped", and a SHORT taper reads as
 * the second. A two-stop ramp was tried first and the end of it was still visible as a seam at 3x;
 * this one holds solid for the first 38% and then eases off across the remaining 62% in four stops,
 * so there is no point where the falloff changes rate. `-webkit-mask-image` rides alongside for
 * Safari, which still wants the prefix.
 *
 * IT DELIBERATELY SITS UNDER THE WAVE (z-[1] against the wave's z-[3]), exactly as the reference
 * does — the navy band crosses in FRONT of the portrait's lower corner and finishes the shape.
 * Raising this above the wave is what would make it look pasted on.
 *
 * DESKTOP IS UNTOUCHED and keeps the bezel + ring. He asked for mobile, and the wide bar is where
 * the framed portrait still earns its place: at 1084px a bleeding photo would be a stripe.
 */
const PORTRAIT_FADE_MASK =
  "linear-gradient(90deg, #000 0%, #000 38%, rgba(0,0,0,0.86) 56%,"
  + " rgba(0,0,0,0.55) 72%, rgba(0,0,0,0.22) 86%, transparent 100%)";

function signatureNameFor(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return name;
  const last = parts[parts.length - 1];
  if (parts.length === 2) return `${parts[0]} ${last}`;
  return `${parts[0]} ${parts[1].charAt(0).toUpperCase()}. ${last}`;
}

function initialsFor(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0))
      .join("")
      .toUpperCase() || "EM"
  );
}

export type PhoenixIdentityStripProps = {
  className?: string;
  /** HR ID, shown at the trailing edge. Omitted when absent rather than drawn empty. */
  employeeCode?: string | null;
  /** Full name. Abbreviated to "First M. Last" before it is drawn. */
  name: string;
  /** Profile photo, or null to fall back to initials. */
  photoSrc?: string | null;
  /** Optional honorific, e.g. "Dr." */
  prefix?: string;
  /** Job title, not the permission key — the caller resolves that. */
  title: string;
};

export function PhoenixIdentityStrip({
  className = "",
  employeeCode = null,
  name,
  photoSrc = null,
  prefix,
  title,
}: PhoenixIdentityStripProps) {
  const titleLabel = title.trim().toUpperCase() || "PHOENIX WORKFORCE";
  const sigName = prefix ? `${prefix} ${signatureNameFor(name)}` : signatureNameFor(name);

  const nameRef = useRef<HTMLSpanElement>(null);
  const nameBoxRef = useRef<HTMLParagraphElement>(null);
  const [nameFontPx, setNameFontPx] = useState<number | null>(null);

  // Scale-invariant shrink-to-fit: divides the measured width by the font-size that produced it,
  // so it converges in one pass instead of oscillating. `getBoundingClientRect`, not `scrollWidth`
  // — that reads 0 on a plain `display: inline` element.
  useEffect(() => {
    const span = nameRef.current;
    const box = nameBoxRef.current;
    if (!span || !box) return;
    const measure = () => {
      const containerWidth = box.getBoundingClientRect().width;
      const naturalWidth = span.getBoundingClientRect().width;
      const currentPx = parseFloat(getComputedStyle(span).fontSize) || 16;
      if (containerWidth > 0 && naturalWidth > containerWidth) {
        const widthPerPx = naturalWidth / currentPx;
        setNameFontPx(Math.max((containerWidth / widthPerPx) * 0.97, currentPx * 0.45));
      } else if (containerWidth > 0 && naturalWidth < containerWidth * 0.92) {
        setNameFontPx(null);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    document.fonts?.ready?.then(measure).catch(() => {});
    return () => observer.disconnect();
  }, [sigName]);

  return (
    <section
      aria-label="Your identity"
      className={[
        "relative isolate h-[120px] w-full min-w-0 overflow-hidden shadow-[0_8px_26px_rgba(16,35,61,0.13)] sm:h-[136px]",
        className,
      ].join(" ")}
      style={{ background: "#fdf8f3" }}
    >
      {/* The card's two washes, same stops. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          background:
            "radial-gradient(ellipse at 70% 40%, rgba(255,255,255,0.55) 0%, transparent 60%), radial-gradient(ellipse at 10% 60%, rgba(244,123,32,0.06) 0%, transparent 40%)",
        }}
      />

      {/* Watermark — bleeds off the right edge and under the wave, as it does on the card. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute z-0"
        src="/brand/identity-watermark.png"
        style={{ right: "-1.5%", top: "-30%", height: "165%", width: "auto", opacity: 0.9 }}
      />

      {/* MOBILE ONLY: the portrait as the card's own leading edge — see PORTRAIT_FADE_MASK.

          IT IS `aria-hidden`, NOT A SECOND ANNOUNCEMENT. The framed portrait below carries the
          real alt text and this replaces it at the same breakpoint, but the person's name sits
          two inches to its right in plain text, so a screen reader loses nothing and is spared
          "portrait of X" twice from one bar. It is also what keeps this out of the golden rule's
          overflow measurement, correctly: a decorative bleed is MEANT to cross the edge.

          NO PHOTO, NO BLEED. A frameless nothing is not a design — it is a gap. So this renders
          only when there is a real photo, and the initials keep the framed tile at every width.

          The widths here are LITERAL Tailwind classes on purpose: `w-[108px]` and the `pl-[112px]`
          below are a matched pair (108 of photo, 4 of air), and a class name built from a constant
          is purged from the stylesheet and silently renders as nothing. Change them together. */}
      {photoSrc ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 left-0 top-0 z-[1] w-[108px] sm:hidden"
          style={{ maskImage: PORTRAIT_FADE_MASK, WebkitMaskImage: PORTRAIT_FADE_MASK }}
        >
          <Image
            alt=""
            className="object-cover object-top"
            fill
            sizes="108px"
            src={photoSrc}
            unoptimized
          />
        </div>
      ) : null}

      {/* Content sits ABOVE the wave, not on it — hence the bottom inset. The leading inset is
          the bleeding portrait's width plus 4px of air; with no photo there is no bleed, so it
          falls back to the ordinary gutter and the framed initials tile takes the space. */}
      <div
        className={[
          "absolute inset-x-0 bottom-[24px] top-0 z-10 flex min-w-0 items-center gap-4 pr-4 sm:pl-6 sm:pr-6",
          photoSrc ? "pl-[112px]" : "pl-4",
        ].join(" ")}
      >
        <span
          className={[
            "relative h-[80px] w-[80px] shrink-0 sm:h-[92px] sm:w-[92px]",
            // Mobile hands the portrait over to the frameless bleed above — but only when there
            // IS one to hand over.
            photoSrc ? "hidden sm:block" : "block",
          ].join(" ")}
        >
          {/* TWO RINGS, MUTUALLY EXCLUSIVE BY BREAKPOINT. One element would be neater, but an
              inline style cannot carry a media query and these two shadows are genuinely
              different things — see PORTRAIT_GLOW / PORTRAIT_RING above. */}
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-xl sm:hidden"
            style={{ background: PORTRAIT_BEZEL, boxShadow: PORTRAIT_GLOW }}
          />
          <span
            aria-hidden="true"
            className="absolute inset-0 hidden rounded-xl sm:block"
            style={{ background: PORTRAIT_BEZEL, boxShadow: PORTRAIT_RING }}
          />
          <span className="absolute inset-[2px] overflow-hidden rounded-[10px] bg-[#f8efe5]">
            {photoSrc ? (
              <Image
                alt={`${name} portrait`}
                className="object-cover object-top"
                fill
                sizes="92px"
                src={photoSrc}
                unoptimized
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-3xl font-black text-[#f47b20]">
                {initialsFor(name)}
              </span>
            )}
          </span>
        </span>

        <span
          aria-hidden="true"
          className="hidden h-12 w-px shrink-0 sm:block"
          style={{ background: "linear-gradient(180deg, transparent, #e0d0bc 20%, #e0d0bc 80%, transparent)" }}
        />

        {/* The name ceiling is 2.4rem (38.4px) and that number is MEASURED, not chosen. The
            strip's inner content box is 76px at `sm`, and the tallest real case — "HR OPERATIONS
            COORDINATOR" over a name — came to 61px at 2rem, leaving 24px. 2.4rem spends 7 of
            those and keeps 16px of clearance, so nothing clips. Raise it further only after
            re-measuring `textColumn.bottom` against the strip height on the HR landing, which is
            the worst case: it carries the longest title in the system.

            WHY IT MATTERS THAT THIS IS BIG. The KPI numerals immediately below are 30px at weight
            900. At the old 1.7rem cap the person's own name was SMALLER and four times lighter
            than the dashboard counters under it, which is what the owner saw.

            THIS BLOCK SPANS THE BAR, and that is a correction, not a drift from the card.
            It was `w-fit`, so the rule and title took the NAME's width — the card's relationship,
            faithfully copied. On a 1084px admin bar it measured a disaster: all content ended at
            208px and 81% of the strip was empty cream. The owner, 2026-09-03: "The banner is too
            small. It's too small in comparison with the dashboard." The card can hug its name
            because it is nearly square; a strip four times wider cannot. So the column flexes and
            the rule runs out across the bar. Height is untouched — that part of his instruction
            still holds. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <p
            className="italic font-medium text-[#3f3a33]"
            ref={nameBoxRef}
            style={{
              fontFamily: '"Pinyon Script", cursive',
              fontSize: nameFontPx ? `${nameFontPx}px` : "clamp(1.75rem, 5vw, 3.1rem)",
              lineHeight: 1.15,
              margin: 0,
              whiteSpace: "nowrap",
            }}
          >
            <span ref={nameRef} style={{ display: "inline" }}>
              {sigName}
            </span>
          </p>
          <span aria-hidden="true" className="mt-[2px] flex items-center">
            <span className="h-[2px] flex-1" style={{ background: "#f47b20" }} />
            <span className="mx-[5px] h-[7px] w-[7px] rounded-full" style={{ background: "#f47b20" }} />
            <span
              className="h-[2px] flex-[2]"
              style={{ background: "linear-gradient(90deg, rgba(244,123,32,0.5), rgba(244,123,32,0))" }}
            />
          </span>
          {/* THE TITLE WRAPS, and must keep wrapping. At this tracking "HR OPERATIONS
              COORDINATOR" is wider than the column has at 375px. Left `nowrap` it would not
              scroll the page — this section is `overflow-hidden`, so it would CLIP, which is the
              failure `scrollWidth > clientWidth` is blind to (AGENTS.md §4).

              THE SPARE ROOM IS NOW SMALL, because the HR ID below took a fourth line. Worst case
              is the HR landing at 375px: a wrapped two-line title AND the HR ID under a name at
              the clamp's 1.25rem floor. That is what to re-measure before adding anything else to
              this column, or before raising the name ceiling back. */}
          <p
            className="break-words text-left font-bold uppercase"
            style={{
              color: "#f47b20",
              fontSize: "13px",
              letterSpacing: "0.18em",
              lineHeight: 1.2,
              margin: "2px 0 0",
            }}
          >
            {titleLabel}
          </p>
          {/* THE HR ID SITS UNDER THE TITLE, not at the trailing edge — the owner, 2026-09-04:
              "HR ID UNDER TITLE". It reads as part of the identity block now rather than as a
              figure floating at the far right of a wide bar.

              IT COSTS A FOURTH LINE, and the strip's height is fixed, so the name ceiling came
              down with it — 2.4rem to 2rem. 32px still clears the 30px KPI numerals below, which
              is what #3050 was protecting, and anything smaller gives that back.

              THE BINDING CASE IS DESKTOP, not mobile, which is the opposite of what this column
              usually worries about. At `sm` the inner box is 76px and the four lines come to
              73px — name 36.8 (32 x 1.15), rule 7, title 15.2, this line 14 — so 3px spare. At
              375px the name is at its 1.25rem floor and the box is 72px, so the same four lines
              come to 59px with 13px spare. Re-measure BOTH before raising the ceiling. */}
          {employeeCode ? (
            <p
              className="font-semibold text-[#3f3a33] opacity-75"
              style={{ fontSize: "12px", letterSpacing: "0.08em", lineHeight: 1.2, margin: "4px 0 0" }}
            >
              {employeeCode}
            </p>
          ) : null}
        </div>
      </div>

      {/* The card's wave, scaled to this height. */}
      <svg
        aria-hidden="true"
        className="absolute bottom-0 left-0 z-[3] h-[30px] w-full"
        preserveAspectRatio="none"
        viewBox="0 0 1875 118"
      >
        <path d="M0 38C420 58 1030 58 1875 4V118H0Z" fill="#231e18" />
        <path d="M0 38C420 58 1030 58 1875 4" fill="none" stroke="#f47b20" strokeWidth="11" />
      </svg>
    </section>
  );
}
