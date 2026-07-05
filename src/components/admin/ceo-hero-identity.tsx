"use client";

import { useEffect, useState } from "react";

import { CeoHeroClock } from "@/components/admin/ceo-hero-clock";
import { CeoHiddenNote } from "@/components/admin/ceo-hidden-note";
import { cn } from "@/lib/utils";

function getGreeting(hour: number) {
  if (hour < 12) return { line: "Good morning, Dr. Anwar —", sub: "Your company is awake and working for you." };
  if (hour < 17) return { line: "Good afternoon, Dr. Anwar —", sub: "Here is everything, exactly the way you like to see it." };
  return { line: "Good evening, Dr. Anwar —", sub: "A strong day. Let's close it well." };
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
}: {
  fullName: string;
  roleLabel: string;
  imageUrl?: string | null;
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
      ? getGreeting(hour)
      : { line: `Welcome, ${fullName} —`, sub: "Here is everything, exactly the way you like to see it." };

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
            <CeoHiddenNote />
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
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl!}
            alt=""
            onError={() => setImgError(true)}
            className="h-full w-auto max-w-none object-contain object-bottom"
          />
        </div>
      ) : null}
    </>
  );
}
