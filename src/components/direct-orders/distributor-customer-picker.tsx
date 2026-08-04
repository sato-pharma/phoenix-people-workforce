"use client";

import { useEffect, useRef, useState } from "react";

import type { DirectOrderCustomerOption } from "@/lib/direct-orders/service";

export type DistributorOption = { distributorCode: string; distributorName: string };
export type PickerAreaOption = { areaCode: string; areaName: string; regionCode: string; regionName: string };

export type DistributorCustomerRow = {
  distributorCode: string;
  customerCode: string;
  /** Filled when picked from the catalogue; empty when typed by hand. Display only. */
  customerName?: string;
};

/**
 * Pick a pharmacy from the DISTRIBUTOR'S OWN customer list, by name.
 *
 * The problem this replaces: the submitter had to type the distributor's customer code from
 * memory. Nobody knows those codes, and a wrong one is not a harmless typo — retail sales are
 * matched on (distributor, customer code), so a mistyped code silently attributes a different
 * pharmacy's sales to this one on the screen where money is approved.
 *
 * Cascade: distributor → area (defaulted from the submitter's own territory, narrowing only)
 * → searchable customer by NAME. The list is bounded server-side to the caller's areas, so this
 * cannot be used to browse another region.
 *
 * "Not listed" is deliberately always available. A genuinely new pharmacy must never be blocked
 * from being ordered for today; typing the code instead marks the pharmacy for SFE review and a
 * System Admin acknowledgment, which the server derives from the catalogue rather than trusting
 * anything this component sends.
 */
