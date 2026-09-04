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
 * dot, and the uppercase letter-spaced title. Same parts, one quarter of the height: 88px on a
 * phone, 92px from `sm` up, both fixed.
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
 * It does NOT clip. The outermost layer is 28px of blur on a 60px portrait with 6px of clearance
 * inside an `overflow-hidden` section — but the layers are warm and low-alpha on a cream ground,
 * and the cut is invisible at 2x. Verified at 375px before shipping.
 */
const PORTRAIT_GLOW =
  "0 0 0 2px rgba(244,123,32,0.18), 0 0 12px 3px rgba(244,123,32,0.4),"
  + " 0 0 28px 5px rgba(255,150,40,0.2), 0 12px 30px rgba(15,35,55,0.2)";

/** DESKTOP. The flat ring the strip has always had; the glow was asked for on mobile only. */
const PORTRAIT_RING = "0 0 0 2px rgba(244,123,32,0.16), 0 4px 12px rgba(15,35,55,0.16)";

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
        "relative isolate h-[88px] w-full min-w-0 overflow-hidden shadow-[0_6px_20px_rgba(16,35,61,0.10)] sm:h-[92px]",
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

      {/* Content sits ABOVE the wave, not on it — hence the bottom inset. */}
      <div className="absolute inset-x-0 bottom-[16px] top-0 z-10 flex min-w-0 items-center gap-3 px-3 sm:px-4">
        <span className="relative block h-[60px] w-[60px] shrink-0 sm:h-[66px] sm:w-[66px]">
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
                sizes="66px"
                src={photoSrc}
                unoptimized
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-lg font-black text-[#f47b20]">
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
              fontSize: nameFontPx ? `${nameFontPx}px` : "clamp(1.25rem, 4.2vw, 2rem)",
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
            <span className="h-px flex-1" style={{ background: "#f47b20" }} />
            <span className="mx-[3px] h-[5px] w-[5px] rounded-full" style={{ background: "#f47b20" }} />
            <span
              className="h-px flex-[2]"
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
              fontSize: "11px",
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
              style={{ fontSize: "10px", letterSpacing: "0.08em", lineHeight: 1.2, margin: "2px 0 0" }}
            >
              {employeeCode}
            </p>
          ) : null}
        </div>
      </div>

      {/* The card's wave, scaled to this height. */}
      <svg
        aria-hidden="true"
        className="absolute bottom-0 left-0 z-[3] h-[20px] w-full"
        preserveAspectRatio="none"
        viewBox="0 0 1875 118"
      >
        <path d="M0 38C420 58 1030 58 1875 4V118H0Z" fill="#231e18" />
        <path d="M0 38C420 58 1030 58 1875 4" fill="none" stroke="#f47b20" strokeWidth="9" />
      </svg>
    </section>
  );
}
