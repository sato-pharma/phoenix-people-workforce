"use client";

import type { OutstationApprovalRecommendation } from "@/lib/outstation/types";

const tones: Record<OutstationApprovalRecommendation, string> = {
  auto_approve: "bg-emerald-50 text-emerald-700 ring-emerald-100",
  hr_review: "bg-sky-50 text-sky-700 ring-sky-100",
  manager_review: "bg-amber-50 text-amber-700 ring-amber-100",
  reject: "bg-red-50 text-red-700 ring-red-100",
};

export function ApprovalRecommendationBadge({
  value,
}: {
  value: OutstationApprovalRecommendation;
}) {
  return (
    <span
      className={`inline-flex rounded-md px-2 py-1 text-phx-sm font-bold uppercase tracking-wider ring-1 ${tones[value]}`}
    >
      {value.replace(/_/g, " ")}
    </span>
  );
}
