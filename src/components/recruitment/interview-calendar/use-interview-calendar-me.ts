"use client";

// Who the viewer is on the interview calendar — asked once per page, however many CV surfaces on it
// want to know whether to draw the Schedule interview button.
//
// A screen can hold dozens of those buttons (one per row on WhatsApp Applicants), and each one asking
// the server separately would be dozens of identical requests. So the answer is cached for the life
// of the page, and requests made while one is already in flight share it. A failed read is NOT
// cached: it answers "no button" this time and the next screen asks again.

import { useEffect, useState } from "react";

import {
  INTERVIEW_CALENDAR_ACCESS_LEVELS,
  type InterviewCalendarMe,
  type InterviewCalendarRole,
} from "@/lib/recruitment/interview-calendar-types";

const NOBODY: InterviewCalendarMe = { role: null, zoomConnected: false };

let cached: InterviewCalendarMe | null = null;
let inflight: Promise<InterviewCalendarMe> | null = null;

function asRole(value: unknown): InterviewCalendarRole | null {
  if (value === "owner") return "owner";
  return (INTERVIEW_CALENDAR_ACCESS_LEVELS as readonly unknown[]).includes(value) ? (value as InterviewCalendarRole) : null;
}

function loadMe(): Promise<InterviewCalendarMe> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = fetch("/api/recruitment/interview-calendar/me", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return NOBODY;
        const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        const me: InterviewCalendarMe = {
          canAddToRecruitment: data?.canAddToRecruitment === true,
          canSearchCandidates: data?.canSearchCandidates === true,
          role: asRole(data?.role),
          zoomConnected: data?.zoomConnected === true,
        };
        cached = me;
        return me;
      })
      .catch(() => NOBODY)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** `initial` skips the request entirely where the server already knows (the calendar page itself). */
export function useInterviewCalendarMe(initial?: InterviewCalendarMe | null): InterviewCalendarMe {
  const [me, setMe] = useState<InterviewCalendarMe>(initial ?? cached ?? NOBODY);
  useEffect(() => {
    if (initial) {
      cached = initial;
      return;
    }
    let live = true;
    void loadMe().then((value) => {
      if (live) setMe(value);
    });
    return () => {
      live = false;
    };
  }, [initial]);
  return me;
}
