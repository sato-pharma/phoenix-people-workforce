"use client";

import type { NsmBrickCoverageData } from "@/lib/employee-portal/service";

import { BrickCoverageMap } from "@/components/employee-portal/brick-coverage-map";
import { Card } from "@/components/ui/card";

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "N/A";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function StatCard({
  helper,
  label,
  value,
}: {
  helper?: string;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
        {label}
      </p>
      <p className="mt-2 text-2xl font-bold text-slate-900">{value}</p>
      {helper ? <p className="mt-1 text-xs text-slate-500">{helper}</p> : null}
    </div>
  );
}

export function BrickCoverageDashboard({
  data,
}: {
  data: NsmBrickCoverageData;
}) {
  if (!data.selectedDsmHrId || !data.summary) {
    return (
      <Card className="rounded-3xl border border-slate-100 bg-white p-8 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
        <p className="text-lg font-semibold text-slate-900">Select a DSM</p>
        <p className="mt-2 text-sm text-slate-500">
          Choose a DSM from the filter to see visited bricks, uncovered bricks,
          visit count, average cost, and AM/PM workload coverage.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <section className="grid gap-4 sm:grid-cols-3">
        <StatCard
          helper="Territories assigned from DSM sales scope"
          label="Assigned Bricks"
          value={data.summary.totalAssignedBricks.toLocaleString()}
        />
        <StatCard
          helper="Bricks with at least one logged trip"
          label="Visited Bricks"
          value={data.summary.visitedBricks.toLocaleString()}
        />
        <StatCard
          helper="Assigned bricks with no logged trips"
          label="Not Visited"
          value={data.summary.unvisitedBricks.toLocaleString()}
        />
      </section>

      <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
        <div className="mb-5">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            Brick Coverage
          </p>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">
            {data.summary.selectedDsmName} brick visit analysis
          </h2>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100 text-left text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-3 font-medium text-slate-500">Brick</th>
                <th className="px-4 py-3 font-medium text-slate-500">Area</th>
                <th className="px-4 py-3 font-medium text-slate-500">Visits</th>
                <th className="px-4 py-3 font-medium text-slate-500">Avg Cost</th>
                <th className="px-4 py-3 font-medium text-slate-500">AM WL</th>
                <th className="px-4 py-3 font-medium text-slate-500">PM WL</th>
                <th className="px-4 py-3 font-medium text-slate-500">Last Visit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {data.summary.visitedBrickRows.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-slate-500" colSpan={7}>
                    No brick visits found for the selected DSM.
                  </td>
                </tr>
              ) : (
                data.summary.visitedBrickRows.map((brick) => (
                  <tr key={brick.brick} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-900">{brick.brick}</td>
                    <td className="px-4 py-3 text-slate-700">{brick.area || "N/A"}</td>
                    <td className="px-4 py-3 text-slate-700">{brick.visits.toLocaleString()}</td>
                    <td className="px-4 py-3 text-slate-700">{egp(brick.avgCostPerVisit)}</td>
                    <td className="px-4 py-3 text-slate-700">{Math.round(brick.totalAmWorkload).toLocaleString()}</td>
                    <td className="px-4 py-3 text-slate-700">{Math.round(brick.totalPmWorkload).toLocaleString()}</td>
                    <td className="px-4 py-3 text-slate-700">{formatDate(brick.lastVisitDate)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <BrickCoverageMap data={data} />

      <Card className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_12px_24px_rgba(15,23,42,0.05)]">
        <div className="mb-5">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            Bricks Not Visited
          </p>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">
            Uncovered bricks for {data.summary.selectedDsmName}
          </h2>
        </div>

        <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
          {data.summary.unvisitedBrickRows.length === 0 ? (
            <p className="text-sm text-slate-500">No uncovered bricks for the selected DSM.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {data.summary.unvisitedBrickRows.map((brick) => (
                <span
                  key={`${brick.area}-${brick.brick}`}
                  className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700"
                >
                  {brick.area ? `${brick.brick} (${brick.area})` : brick.brick}
                </span>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
