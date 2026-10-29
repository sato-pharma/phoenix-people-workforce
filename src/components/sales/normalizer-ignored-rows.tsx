"use client";

import { useMemo, useState } from "react";

import { CrmCard, CrmCardsOnPhone, CrmFacts, CrmTable } from "@/components/phoenix-crm/ui";
import { phxSelectClassName } from "@/components/ui/form-tokens";
import type { PreviewIgnoredRow } from "@/lib/sales/recognize";
import { cn } from "@/lib/utils";

// Every row the analyzer dropped before mapping, one line each. The Needs mapping tab only carries the count
// ("237 ignored"); this is the rows behind it, with the reason, so nothing is dropped without being readable.

const REASON_LABEL: Record<PreviewIgnoredRow["reason"], string> = {
  bonus: "Free goods — the sheet's bonus flag is set",
  ignore_mapped: "Product is mapped to ignore (not sold)",
};

type ReasonFilter = "all" | PreviewIgnoredRow["reason"];

export function NormalizerIgnoredRows({ rows, ignoredCount }: { rows: readonly PreviewIgnoredRow[]; ignoredCount: number }) {
  const [reason, setReason] = useState<ReasonFilter>("all");
  const shown = useMemo(() => (reason === "all" ? rows : rows.filter((row) => row.reason === reason)), [rows, reason]);
  const units = useMemo(() => shown.reduce((sum, row) => sum + row.qty, 0), [shown]);

  if (ignoredCount === 0 && rows.length === 0) {
    return <p className="border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">This file had no ignored rows.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
        <span>
          <b>{shown.length.toLocaleString("en-US")}</b> of {rows.length.toLocaleString("en-US")} ignored rows
          {" · "}
          <b>{units.toLocaleString("en-US")}</b> units
        </span>
        <label className="ml-auto flex items-center gap-2 text-xs font-bold text-slate-600">
          Reason
          <select className={cn(phxSelectClassName, "h-9 w-auto")} onChange={(e) => setReason(e.target.value as ReasonFilter)} value={reason}>
            <option value="all">All reasons</option>
            <option value="ignore_mapped">{REASON_LABEL.ignore_mapped}</option>
            <option value="bonus">{REASON_LABEL.bonus}</option>
          </select>
        </label>
      </div>
      {rows.length < ignoredCount ? (
        <p className="border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          The file counts {ignoredCount.toLocaleString("en-US")} ignored rows but only {rows.length.toLocaleString("en-US")} came back with it, so this list is not the whole set.
        </p>
      ) : null}
      <div className="border border-phx-line">
        <CrmTable columns={["52%", "14%", "34%"]}>
          <thead className="bg-[#0B0B0B] text-phx-paper-2">
            <tr>
              {["Product (sheet row)", "Units", "Why it was ignored"].map((h) => (
                <th className="break-words px-3 py-2 text-left" key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr className={cn("hover:bg-orange-50/50", i % 2 && "bg-slate-50/60")} key={`${row.rowNumber}-${i}`}>
                <td className="break-words px-3 py-1.5 align-top text-slate-600">
                  <span className="block font-semibold text-slate-900" dir="auto">{row.productName}</span>
                  <span className="block font-mono text-xs">{row.rawProduct} · {row.fileName ? `${row.fileName} · ` : ""}row {row.rowNumber.toLocaleString("en-US")}</span>
                </td>
                <td className="break-words px-3 py-1.5 align-top font-semibold tabular-nums text-slate-900">{row.qty.toLocaleString("en-US")}</td>
                <td className="break-words px-3 py-1.5 align-top text-slate-600">{REASON_LABEL[row.reason]}</td>
              </tr>
            ))}
          </tbody>
        </CrmTable>
        <CrmCardsOnPhone>
          {shown.map((row, i) => (
            <CrmCard
              key={`${row.rowNumber}-${i}`}
              meta={`${row.rawProduct} · ${row.fileName ? `${row.fileName} · ` : ""}row ${row.rowNumber.toLocaleString("en-US")}`}
              title={<span dir="auto">{row.productName}</span>}
            >
              <CrmFacts
                facts={[
                  { label: "Units", value: row.qty.toLocaleString("en-US") },
                  { label: "Why it was ignored", value: REASON_LABEL[row.reason] },
                ]}
              />
            </CrmCard>
          ))}
        </CrmCardsOnPhone>
      </div>
    </div>
  );
}
