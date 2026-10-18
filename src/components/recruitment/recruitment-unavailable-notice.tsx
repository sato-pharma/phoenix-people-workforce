"use client";

import { AlertTriangle } from "lucide-react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { describeUnavailable, type RecruitmentReadSource } from "@/lib/recruitment/page-reads";

/**
 * Says, in words, which parts of the Recruitment page did not load -- and offers the one thing that
 * helps, which is asking again.
 *
 * It replaces a single red line and a sentence about applying migrations on staging. The page used to
 * go blank when ANY of its reads failed, and the advice it gave was for a fresh environment; the
 * Talent Acquisition seat read it on production on 18 Oct 2026 while the database was only slow. The
 * button is inside the text column rather than beside it so the notice fits a 375px screen without a
 * sideways scroll.
 */
export function RecruitmentUnavailableNotice({
  onRetry,
  pending,
  sources,
}: {
  onRetry: () => void;
  pending: boolean;
  sources: ReadonlyArray<RecruitmentReadSource>;
}) {
  if (sources.length === 0) return null;
  return (
    <AdminCallout tone="warning">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-1">
          <p className="font-medium">Some recruitment information is temporarily unavailable.</p>
          <p>Not loaded: {describeUnavailable(sources)}. The rest of this page is working.</p>
        </div>
        <Button size="sm" variant="secondary" disabled={pending} onClick={onRetry}>
          {pending ? "Trying again" : "Try again"}
        </Button>
      </div>
    </AdminCallout>
  );
}

/** Stands in for a tab whose own data did not load -- never an empty table that reads as "none". */
export function RecruitmentTabUnavailable({ what }: { what: string }) {
  return (
    <AdminCallout tone="warning">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1">{what} is temporarily unavailable. Use Try again above.</p>
    </AdminCallout>
  );
}
