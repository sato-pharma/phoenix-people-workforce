"use client";

import { useEffect, useState } from "react";

import { CeoHeroClock } from "@/components/admin/ceo-hero-clock";
import { CeoHiddenNote } from "@/components/admin/ceo-hidden-note";

function getGreeting(hour: number) {
  if (hour < 12) return { line: "Good morning, Dr. Anwar —", sub: "Your company is awake and working for you." };
  if (hour < 17) return { line: "Good afternoon, Dr. Anwar —", sub: "Here is everything, exactly the way you like to see it." };
  return { line: "Good evening, Dr. Anwar —", sub: "A strong day. Let's close it well." };
}

/**
 * Premium executive identity block for the CEO hero — portrait (or corporate
 * monogram), full name, title, time-aware greeting, live Cairo clock, and the
 * discreet hidden note. All time-sensitive parts run client-side to avoid SSR
 * hydration mismatches; the server renders a stable placeholder first.
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

  // Two-letter corporate monogram from the last two name tokens (e.g. "AG" for "Dr. Anwar Gaweesh")
  const initials = fullName
    .split(" ")
    .filter((w) => /^[A-Za-z]/.test(w))
    .slice(-2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  return (
    <div className="flex flex-col gap-6 sm:flex-row sm:items-start">

      {/* ── Square executive portrait ─────────────────────────────────────── */}
      <div className="relative shrink-0 self-start">
        {/* Main frame — square, no rounded corners, 2px orange ring */}
        <div className="flex h-[108px] w-[108px] items-center justify-center border-2 border-orange-400 bg-slate-800 sm:h-[128px] sm:w-[128px]">
          {showPhoto ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl!}
              alt={fullName}
              onError={() => setImgError(true)}
              className="h-full w-full object-cover object-[center_18%]"
            />
          ) : (
            <span className="text-[34px] font-black tracking-tight text-orange-400 sm:text-[40px]">
              {initials}
            </span>
          )}
        </div>
        {/* Orange corner accent mark */}
        <div className="absolute -bottom-1.5 -right-1.5 h-4 w-4 bg-orange-500" />
      </div>

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
  );
}
