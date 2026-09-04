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
 * two radial washes, the Phoenix watermark bleeding off the right edge under the navy wave, the
 * orange-ringed portrait at the leading edge, the Pinyon Script name in navy, the orange rule with
 * its dot, and the uppercase letter-spaced title. Same parts, one quarter of the height: 88px on a
 * phone, 92px from `sm` up, both fixed.
 *
 * THE NAME SHRINKS TO FIT RATHER THAN CLIPPING. A script face on one line has no good failure
 * mode: wrapping breaks the strip's height, and an ellipsis is banned outright by the owner's
 * standing rule. So the name is measured and its font-size scaled down until it fits, exactly as
 * the card does it. That logic is deliberately duplicated rather than extracted — pulling it out
 * of `PhoenixSignatureCard` would mean editing the file behind a design-locked portal surface to
 * serve an admin page, which is the wrong trade.
 */

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
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-xl"
            style={{
              background: "linear-gradient(145deg, #f9c06a, #f47b20 40%, #c45200 70%, #f9c06a)",
              boxShadow: "0 0 0 2px rgba(244,123,32,0.16), 0 4px 12px rgba(15,35,55,0.16)",
            }}
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
            className="italic font-medium text-[#2a3a5c]"
            ref={nameBoxRef}
            style={{
              fontFamily: '"Pinyon Script", cursive',
              fontSize: nameFontPx ? `${nameFontPx}px` : "clamp(1.35rem, 4.2vw, 2.4rem)",
              lineHeight: 1.15,
              margin: 0,
              whiteSpace: "nowrap",
            }}
          >
            <span ref={nameRef} style={{ display: "inline" }}>
              {sigName}
            </span>
          </p>
          <span aria-hidden="true" className="mt-[3px] flex items-center">
            <span className="h-px flex-1" style={{ background: "#f47b20" }} />
            <span className="mx-[3px] h-[5px] w-[5px] rounded-full" style={{ background: "#f47b20" }} />
            <span
              className="h-px flex-[2]"
              style={{ background: "linear-gradient(90deg, rgba(244,123,32,0.5), rgba(244,123,32,0))" }}
            />
          </span>
          {/* THE TITLE WRAPS, and must keep wrapping. At 0.2em tracking "HR OPERATIONS
              COORDINATOR" is about 200px, wider than the name above it and wider than the column
              has at 375px. Left `nowrap` it would not scroll the page — this section is
              `overflow-hidden`, so it would CLIP, which is the failure `scrollWidth > clientWidth`
              is blind to (AGENTS.md §4). Two wrapped lines cost 12px and the box has 16px spare at
              its tightest. */}
          <p
            className="break-words text-left font-bold uppercase"
            style={{
              color: "#f47b20",
              fontSize: "11px",
              letterSpacing: "0.18em",
              lineHeight: 1.2,
              margin: "3px 0 0",
            }}
          >
            {titleLabel}
          </p>
        </div>

        {employeeCode ? (
          <span className="ml-auto shrink-0 pl-3 text-[12px] font-semibold text-[#2a3a5c] opacity-80">
            {employeeCode}
          </span>
        ) : null}
      </div>

      {/* The card's wave, scaled to this height. */}
      <svg
        aria-hidden="true"
        className="absolute bottom-0 left-0 z-[3] h-[20px] w-full"
        preserveAspectRatio="none"
        viewBox="0 0 1875 118"
      >
        <path d="M0 38C420 58 1030 58 1875 4V118H0Z" fill="#0b1f3a" />
        <path d="M0 38C420 58 1030 58 1875 4" fill="none" stroke="#f47b20" strokeWidth="9" />
      </svg>
    </section>
  );
}
