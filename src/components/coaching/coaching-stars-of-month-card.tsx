"use client";

import { useState } from "react";
import { Star } from "lucide-react";

import {
  coachingZoneLabel,
  getCoachingScoreColor,
} from "@/lib/coaching/landing-insights";
import type { CoachingPerformanceZone } from "@/lib/coaching/types";

export type CoachingStarOfMonth = {
  hrId: string;
  name: string;
  photoSrc: string | null;
  scorePercent: number;
  zone: CoachingPerformanceZone | null;
};

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return `${first}${last}`.toUpperCase();
}

const AVATAR_SIZE = "h-32 w-32 sm:h-36 sm:w-36";

function StarAvatar({ src, name }: { src: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className={`flex ${AVATAR_SIZE} items-center justify-center rounded-lg border-2 border-orange-200 bg-slate-100 text-3xl font-black text-slate-500`}>
        {initialsFor(name)}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- same-origin photo route / bundled asset, cropped square
    <img
      alt={name}
      className={`${AVATAR_SIZE} rounded-lg border-2 border-orange-200 object-cover object-top`}
      onError={() => setFailed(true)}
      src={src}
    />
  );
}

/**
 * "Stars of the Month" — a photo-forward showcase of the previous month's top
 * coaching performers (medical reps with the highest coaching scores), framed in
 * the portal's premium design language. Renders nothing when there are no stars.
 */
export function CoachingStarsOfMonthCard({
  stars,
  monthLabel,
}: {
  stars: CoachingStarOfMonth[];
  monthLabel: string;
}) {
  if (stars.length === 0) return null;

  return (
    <div className="overflow-hidden border border-slate-200 bg-white" role="region" aria-label="Stars of the month">
      <div className="flex items-center justify-between bg-slate-900 px-5 py-3">
        <h2 className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-300">
          <Star className="h-3.5 w-3.5 text-orange-400" />
          Stars of the Month · {monthLabel}
        </h2>
        <div className="h-1.5 w-12 bg-orange-500" />
      </div>
      <div className="flex flex-wrap justify-center gap-6 px-5 py-6 sm:justify-start sm:gap-8">
        {stars.map((star, index) => (
          <div key={star.hrId} className="flex w-36 flex-col items-center gap-2 text-center sm:w-40">
            <div className="relative">
              <StarAvatar name={star.name} src={star.photoSrc} />
              <span
                className={`absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-md text-xs font-black text-white shadow ${
                  index === 0 ? "bg-orange-500" : "bg-slate-700"
                }`}
              >
                {index + 1}
              </span>
            </div>
            <p className="whitespace-nowrap text-xs font-bold text-slate-900">{star.name}</p>
            <p
              className="whitespace-nowrap text-sm font-black tabular-nums"
              style={{ color: getCoachingScoreColor(star.scorePercent) }}
            >
              {star.scorePercent.toFixed(1)}%
            </p>
            <p className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {coachingZoneLabel(star.zone)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
