"use client";

import { useEffect, useRef, useState } from "react";

import type { VenueContactOption } from "@/lib/direct-orders/venue-contact-options";

/**
 * Declare which CRM contact this venue IS, when registering it.
 *
 * WHY THIS EXISTS. `contact-trade.ts` puts a "traded with" badge on a rep's CRM contact list, and
 * its first and strongest rule is an explicit CRM id — an id a human wrote down beats every name
 * and area inference. Marketing has always had one. Direct orders had none, so a venue could only
 * be matched by NAME, and measured against production on 2026-09-03 exactly ONE of 63 venues ever
 * matched. Better matching cannot fix that: with the area gate removed entirely the ceiling is 4.
 * A rep types a venue into an order form and the CRM holds a different string for the same shop.
 *
 * So the submitter is asked instead. This is the same shape as the campaign picker on the order
 * form — the person raising the request declares the link, rather than the system guessing it
 * afterwards and being wrong in a way nobody can see.
 *
 * IT IS OPTIONAL, AND SAYING SO IS PART OF THE DESIGN. The 2026-08-04 rule about distributor codes
 * applies here too: refusing to save a venue whose CRM row the submitter cannot find does not
 * produce a correct link, it produces a wrong one. Leaving this empty costs nothing — the venue
 * registers exactly as it did before.
 *
 * WHOSE CONTACTS IT OFFERS. The server resolves the caller's own reach — their list UNION their org
 * subtree — because venue creators are overwhelmingly District Sales Managers, and a DM's own CRM
 * account holds no contact list at all. The list belongs to the reps beneath them. Nothing here
 * chooses the scope; it renders what the route returns, so this component can never be wider than
 * its viewer.
 */
