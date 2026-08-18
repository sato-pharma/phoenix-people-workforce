"use client";

import { useState } from "react";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";

// The one employee avatar. Extracted verbatim from the Stars of the Month card so the winner panel,
// the landing card and the race rows share one implementation at three sizes — three copies of the
// same onError fallback is how they drift.
//
// It takes an already-resolved `src`. It must NEVER import src/lib/employees/employee-photo.ts:
// that module pulls node:crypto and the Supabase admin client, and importing it from a client
// component fails the webpack build.

export type PersonPhotoSize = "xl" | "md" | "sm";

const SIZE_CLASS: Record<PersonPhotoSize, string> = {
  xl: "h-32 w-32 sm:h-36 sm:w-36",
  md: "h-20 w-20",
  sm: "h-9 w-9",
};

const FALLBACK_TEXT_CLASS: Record<PersonPhotoSize, string> = {
  xl: "text-3xl",
  md: "text-lg",
  sm: "text-[10px]",
};

export function personInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return `${first}${last}`.toUpperCase();
}

export function PersonPhoto({
  src,
  name,
  size = "md",
}: {
  src: string | null;
  name: string;
  size?: PersonPhotoSize;
}) {
  const [failed, setFailed] = useState(false);
  const dimensions = SIZE_CLASS[size];

  if (!src || failed) {
    return (
      <div
        aria-label={name}
        className={`flex ${dimensions} shrink-0 items-center justify-center rounded-lg border-2 border-orange-200 bg-slate-100 ${FALLBACK_TEXT_CLASS[size]} font-black text-slate-500`}
        role="img"
      >
        {personInitials(name)}
      </div>
    );
  }

  return (
    // The avatar is square-cropped to as little as 32px, so the face is often cut off. Tapping it
    // opens the whole photo uncropped.
    <ZoomablePhoto
      alt={name}
      caption={name}
      className={`${dimensions} shrink-0 rounded-lg border-2 border-orange-200 object-cover object-top`}
      onError={() => setFailed(true)}
      src={src}
    />
  );
}