export function DistributorCustomerPicker({
  row,
  distributors,
  areas,
  inputClassName,
  onChange,
  onRemove,
}: {
  row: DistributorCustomerRow;
  distributors: DistributorOption[];
  areas: PickerAreaOption[];
  inputClassName: string;
  onChange: (patch: Partial<DistributorCustomerRow>) => void;
  onRemove?: () => void;
}) {
  const [areaCode, setAreaCode] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DirectOrderCustomerOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [open, setOpen] = useState(false);
  // Guards against a slow earlier response overwriting a newer one — the classic type-ahead bug
  // where deleting a character brings back the previous keystroke's results.
  const requestSeq = useRef(0);

  // Whether a search is even meaningful right now. DERIVED, not stored: an earlier version
  // cleared `results` with setState inside the effect, which the repo's react-hooks rule rejects
  // for triggering cascading renders. Deriving it also removes a second source of truth that
  // could disagree with `results` mid-render.
  const searchable = !manual && Boolean(row.distributorCode) && query.trim().length >= 2;
  const visibleResults = searchable ? results : [];

  useEffect(() => {
    if (!searchable) return;
    const trimmed = query.trim();
    const seq = ++requestSeq.current;
    const timer = setTimeout(() => {
      setSearching(true);
      setSearchError(null);
      const params = new URLSearchParams({ distributor: row.distributorCode, q: trimmed });
      if (areaCode) params.set("area", areaCode);
      fetch(`/api/direct-orders/customers?${params.toString()}`)
        .then(async (res) => {
          const data = (await res.json().catch(() => ({}))) as {
            success?: boolean;
            customers?: DirectOrderCustomerOption[];
            message?: string;
          };
          if (seq !== requestSeq.current) return; // a newer keystroke already won
          if (!res.ok || !data.success) throw new Error(data.message || "Search failed.");
          setResults(data.customers ?? []);
          setOpen(true);
        })
        .catch((error: unknown) => {
          if (seq !== requestSeq.current) return;
          setResults([]);
          setSearchError(error instanceof Error ? error.message : "Search failed.");
        })
        .finally(() => {
          if (seq === requestSeq.current) setSearching(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, areaCode, row.distributorCode, searchable]);

  const picked = Boolean(row.customerCode && row.customerName);

  return (
    <div className="mb-2 space-y-1.5 border border-slate-200 p-2">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <select
          className={inputClassName}
          value={row.distributorCode}
          onChange={(event) => {
            // Changing distributor invalidates any customer already chosen — the code belongs to
            // the old distributor and would otherwise silently point at a stranger.
            onChange({ distributorCode: event.target.value, customerCode: "", customerName: "" });
            setQuery("");
            setResults([]);
          }}
        >
          <option value="">Distributor…</option>
          {distributors.map((distributor) => (
            <option key={distributor.distributorCode} value={distributor.distributorCode}>
              {distributor.distributorName}
            </option>
          ))}
        </select>
        {onRemove ? (
          <button type="button" className="px-2 text-slate-400 hover:text-rose-600" onClick={onRemove}>
            ✕
          </button>
        ) : (
          <span />
        )}
      </div>

      {row.distributorCode && !manual ? (
        <>
          <select
            className={inputClassName}
            value={areaCode}
            onChange={(event) => {
              setAreaCode(event.target.value);
              setResults([]);
            }}
          >
            {/* Region-wide by default, with an area filter on top — the owner's cascade. */}
            <option value="">All my areas</option>
            {areas.map((area) => (
              <option key={area.areaCode} value={area.areaCode}>
                {area.areaName}
                {area.regionName ? ` — ${area.regionName}` : ""}
              </option>
            ))}
          </select>

          {picked ? (
            <div className="flex items-center justify-between gap-2 border border-emerald-200 bg-emerald-50 px-2 py-1.5">
              <span className="text-[12px] font-bold text-emerald-900">
                {row.customerName} <span className="text-emerald-700">({row.customerCode})</span>
              </span>
              <button
                type="button"
                className="text-[11px] font-bold text-slate-500 hover:text-slate-800"
                onClick={() => {
                  onChange({ customerCode: "", customerName: "" });
                  setQuery("");
                }}
              >
                Change
              </button>
            </div>
          ) : (
            <div className="relative">
              <input
                className={inputClassName}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onFocus={() => setOpen(true)}
                placeholder="Search the pharmacy by name…"
              />
              {searching ? <p className="mt-0.5 text-[11px] text-slate-400">Searching…</p> : null}
              {searchError ? <p className="mt-0.5 text-[11px] font-semibold text-rose-600">{searchError}</p> : null}
              {!searching && !searchError && searchable && visibleResults.length === 0 ? (
                <p className="mt-0.5 text-[11px] text-slate-500">
                  No pharmacy matches “{query.trim()}” for this distributor in your areas.
                </p>
              ) : null}
              {open && visibleResults.length > 0 ? (
                <ul className="absolute z-20 max-h-64 w-full overflow-y-auto border border-slate-300 bg-white shadow-lg">
                  {visibleResults.map((option) => (
                    <li key={`${option.customerCode}-${option.areaCode ?? ""}`}>
                      <button
                        type="button"
                        className="block w-full px-2 py-1.5 text-left text-[12px] hover:bg-orange-50"
                        onClick={() => {
                          onChange({ customerCode: option.customerCode, customerName: option.customerName });
                          setOpen(false);
                        }}
                      >
                        <span className="font-bold text-slate-900">{option.customerName}</span>
                        {/* Names, never bare codes — but the code is shown so the submitter can
                            confirm against an invoice before committing. */}
                        <span className="ml-1 text-slate-500">({option.customerCode})</span>
                        <span className="block text-[11px] text-slate-500">
                          {[option.brickName, option.areaName, option.regionName].filter(Boolean).join(" · ") || "—"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}

          <button
            type="button"
            className="text-[11px] font-bold text-orange-600 hover:text-orange-700"
            onClick={() => {
              setManual(true);
              onChange({ customerCode: "", customerName: "" });
            }}
          >
            Not listed? Enter the code manually
          </button>
        </>
      ) : null}

      {row.distributorCode && manual ? (
        <>
          <input
            className={inputClassName}
            value={row.customerCode}
            onChange={(event) => onChange({ customerCode: event.target.value, customerName: "" })}
            placeholder="Customer code (from the distributor's invoice)"
          />
          <p className="text-[11px] font-semibold text-amber-700">
            This code is not being matched against the distributor&apos;s list. The order still submits,
            but the pharmacy is held for SFE review and a System Admin acknowledgment.
          </p>
          <button
            type="button"
            className="text-[11px] font-bold text-orange-600 hover:text-orange-700"
            onClick={() => {
              setManual(false);
              onChange({ customerCode: "", customerName: "" });
            }}
          >
            ← Back to searching by name
          </button>
        </>
      ) : null}
    </div>
  );
}
