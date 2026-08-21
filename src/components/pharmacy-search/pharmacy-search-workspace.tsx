"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Globe, Loader2, Save, Search } from "lucide-react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
  portalInputClassName,
} from "@/components/employee-portal/portal-primitives";
import { PharmacyProfilePanel } from "@/components/pharmacy-search/pharmacy-profile-panel";
import type { ExternalCandidate } from "@/lib/pharmacy-search/external";
import type { PharmacyProfile, PharmacySearchHit } from "@/lib/pharmacy-search/types";

type SearchResponse = {
  hits: PharmacySearchHit[];
  isEmpty: boolean;
  matchedDistributorName: string | null;
  query: string;
  truncated: boolean;
};

/** Long enough that a fast typist does not fire six searches, short enough to feel instant. */
const DEBOUNCE_MS = 300;
/** Below this the box is still being typed into; searching one letter returns half the estate. */
const MIN_QUERY_LENGTH = 2;
const RADIUS_OPTIONS = [1, 2, 5] as const;

const headerCell = "whitespace-nowrap px-3 py-2 text-left text-xs font-black uppercase tracking-[0.12em] text-slate-500";
const bodyCell = "whitespace-nowrap px-3 py-2 text-sm font-semibold text-slate-700";

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as (T & { message?: string }) | null;
  if (!response.ok) {
    throw new Error(payload?.message ?? `Request failed with ${response.status}.`);
  }
  if (!payload) throw new Error("The server returned an empty response.");
  return payload;
}

