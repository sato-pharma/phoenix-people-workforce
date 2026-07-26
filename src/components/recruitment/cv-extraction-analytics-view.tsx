"use client";

import { getCvPositionSchema } from "@/lib/recruitment/cv-field-schemas";
import type { CvExtractionAccuracyAnalytics, PositionAccuracy } from "@/lib/recruitment/cv-extraction-analytics";

// Read-only CV-extraction accuracy view. Visibility only — does not change extraction
// behavior. Fields are already sorted worst-first (highest correction rate) by the
// aggregation lib, so the most-corrected fields are immediately visible per position.

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function fieldLabel(positionKey: string, fieldKey: string): string {
  const field = getCvPositionSchema(positionKey)?.fields.find((f) => f.key === fieldKey);
  return field?.label ?? fieldKey;
}

function PositionTable({ position }: { position: PositionAccuracy }) {
  const label = getCvPositionSchema(position.positionKey)?.label ?? position.positionKey;
  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <h2 className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700">
        {label} <span className="font-normal text-slate-400">— {position.totalReviewed} reviewed</span>
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-sm">
          <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">Field</th>
              <th className="px-3 py-2">Reviewed</th>
              <th className="px-3 py-2">Corrected</th>
              <th className="px-3 py-2">Correction rate</th>
            </tr>
          </thead>
          <tbody>
            {position.fields.map((field) => (
              <tr key={field.fieldKey} className="border-t border-slate-100">
                <td className="px-3 py-2 font-medium text-slate-800">{fieldLabel(position.positionKey, field.fieldKey)}</td>
                <td className="px-3 py-2 text-slate-700">{field.totalReviewed}</td>
                <td className="px-3 py-2 text-slate-700">{field.correctedCount}</td>
                <td
                  className={`px-3 py-2 font-medium ${
                    field.correctionRate >= 0.3
                      ? "text-rose-700"
                      : field.correctionRate >= 0.1
                        ? "text-amber-700"
                        : "text-emerald-700"
                  }`}
                >
                  {pct(field.correctionRate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function CvExtractionAnalyticsView({ data }: { data: CvExtractionAccuracyAnalytics }) {
  if (data.overallTotalReviewed === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
        No reviewed extractions yet. Accuracy stats appear once Talent Acquisition has saved at least one
        extracted candidate.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-6">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-500">Reviewed extractions</p>
            <p className="text-lg font-semibold text-slate-900">{data.overallTotalReviewed}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-500">Overall correction rate</p>
            <p className="text-lg font-semibold text-slate-900">{pct(data.overallCorrectionRate)}</p>
          </div>
        </div>
      </section>
      {data.byPosition.map((position) => (
        <PositionTable key={position.positionKey} position={position} />
      ))}
    </div>
  );
}
