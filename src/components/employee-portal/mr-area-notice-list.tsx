"use client";

import { useState } from "react";
import { UserPlus } from "lucide-react";

import { postJson } from "@/components/recruitment/recruitment-fetch";
import { phxButtonGhostClassName } from "@/components/ui/form-tokens";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import type { MrAreaNotice } from "@/lib/recruitment/mr-hiring/area-notices";

// The list inside the portal home's banner (mr-area-notice-banner.tsx). "Got it" dismisses one
// notice for this manager only; the line leaves at once and comes back only if the dismissal failed.
//
// Square-edged, full-size text, wrapping on a phone rather than cut short — the same mark as the
// "who opened this CV" notice (candidate-opened-notice.tsx), in amber so it reads as news.

const INTERVIEWS_HREF = "/employee-portals/recruitment-candidates#mr-interviews";

export function MrAreaNoticeList({ notices }: { notices: MrAreaNotice[] }) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const shown = notices.filter((notice) => !hidden.has(notice.id));
  if (shown.length === 0) return null;

  async function dismiss(id: string) {
    setError(null);
    setHidden((current) => new Set(current).add(id));
    try {
      await postJson(`/api/recruitment/mr-hiring/area-notices/${encodeURIComponent(id)}/seen`, {});
    } catch {
      setHidden((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      setError("Could not dismiss the notice. Try again.");
    }
  }

  return (
    <section className="mb-3 border-l-4 border-amber-500 bg-amber-50 px-3 py-3" data-mr-area-notice role="status">
      <p className="flex items-center gap-2 text-base font-bold text-amber-950">
        <UserPlus aria-hidden className="h-5 w-5 shrink-0 text-amber-700" />
        {shown.length === 1 ? "A new Medical Rep candidate for your area" : `${shown.length} new Medical Rep candidates for your areas`}
      </p>
      <ul className="mt-2 space-y-2">
        {shown.map((notice) => (
          <li className="flex flex-wrap items-center justify-between gap-2 border-t border-amber-200 pt-2" key={notice.id}>
            <p className="min-w-0 text-sm text-amber-950">
              <span className="font-bold" dir="auto">
                {notice.candidateName}
              </span>{" "}
              passed HR&apos;s 1st interview for <span className="font-semibold">{notice.areaName}</span>, {notice.lineLabel} line
              {notice.seat === "nsm" ? " — an area with no DSM on your line" : ""}.
              <span className="block text-amber-900">{cairoDateTime(notice.createdAt)} · HR books the DSM interview next.</span>
            </p>
            <span className="flex shrink-0 flex-wrap gap-2">
              <a className={phxButtonGhostClassName} href={INTERVIEWS_HREF}>
                Open my Medical Rep interviews
              </a>
              <button className={phxButtonGhostClassName} onClick={() => void dismiss(notice.id)} type="button">
                Got it
              </button>
            </span>
          </li>
        ))}
      </ul>
      {error ? <p className="mt-2 text-sm font-bold text-rose-700">{error}</p> : null}
    </section>
  );
}