export function PharmacySearchWorkspace() {
  const [query, setQuery] = useState("");
  const [radiusKm, setRadiusKm] = useState<number>(2);

  const [results, setResults] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [profile, setProfile] = useState<PharmacyProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [candidates, setCandidates] = useState<ExternalCandidate[] | null>(null);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Every async result checks its own generation before writing state, so a slow response for an
  // old query can never overwrite a newer one — the classic search-box race.
  const generation = useRef(0);

  const trimmedQuery = query.trim();
  // Whether the box holds enough to search is DERIVED from the query, never stored — storing it
  // would mean resetting three pieces of state from inside the effect, which cascades a render.
  const queryTooShort = trimmedQuery.length < MIN_QUERY_LENGTH;

  useEffect(() => {
    if (trimmedQuery.length < MIN_QUERY_LENGTH) {
      // Nothing to fetch and nothing to reset — `queryTooShort` already hides the stale results,
      // and bumping the generation makes any in-flight response land on a dead generation.
      generation.current += 1;
      return;
    }

    generation.current += 1;
    const current = generation.current;

    const timer = setTimeout(() => {
      setSearching(true);
      void (async () => {
        try {
          const response = await fetch(`/api/admin/pharmacy-search?q=${encodeURIComponent(trimmedQuery)}`);
          const payload = await readJson<SearchResponse>(response);
          if (generation.current !== current) return;
          setResults(payload);
          setSearchError(null);
        } catch (error) {
          if (generation.current !== current) return;
          setResults(null);
          setSearchError(error instanceof Error ? error.message : "Search failed.");
        } finally {
          if (generation.current === current) setSearching(false);
        }
      })();
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [trimmedQuery]);

  const openProfile = useCallback(
    async (hit: PharmacySearchHit) => {
      setProfileLoading(true);
      setProfileError(null);
      setSaveMessage(null);
      setCandidates(null);
      try {
        const params = new URLSearchParams({ radius: String(radiusKm) });
        if (hit.distributorCode) params.set("distributor", hit.distributorCode);
        if (hit.customerCode) params.set("code", hit.customerCode);
        params.set("name", hit.name);

        const response = await fetch(`/api/admin/pharmacy-search/profile?${params.toString()}`);
        setProfile(await readJson<PharmacyProfile>(response));
      } catch (error) {
        setProfile(null);
        setProfileError(error instanceof Error ? error.message : "Could not load the pharmacy.");
      } finally {
        setProfileLoading(false);
      }
    },
    [radiusKm],
  );

  const runGoogleSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    setGoogleLoading(true);
    setGoogleError(null);
    setSaveMessage(null);
    try {
      const response = await fetch(`/api/admin/pharmacy-search/external?q=${encodeURIComponent(trimmed)}`);
      const payload = await readJson<{ candidates: ExternalCandidate[] }>(response);
      setCandidates(payload.candidates);
    } catch (error) {
      setCandidates(null);
      setGoogleError(error instanceof Error ? error.message : "Google lookup failed.");
    } finally {
      setGoogleLoading(false);
    }
  }, [query]);

  const openGoogleProfile = useCallback(
    async (candidate: ExternalCandidate) => {
      setProfileLoading(true);
      setProfileError(null);
      setSaveMessage(null);
      try {
        const params = new URLSearchParams({ placeId: candidate.placeId, radius: String(radiusKm) });
        const response = await fetch(`/api/admin/pharmacy-search/external?${params.toString()}`);
        setProfile(await readJson<PharmacyProfile>(response));
      } catch (error) {
        setProfile(null);
        setProfileError(error instanceof Error ? error.message : "Could not load that place.");
      } finally {
        setProfileLoading(false);
      }
    },
    [radiusKm],
  );

  const saveDiscovery = useCallback(async () => {
    if (!profile || profile.origin !== "google") return;
    const placeId = profile.id.startsWith("google:") ? profile.id.slice("google:".length) : "";
    if (!placeId) return;

    setSaving(true);
    setSaveMessage(null);
    try {
      const response = await fetch("/api/admin/pharmacy-search/save", {
        body: JSON.stringify({ notes: null, placeId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await readJson<{ pharmacyName: string }>(response);
      setSaveMessage(`Saved "${payload.pharmacyName}" to the discovery register.`);
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }, [profile]);

  // Everything under the search box is gated on the query still being long enough. Deriving these
  // is what lets the effect above reset nothing: shortening the query hides the previous answer
  // without any state having to be un-set, and a response that lands after the query was cleared
  // has nowhere to show itself.
  const visibleResults = queryTooShort ? null : results;
  const visibleSearchError = queryTooShort ? null : searchError;
  const isSearching = searching && !queryTooShort;

  const showGooglePrompt = useMemo(
    () => Boolean(visibleResults?.isEmpty) && !isSearching,
    [isSearching, visibleResults?.isEmpty],
  );

  const saveAction =
    profile?.origin === "google" ? (
      <button
        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded border border-orange-300 bg-orange-500 px-3 py-2 text-xs font-black text-white transition hover:bg-orange-600 disabled:opacity-60"
        disabled={saving}
        onClick={() => void saveDiscovery()}
        type="button"
      >
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
        Save to database
      </button>
    ) : null;

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200/90 bg-white/95 p-5 shadow-[0_20px_48px_rgba(15,23,42,0.10)]">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              aria-label="Search pharmacies by name, code or distributor"
              className={`${portalInputClassName} pl-9`}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Pharmacy name, distributor name, or a code — Arabic or English"
              type="search"
              value={query}
            />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="whitespace-nowrap text-xs font-black uppercase tracking-[0.12em] text-slate-500">
              Radius
            </span>
            {RADIUS_OPTIONS.map((option) => (
              <button
                className={`whitespace-nowrap rounded border px-3 py-2 text-xs font-black transition ${
                  radiusKm === option
                    ? "border-orange-300 bg-orange-50 text-orange-700"
                    : "border-slate-200 bg-white text-slate-600 hover:border-orange-200"
                }`}
                key={option}
                onClick={() => setRadiusKm(option)}
                type="button"
              >
                {option} km
              </button>
            ))}
          </div>
        </div>

        {isSearching ? (
          <p className="mt-3 flex items-center gap-2 text-xs font-bold text-slate-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Searching the customer database…
          </p>
        ) : null}

        {visibleResults?.matchedDistributorName ? (
          <p className="mt-3 text-xs font-bold text-slate-600">
            Showing pharmacies carried by {visibleResults.matchedDistributorName}.
          </p>
        ) : null}

        {visibleResults?.truncated ? (
          <p className="mt-2 text-xs font-bold text-amber-700">
            More matches exist than are shown — narrow the search to see the rest.
          </p>
        ) : null}
      </section>

      {visibleSearchError ? (
        <AdminCallout tone="danger">
          <p className="font-semibold">{visibleSearchError}</p>
        </AdminCallout>
      ) : null}

      {visibleResults && visibleResults.hits.length > 0 ? (
        <section className="overflow-hidden rounded-2xl border border-slate-200/90 bg-white/95 shadow-[0_20px_48px_rgba(15,23,42,0.10)]">
          <div className="border-b border-slate-200/80 bg-gradient-to-b from-white to-slate-50/50 px-4 py-3.5">
            <h2 className="whitespace-nowrap text-sm font-black tracking-tight text-slate-900">
              {visibleResults.hits.length} match{visibleResults.hits.length === 1 ? "" : "es"} in the database
            </h2>
            <p className="mt-1 text-xs font-semibold text-slate-500">
              Pick one to see its brick, area, region, distributor codes and the doctors around it.
            </p>
          </div>
          <PortalResponsiveDataList
            empty={<div className="px-4 py-6 text-center text-sm font-semibold text-slate-500">No matches.</div>}
            getKey={(hit) => hit.id}
            items={visibleResults.hits}
            renderCard={(hit) => (
              <button className="w-full text-left" onClick={() => void openProfile(hit)} type="button">
                <PortalRecordCard
                  accent="orange"
                  meta={hit.address ?? "No address recorded"}
                  status={
                    <span className="whitespace-nowrap text-xs font-black text-slate-500">
                      {hit.distributorCount} distributor{hit.distributorCount === 1 ? "" : "s"}
                    </span>
                  }
                  title={hit.name}
                >
                  <PortalRecordFields
                    fields={[
                      { label: "Brick", value: hit.territory.brickName ?? hit.territory.brickId ?? "—" },
                      { label: "Area", value: hit.territory.areaName ?? "—" },
                      { label: "Region", value: hit.territory.regionName ?? "—" },
                      { label: "Code", value: hit.customerCode ?? "—" },
                    ]}
                  />
                </PortalRecordCard>
              </button>
            )}
            renderTable={() => (
              <PortalDesktopTable minWidth="960px">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className={headerCell}>Pharmacy</th>
                    <th className={headerCell}>Brick</th>
                    <th className={headerCell}>Area</th>
                    <th className={headerCell}>Region</th>
                    <th className={headerCell}>Distributor</th>
                    <th className={headerCell}>Code</th>
                    <th className={headerCell}>Address</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleResults.hits.map((hit) => (
                    <tr
                      className="cursor-pointer border-b border-slate-100 transition hover:bg-orange-50/60"
                      key={hit.id}
                      onClick={() => void openProfile(hit)}
                    >
                      <td className={`${bodyCell} font-black text-slate-900`}>{hit.name}</td>
                      <td className={bodyCell}>{hit.territory.brickName ?? hit.territory.brickId ?? "—"}</td>
                      <td className={bodyCell}>{hit.territory.areaName ?? "—"}</td>
                      <td className={bodyCell}>{hit.territory.regionName ?? "—"}</td>
                      <td className={bodyCell}>
                        {hit.distributorName ?? "—"}
                        {hit.distributorCount > 1 ? ` +${hit.distributorCount - 1}` : ""}
                      </td>
                      <td className={`${bodyCell} font-mono`}>{hit.customerCode ?? "—"}</td>
                      <td className={bodyCell}>{hit.address ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </PortalDesktopTable>
            )}
          />
        </section>
      ) : null}

      {showGooglePrompt ? (
        <section className="rounded-2xl border border-amber-200/90 bg-gradient-to-r from-amber-50/95 to-white p-5 shadow-[0_8px_20px_rgba(245,158,11,0.12)]">
          <h2 className="whitespace-nowrap text-sm font-black tracking-tight text-amber-900">
            Not in the Phoenix database
          </h2>
          <p className="mt-1 text-sm font-semibold leading-6 text-amber-900/80">
            Nothing matched &quot;{query.trim()}&quot;. Search Google Maps for it — the result is snapped to the
            nearest brick centroid to work out its area and region, and the doctors our reps visit around
            that point are listed too.
          </p>
          <button
            className="mt-3 inline-flex items-center gap-1.5 whitespace-nowrap rounded border border-amber-300 bg-white px-3 py-2 text-xs font-black text-amber-900 transition hover:border-orange-300 hover:text-orange-700 disabled:opacity-60"
            disabled={googleLoading}
            onClick={() => void runGoogleSearch()}
            type="button"
          >
            {googleLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe className="h-3.5 w-3.5" />}
            Search Google Maps
          </button>

          {googleError ? <p className="mt-3 text-xs font-bold text-rose-700">{googleError}</p> : null}

          {candidates && candidates.length === 0 ? (
            <p className="mt-3 text-xs font-bold text-amber-900">Google found nothing for that name either.</p>
          ) : null}

          {candidates && candidates.length > 0 ? (
            <ul className="mt-4 divide-y divide-amber-200/70 border border-amber-200/70 bg-white">
              {candidates.map((candidate) => (
                <li key={candidate.placeId}>
                  <button
                    className="flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left transition hover:bg-amber-50"
                    onClick={() => void openGoogleProfile(candidate)}
                    type="button"
                  >
                    <span className="whitespace-nowrap text-sm font-black text-slate-900">{candidate.primaryText}</span>
                    <span className="text-xs font-semibold text-slate-500">
                      {candidate.secondaryText ?? candidate.description}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {profileLoading ? (
        <p className="flex items-center gap-2 text-sm font-bold text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Building the pharmacy profile…
        </p>
      ) : null}

      {profileError ? (
        <AdminCallout tone="danger">
          <p className="font-semibold">{profileError}</p>
        </AdminCallout>
      ) : null}

      {saveMessage ? (
        <AdminCallout tone="success">
          <p className="font-semibold">{saveMessage}</p>
        </AdminCallout>
      ) : null}

      {profile && !profileLoading ? (
        <PharmacyProfilePanel actions={saveAction} profile={profile} radiusKm={radiusKm} />
      ) : null}
    </div>
  );
}