export function CrmContactPicker({
  disabled,
  onChange,
  picked,
}: {
  disabled?: boolean;
  onChange: (option: VenueContactOption | null) => void;
  picked: VenueContactOption | null;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VenueContactOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  // Guards a slow earlier response overwriting a newer one — the type-ahead bug where deleting a
  // character brings back the previous keystroke's results.
  const requestSeq = useRef(0);

  // DERIVED, never stored: an earlier shape cleared `results` with setState inside the effect body,
  // which this repo's react-hooks rule rejects outright, and which also creates a second source of
  // truth that can disagree with `results` mid-render.
  const searchable = !disabled && !picked && query.trim().length >= 2;
  const visibleResults = searchable ? results : [];

  useEffect(() => {
    if (!searchable) return;
    const trimmed = query.trim();
    const seq = ++requestSeq.current;
    const timer = setTimeout(() => {
      setSearching(true);
      setSearchError(null);
      const params = new URLSearchParams({ search: trimmed, limit: "25" });
      fetch(`/api/direct-orders/crm-contacts?${params.toString()}`)
        .then(async (res) => {
          const data = (await res.json().catch(() => ({}))) as {
            message?: string;
            options?: VenueContactOption[];
            success?: boolean;
            truncated?: boolean;
            unavailableReason?: string | null;
          };
          if (seq !== requestSeq.current) return; // a newer keystroke already won
          if (!res.ok || !data.success) throw new Error(data.message || "Could not search your CRM contacts.");
          setResults(data.options ?? []);
          setTruncated(data.truncated === true);
          setUnavailable(data.unavailableReason ?? null);
        })
        .catch((error: unknown) => {
          if (seq !== requestSeq.current) return;
          setResults([]);
          setSearchError(error instanceof Error ? error.message : "Could not search your CRM contacts.");
        })
        .finally(() => {
          if (seq === requestSeq.current) setSearching(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, searchable]);

  return (
    <div className="mt-2 border border-[#eef1f3] p-2">
      <p className="text-phx-xs font-black uppercase tracking-wider text-slate-500">This venue on the CRM</p>
      <p className="mb-1 text-phx-xs font-semibold text-slate-500">
        Optional. Pick the CRM pharmacy or doctor this venue is, and the rep whose list it is on will
        see this order against it. Leave it empty if you cannot find it — nothing is blocked.
      </p>

      {picked ? (
        <div className="flex flex-wrap items-start justify-between gap-2 border border-emerald-200 bg-emerald-50 px-2 py-1.5">
          <span className="min-w-0 text-phx-sm font-bold text-emerald-900">
            {picked.name}
            {picked.nameAr && picked.nameAr !== picked.name ? (
              <span className="font-semibold text-emerald-800"> · {picked.nameAr}</span>
            ) : null}
            <span className="block font-semibold text-emerald-700">
              {listTypeLabel(picked.listType)}
              {picked.address ? ` · ${picked.address}` : ""}
              {picked.agentName ? ` · on ${picked.agentName}'s list` : ""}
            </span>
          </span>
          <button
            type="button"
            className="text-phx-xs font-bold text-slate-500 hover:text-slate-800"
            onClick={() => {
              onChange(null);
              setQuery("");
            }}
          >
            Change
          </button>
        </div>
      ) : (
        <div>
          <input
            className="mt-1 w-full border border-slate-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none"
            disabled={disabled}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search your CRM contacts by name…"
            value={query}
          />
          {searching ? <p className="mt-0.5 text-phx-xs text-slate-400">Searching…</p> : null}
          {searchError ? <p className="mt-0.5 text-phx-xs font-semibold text-rose-600">{searchError}</p> : null}
          {/* A scope that resolved to nobody explains itself. An empty dropdown with no reason
              reads as broken, and a manager would believe it. */}
          {!searching && !searchError && unavailable ? (
            <p className="mt-0.5 text-phx-xs font-semibold text-amber-700">{unavailable}</p>
          ) : null}
          {!searching && !searchError && !unavailable && searchable && visibleResults.length === 0 ? (
            <p className="mt-0.5 text-phx-xs text-slate-500">
              No contact on your team&rsquo;s CRM lists matches &ldquo;{query.trim()}&rdquo;. Leave it empty
              and register the venue anyway.
            </p>
          ) : null}

          {visibleResults.length > 0 ? (
            <ul className="mt-1 max-h-60 overflow-y-auto border border-slate-200">
              {visibleResults.map((option) => (
                <li key={`${option.contactCrmId}-${option.listType}`}>
                  <button
                    type="button"
                    className="w-full border-b border-slate-100 px-2 py-1.5 text-left hover:bg-slate-50"
                    onClick={() => {
                      onChange(option);
                      setQuery("");
                    }}
                  >
                    {/* Wrapping, never truncation — the owner's ellipsis ban, and an address is
                        exactly the field a submitter needs in full to tell two shops apart. */}
                    <span className="block break-words text-phx-sm font-bold text-slate-800">
                      {option.name}
                      {option.nameAr && option.nameAr !== option.name ? (
                        <span className="font-semibold text-slate-600"> · {option.nameAr}</span>
                      ) : null}
                    </span>
                    <span className="block break-words text-phx-xs font-semibold text-slate-500">
                      {listTypeLabel(option.listType)}
                      {option.speciality ? ` · ${option.speciality}` : ""}
                      {option.address ? ` · ${option.address}` : ""}
                      {option.region ? ` · ${option.region}` : ""}
                    </span>
                    <span className="block break-words text-phx-xs font-semibold text-slate-400">
                      on {option.agentName}&rsquo;s list
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {truncated && visibleResults.length > 0 ? (
            <p className="mt-0.5 text-phx-xs text-slate-500">
              More match than are shown — keep typing to narrow it.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * The CRM's own list names, in the owner's vocabulary rather than the vendor's.
 *
 * `Pharmacy` is a shop and `PM`/`AM` are people, and a submitter registering a venue has to be able
 * to tell those apart at a glance. Note the house rule this respects: a pharmacy is NOT a contact,
 * so the two are never described with one word.
 */
function listTypeLabel(listType: string): string {
  if (listType === "Pharmacy") return "Pharmacy";
  if (listType === "AM") return "Doctor (AM list)";
  return "Doctor (PM list)";
}
