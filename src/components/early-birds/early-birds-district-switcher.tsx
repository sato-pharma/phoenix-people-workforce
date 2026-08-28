import Link from "next/link";

import type { EarlyBirdsDistrict } from "@/lib/early-birds/permissions";

// District switch as LINKS, not a client dropdown, so every switch re-runs the server-side scope
// gate. A client-side filter would let a viewer flip to a district the server never authorised.
// Renders nothing when the viewer owns exactly one district — a one-option switcher is noise.

export function EarlyBirdsDistrictSwitcher({
  districts,
  selectedHrIdKey,
  basePath,
}: {
  districts: EarlyBirdsDistrict[];
  selectedHrIdKey: string;
  basePath: string;
}) {
  if (districts.length <= 1) return null;

  return (
    <div className="flex flex-wrap gap-1.5 border border-slate-200 bg-white px-3 py-2" role="navigation" aria-label="District">
      {districts.map((district) => {
        const active = district.hrIdKey === selectedHrIdKey;
        return (
          <Link
            key={district.hrIdKey}
            href={`${basePath}?district=${encodeURIComponent(district.hrId)}`}
            className={`whitespace-nowrap border px-2 py-1 text-phx-xs font-bold ${
              active
                ? "border-orange-300 bg-orange-50 text-orange-700"
                : "border-slate-200 bg-white text-slate-600 hover:border-orange-200 hover:text-orange-600"
            }`}
            dir="auto"
          >
            {district.name}
          </Link>
        );
      })}
    </div>
  );
}
