"use client";

import { useEffect, useState } from "react";

import { CeoHeroClock } from "@/components/admin/ceo-hero-clock";
import { CeoHiddenNote } from "@/components/admin/ceo-hidden-note";
import { cn } from "@/lib/utils";

/** The CEO's own greeting — addressed to him by name, and only ever shown to him. */
function getCeoGreeting(hour: number) {
  if (hour < 12) return { line: "Good morning, Dr. Anwar —", sub: "Your company is awake and working for you." };
  if (hour < 17) return { line: "Good afternoon, Dr. Anwar —", sub: "Here is everything, exactly the way you like to see it." };
  return { line: "Good evening, Dr. Anwar —", sub: "A strong day. Let's close it well." };
}

/** Everyone else is greeted by their OWN name, with copy that fits their remit. */
function getGreeting(hour: number, name: string) {
  const who = name ? `, ${name}` : "";
  if (hour < 12) return { line: `Good morning${who} —`, sub: "Here is where sales and the field stand today." };
  if (hour < 17) return { line: `Good afternoon${who} —`, sub: "Here is where sales and the field stand today." };
  return { line: `Good evening${who} —`, sub: "A strong day. Let's close it well." };
}

/**
 * First name for the greeting. Arabic names here run long ("Khaled Mohamed Ali Bedair"), and the
 * greeting line must not wrap — the owner's standing rule is no wrapping and no ellipsis — so it
 * is addressed to the first given name only.
 */
function firstName(fullName: string): string {
  return String(fullName ?? "").trim().split(/\s+/)[0] ?? "";
}

/**
 * Premium executive identity block for the CEO hero — full name, title,
 * time-aware greeting, live Cairo clock, discreet hidden note, and (when
 * available) a large portrait bled off the right edge of the hero. All
 * time-sensitive parts run client-side to avoid SSR hydration mismatches;
 * the server renders a stable placeholder first.
 */
export function CeoHeroIdentity({
  fullName,
  roleLabel,
  imageUrl,
  /**
   * The CEO's personal hero: his own greeting and the note written for him. Off by default so a
   * new viewer of this component can never inherit either by accident — the SFE Manager was
   * being greeted "Good morning, Dr. Anwar" and handed a note addressed to the Chief Executive.
   */
  personal = false,
}: {
  fullName: string;
  roleLabel: string;
  imageUrl?: string | null;
  personal?: boolean;
}) {
  const [hour, setHour] = useState<number | null>(null);
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    function cairoHour() {
      const raw = new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hour12: false,
        timeZone: "Africa/Cairo",
      }).format(new Date());
      return Number(raw) % 24;
    }
    // Defer out of the synchronous effect body to satisfy react-hooks/set-state-in-effect.
    const id = setTimeout(() => setHour(cairoHour()), 0);
    return () => clearTimeout(id);
  }, []);

  const { line: greetLine, sub: greetSub } =
    hour !== null
      ? (personal ? getCeoGreeting(hour) : getGreeting(hour, firstName(fullName)))
      : {
          line: `Welcome, ${personal ? fullName : firstName(fullName)} —`,
          sub: personal
            ? "Here is everything, exactly the way you like to see it."
            : "Here is where sales and the field stand today.",
        };

  const showPhoto = Boolean(imageUrl) && !imgError;

  return (
    <>
      <div
        className={cn(
          "flex flex-col gap-6 sm:flex-row sm:items-start",
          showPhoto && "sm:pr-[34%] lg:pr-[30%]",
        )}
      >
        {/* ── Identity + greeting ───────────────────────────────────────────── */}
        <div className="min-w-0 flex-1">
          {/* Role label */}
          <p className="text-[8px] font-black uppercase tracking-[0.32em] text-orange-300/80">
            {roleLabel}
          </p>

          {/* Full name */}
          <h2 className="mt-1 text-[26px] font-black leading-none tracking-[-0.02em] text-white sm:text-[30px] lg:text-[32px]">
            {fullName}
          </h2>

          {/* Decorative divider */}
          <div className="my-3 flex items-center gap-3">
            <div className="h-px w-8 bg-orange-500" />
            <div className="h-px flex-1 bg-white/10" />
          </div>

          {/* Time-aware greeting + hidden note */}
          <div className="flex items-center gap-2.5">
            <p className="text-[15px] font-semibold leading-snug text-slate-100">{greetLine}</p>
            {personal ? <CeoHiddenNote /> : null}
          </div>

          {/* Sub-greeting */}
          <p className="mt-1.5 max-w-md text-sm leading-relaxed text-slate-400">{greetSub}</p>

          {/* Live Cairo clock */}
          <div className="mt-4 flex w-fit items-center border border-white/10 bg-white/[0.04] text-xs">
            <CeoHeroClock />
          </div>
        </div>
      </div>

      {/* ── Executive portrait — flush with the hero's top edge, bled slightly off the bottom
          (clipped by the hero's own overflow-hidden), does not affect the hero's height ── */}
      {showPhoto ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-[47px] top-0 bottom-[-4%] hidden max-w-[46%] items-end justify-end sm:flex"
        >
          {/* A warm glow behind the subject so a dark studio portrait separates from the dark
              hero instead of dissolving into it. Non-personal heroes only — the CEO's banner
              is deliberately left exactly as it was. */}
          {!personal ? (
            <span
              aria-hidden="true"
              className="absolute bottom-0 right-[6%] h-[78%] w-[70%] rounded-full bg-[radial-gradient(ellipse_at_center,rgba(249,115,22,0.20)_0%,rgba(249,115,22,0.07)_45%,transparent_72%)] blur-2xl"
            />
          ) : null}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl!}
            alt=""
            onError={() => setImgError(true)}
            className={cn(
              "relative h-full w-auto max-w-none object-contain object-bottom",
              // In-app "polish": a contrast/saturation lift so the portrait matches the hero's
              // amber grade, and a two-axis fade. The LEFT fade matters most — this asset is a
              // rectangular photo with its own dark studio background, so without it the frame
              // ends on a visible vertical seam instead of dissolving into the hero. This is a
              // CSS grade, not a retouch of the file.
              !personal &&
                "[filter:contrast(1.07)_saturate(1.1)_brightness(1.05)] [mask-image:linear-gradient(to_right,transparent_0%,rgba(0,0,0,0.35)_10%,#000_34%),linear-gradient(to_bottom,#000_0%,#000_80%,rgba(0,0,0,0.5)_92%,transparent_100%)] [mask-composite:intersect] [-webkit-mask-composite:source-in]",
            )}
          />
        </div>
      ) : null}
    </>
  );
}
