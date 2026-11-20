"use client";

import { useState } from "react";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { LandingTitle, landingActionClassName } from "@/components/employee-portal/landing-kit";
import { postJson } from "@/components/recruitment/recruitment-fetch";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import type { MrAreaNotice } from "@/lib/recruitment/mr-hiring/area-notices";

// The list inside the portal home's banner (mr-area-notice-banner.tsx). "Got it" dismisses one
// notice for this manager only; the line leaves at once and comes back only if the dismissal failed.
//
// THE LOOK (owner, 2026-11-20 landing redesign): the landing kit's white panel. The tick title counts
// the candidates; each row gives the name in navy, what happened under it, then when, with the kit's
// navy buttons beside it. Square-edged, full-size text, wrapping on a phone rather than cut short.
// It was an amber block so it read as news; on the redesigned landing it is the first panel on the
// page, above the identity card, and orange is only the tick.

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
    <section className={`mb-3 min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`} data-mr-area-notice role="status">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 px-3 py-2.5 sm:px-4">
        <LandingTitle>
          {shown.length === 1 ? "A new Medical Rep candidate for your area" : `${shown.length} new Medical Rep candidates for your areas`}
        </LandingTitle>
      </header>
      <ul>
        {shown.map((notice) => (
          <li
            className="flex flex-col gap-3 border-b border-slate-200 px-3 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-4"
            key={notice.id}
          >
            <div className="min-w-0">
              <p className="break-words text-phx-md font-bold leading-snug text-[#08111f]" dir="auto">
                {notice.candidateName}
              </p>
              <p className="mt-0.5 break-words text-phx-sm leading-snug text-slate-600">
                Passed HR&apos;s 1st interview for <span className="font-semibold text-[#08111f]">{notice.areaName}</span>, {notice.lineLabel} line
                {notice.seat === "nsm" ? " — an area with no DSM on your line" : ""}.
              </p>
              <p className="mt-1 break-words text-phx-xs font-semibold tabular-nums text-slate-500">
                {cairoDateTime(notice.createdAt)} · HR books the DSM interview next.
              </p>
            </div>
            <span className="flex flex-wrap gap-2 sm:shrink-0 sm:justify-end">
              <a className={landingActionClassName("solid")} href={INTERVIEWS_HREF}>
                Open my Medical Rep interviews
              </a>
              <button className={landingActionClassName("outline")} onClick={() => void dismiss(notice.id)} type="button">
                Got it
              </button>
            </span>
          </li>
        ))}
      </ul>
      {error ? <p className="break-words border-t border-slate-200 px-3 py-2.5 text-phx-sm font-bold text-rose-700 sm:px-4">{error}</p> : null}
    </section>
  );
}
