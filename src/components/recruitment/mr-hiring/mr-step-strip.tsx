"use client";

// Recruitment / Medical Rep hiring — one line on the workspace's opened CV saying where a Medical Rep
// candidate is in the 8 November 2026 workflow ("Step 3 of 9 · 2nd interview · DSM — Waiting for
// Ahmed Ali's feedback since 9 Nov"), with a link to that candidate on the Medical Rep Hiring page.
//
// Asked of the journey route, which admits the same seats the page does; a candidate the route does
// not know (not on the Medical Rep list, or a viewer it refuses) draws nothing at all.

import { Stethoscope } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { getJson } from "@/components/recruitment/recruitment-fetch";
import { mrStageHeadline, mrStageStateLine } from "@/lib/recruitment/mr-hiring/display";
import type { MrStage } from "@/lib/recruitment/mr-hiring/stage";

export function MrStepStrip({ candidateId, className }: { candidateId: string; className?: string }) {
  const pathname = usePathname() ?? "";
  const [stage, setStage] = useState<MrStage | null>(null);

  useEffect(() => {
    let live = true;
    getJson(`/api/recruitment/mr-hiring/${encodeURIComponent(candidateId)}/journey`)
      .then((body) => {
        const row = body.row as { stage?: MrStage } | undefined;
        if (live && row?.stage) setStage(row.stage);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [candidateId]);

  if (!stage) return null;
  const page = pathname.startsWith("/hr/") ? "/hr/recruitment/mr-hiring" : "/recruitment/mr-hiring";
  const state = mrStageStateLine(stage);

  return (
    <p className={`flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-orange-200 bg-orange-50 px-3 py-1.5 text-xs text-orange-950 ${className ?? ""}`}>
      <Stethoscope aria-hidden className="h-3.5 w-3.5 shrink-0 text-orange-600" />
      <span className="break-words font-black">{mrStageHeadline(stage)}</span>
      {state ? <span className="break-words">{state}</span> : null}
      <Link className="font-bold text-orange-700 underline" href={`${page}?candidate=${encodeURIComponent(candidateId)}`}>
        Open the hiring journey
      </Link>
    </p>
  );
}
