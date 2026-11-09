"use client";

import { CalendarRange, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { ClosingDetailsPanel } from "@/components/sales/closing-details-panel";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { phxSelectClassName } from "@/components/ui/form-tokens";

// Standalone mount of the Details tab for the Monthly Closing analytics module. Used by both the
// admin route and the employee-portal route — the API scopes every read to the caller, so the
// same component is safe on both. The line/period pickers are populated from the API's own
// scoped lists, never from a client-side guess.
//
// A scoped viewer (DM/RM/NSM/PM/GPM) almost always has exactly ONE line — showing them a dropdown
// for a choice that doesn't exist reads as broken, not helpful. A DROPDOWN only appears when there
// is a REAL choice (2+ options); with 0 or 1 option it renders as a plain locked value instead,
// matching how the rest of Monthly Closing already treats a scoped viewer's line ("the viewer
// NEVER picks a line — it is resolved from their HR_ID", see monthly-closing-portal.ts).

const selectClassName  = phxSelectClassName;

function PickerOrLocked({
  label,
  value,
  options,
  onChange,
  emptyLabel,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  emptyLabel: string;
}) {
  return (
    <label className="flex flex-col gap-1 sm:w-44">
      <span className="text-phx-sm font-bold uppercase tracking-[0.16em] text-slate-500">{label}</span>
      {options.length > 1 ? (
        <SearchableSelect className={selectClassName} onChange={(event) => onChange(event.target.value)} value={value}>
          {options.map((entry) => (
            <option key={entry} value={entry}>{entry}</option>
          ))}
        </SearchableSelect>
      ) : (
        <div className="flex h-11 w-full items-center rounded-2xl border border-phx-line bg-phx-paper px-3.5 text-sm font-semibold text-phx-ink">
          {value || emptyLabel}
        </div>
      )}
    </label>
  );
}

export function ClosingDetailsStandalone({ canRevealConfidential = false }: { canRevealConfidential?: boolean }) {
  const [lines, setLines] = useState<string[]>([]);
  const [periods, setPeriods] = useState<string[]>([]);
  const [line, setLine] = useState<string>("");
  const [period, setPeriod] = useState<string>("");
  const [isReady, setIsReady] = useState(false);

  // One cheap probe (pageSize=1) to learn which lines/months this viewer may open.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/sales/monthly-closing/details?pageSize=1", { cache: "no-store" });
        const payload = (await response.json()) as {
          data?: { availableLines: string[]; availablePeriods: string[]; line: string | null; period: string | null };
          success: boolean;
        };
        if (cancelled || !payload.success || !payload.data) {
          if (!cancelled) setIsReady(true);
          return;
        }
        setLines(payload.data.availableLines);
        setPeriods(payload.data.availablePeriods);
        setLine(payload.data.line ?? "");
        setPeriod(payload.data.period ?? "");
      } catch {
        // Leave the pickers empty — the panel renders its own error state on the real load.
      } finally {
        if (!cancelled) setIsReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <AdminPageHero
        badges={(
          <>
            <AdminInsightChip>Line: {line || "—"}</AdminInsightChip>
            <AdminInsightChip>Month: {period || "—"}</AdminInsightChip>
            <AdminInsightChip tone="slate">Every invoice line behind the closing</AdminInsightChip>
          </>
        )}
        description="The distributor rows underneath the Closing Matrix, with Phoenix bricks rolled up to areas and an explicit flag for whether each row is inside the published headline."
        eyebrow="Monthly Closing"
        icon={<CalendarRange className="h-4 w-4" />}
        title="Details"
      />

      <AdminTableShell
        action={(
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <PickerOrLocked
              emptyLabel="No lines in scope"
              label="Line"
              onChange={setLine}
              options={lines}
              value={line}
            />
            <PickerOrLocked
              emptyLabel="No validated month"
              label="Month"
              onChange={setPeriod}
              options={periods}
              value={period}
            />
          </div>
        )}
        description="Filter, search and reconcile the raw rows. Totals below reflect the current filters."
        title="Detailed sales rows"
      >
        {!isReady ? (
          <div className="flex items-center gap-2 px-4 py-10 text-sm font-semibold text-slate-500 md:px-5">
            <Loader2 className="h-4 w-4 animate-spin" />
            Resolving your scope…
          </div>
        ) : (
          <ClosingDetailsPanel
            line={line || null}
            period={period || null}
            showConfidentialToggle={canRevealConfidential}
          />
        )}
      </AdminTableShell>
    </div>
  );
}
