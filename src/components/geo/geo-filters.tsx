"use client";

import { usePathname, useRouter } from "next/navigation";

import type { GeoDashboardData } from "@/lib/geo-intelligence/types";
import { Button } from "@/components/ui/button";

type Props = {
  current: GeoDashboardData["filters"];
  options: GeoDashboardData["filterOptions"];
  targetPath?: string;
};

export function GeoFilters({ current, options, targetPath }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const resolvedPath = targetPath ?? pathname;

  function updateFilter(key: string, value: string) {
    const params = new URLSearchParams();
    const next = {
      area: current.area,
      employeeHrId: current.employeeHrId,
      line: current.line,
      month: current.month,
      status: current.status,
      [key]: value,
    };

    Object.entries(next).forEach(([entryKey, entryValue]) => {
      if (entryValue) {
        params.set(entryKey, entryValue);
      }
    });

    const query = params.toString();
    router.push(query ? `${resolvedPath}?${query}` : resolvedPath);
  }

  function reset() {
    router.push(resolvedPath);
  }

  return (
    <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1fr_1fr_auto]">
      <SelectField
        label="Line"
        onChange={(value) => updateFilter("line", value)}
        options={options.lines}
        value={current.line ?? ""}
      />
      <SelectField
        label="Area"
        onChange={(value) => updateFilter("area", value)}
        options={options.areas}
        value={current.area ?? ""}
      />
      <SelectField
        label="Employee"
        onChange={(value) => updateFilter("employeeHrId", value)}
        options={options.employees.map((item) => ({ label: item.name, value: item.hrId }))}
        value={current.employeeHrId ?? ""}
      />
      <SelectField
        label="Month"
        onChange={(value) => updateFilter("month", value)}
        options={options.months}
        value={current.month ?? ""}
      />
      <SelectField
        label="Status"
        onChange={(value) => updateFilter("status", value)}
        options={options.statuses}
        value={current.status ?? ""}
      />
      <div className="flex items-end">
        <Button
          className="h-10 rounded-xl border border-[#D7E0EA] px-4 text-sm font-semibold text-[#0F172A] transition hover:border-[#FDBA74] hover:bg-[#FFF7ED]"
          variant="secondary"
          onClick={reset}
          type="button"
        >
          Reset
        </Button>
      </div>
    </div>
  );
}

function SelectField({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: string[] | Array<{ label: string; value: string }>;
  value: string;
}) {
  const normalized = options.map((option) =>
    typeof option === "string" ? { label: option, value: option } : option,
  );

  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
        {label}
      </span>
      <select
        className="h-10 w-full rounded-xl border border-[#D7E0EA] bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/12"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">All</option>
        {normalized.map((option) => (
          <option key={`${label}-${option.value}`} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
