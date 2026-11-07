"use client";

// The interview calendar's place for an in-person interview (owner's email of 8 Nov 2026, §5: "the
// interview date, time, and location must be clearly specified"). Optional: blank keeps the usual
// venue, so every interview books exactly as before. Shared by the cell dialog and the schedule
// dialog, so the two spell it the same.
//
// The Medical Rep ROUND is not offered here on purpose. A round is booked only from the Medical Rep
// Hiring page (src/lib/recruitment/mr-hiring/book.ts), which checks the step comes next, sends the CV
// to the DSM and tells the interviewer; a round set on the calendar would skip all three.

import { phxFieldClassName, phxLabelTextClassName } from "@/components/ui/form-tokens";
import type { InterviewPlatform } from "@/lib/recruitment/interview-calendar-types";
import { MR_LOCATION_LIMIT } from "@/lib/recruitment/mr-hiring/vocabulary";

export function InterviewLocationField({
  location,
  onLocation,
  platform,
}: {
  location: string;
  onLocation: (value: string) => void;
  platform: InterviewPlatform | null;
}) {
  if (platform !== "in_office") return null;
  return (
    <label className="block">
      <span className={phxLabelTextClassName}>Location (optional)</span>
      <input
        autoComplete="off"
        className={`${phxFieldClassName} mt-1 block`}
        maxLength={MR_LOCATION_LIMIT}
        onChange={(event) => onLocation(event.target.value)}
        placeholder="Blank means the usual interview venue"
        value={location}
      />
    </label>
  );
}
