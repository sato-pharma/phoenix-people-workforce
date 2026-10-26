"use client";

import * as React from "react";

import { SearchableSelect } from "@/components/ui/searchable-select";
import type { PhoenixRole } from "@/lib/auth/permissions";
import type { DevPreviewCandidate } from "@/lib/auth/dev-preview-picker";

const ANY_VALUE = "";
const AUTO_PICK_VALUE = "";

function isPhoenixRole(value: string | null, roles: readonly PhoenixRole[]): value is PhoenixRole {
  return value != null && (roles as readonly string[]).includes(value);
}

function distinctSorted(values: Array<string | null>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function candidatesMatching(
  candidates: DevPreviewCandidate[],
  filters: { area?: string; line?: string; region?: string },
) {
  return candidates.filter(
    (candidate) =>
      (!filters.line || candidate.lineName === filters.line) &&
      (!filters.region || candidate.regionName === filters.region) &&
      (!filters.area || candidate.areaName === filters.area),
  );
}

export function DevPreviewPicker({
  error,
  initialArea,
  initialCandidates,
  initialLine,
  initialRegion,
  initialRole,
  roles,
}: {
  error: string | null;
  initialArea: string | null;
  initialCandidates: DevPreviewCandidate[];
  initialLine: string | null;
  initialRegion: string | null;
  initialRole: PhoenixRole;
  roles: readonly PhoenixRole[];
}) {
  const [role, setRole] = React.useState<PhoenixRole>(
    isPhoenixRole(initialRole, roles) ? initialRole : roles[0],
  );
  const [candidatesByRole, setCandidatesByRole] = React.useState<Partial<Record<PhoenixRole, DevPreviewCandidate[]>>>(
    () => ({ [role]: initialCandidates }),
  );

  // Derived, not state: whether role's catalog hasn't arrived yet (see the fetch effect below).
  const isLoading = candidatesByRole[role] === undefined;
  const candidates = candidatesByRole[role] ?? [];
  const lineOptions = distinctSorted(candidates.map((candidate) => candidate.lineName));

  const [line, setLine] = React.useState<string>(initialLine && lineOptions.includes(initialLine) ? initialLine : ANY_VALUE);
  const regionOptions = distinctSorted(candidatesMatching(candidates, { line }).map((candidate) => candidate.regionName));

  const [region, setRegion] = React.useState<string>(
    initialRegion && regionOptions.includes(initialRegion) ? initialRegion : ANY_VALUE,
  );
  const areaOptions = distinctSorted(candidatesMatching(candidates, { line, region }).map((candidate) => candidate.areaName));

  const [area, setArea] = React.useState<string>(initialArea && areaOptions.includes(initialArea) ? initialArea : ANY_VALUE);
  const nameOptions = candidatesMatching(candidates, { area, line, region }).sort((a, b) =>
    a.fullName.localeCompare(b.fullName),
  );

  const [hrId, setHrId] = React.useState<string>(AUTO_PICK_VALUE);

  // Set by the first click on Launch and kept: the launch is three hops plus a first compile of the
  // landing page — a minute on this laptop — and a second click in that time used to land on a raw
  // "forbidden" page, because the first click had already switched this browser into the preview
  // (see `isDevPreviewReplay` in src/lib/auth/dev-preview.ts).
  const [launching, setLaunching] = React.useState(false);

  // Coming BACK to this page out of the browser's page cache restores the locked button; unlock it.
  React.useEffect(() => {
    function onPageShow(event: PageTransitionEvent) {
      if (event.persisted) setLaunching(false);
    }
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  // Fetch the candidate catalog for a newly selected role on demand (cached per role).
  // `isLoading` above derives purely from candidatesByRole[role] being absent — no separate
  // loading state to keep in sync with this effect.
  React.useEffect(() => {
    if (candidatesByRole[role]) return;
    let cancelled = false;

    fetch(`/api/dev-auth/candidates?role=${encodeURIComponent(role)}`)
      .then((response) => response.json())
      .then((data: { candidates?: DevPreviewCandidate[] }) => {
        if (cancelled) return;
        setCandidatesByRole((previous) => ({ ...previous, [role]: data.candidates ?? [] }));
      })
      .catch(() => {
        if (!cancelled) setCandidatesByRole((previous) => ({ ...previous, [role]: [] }));
      });

    return () => {
      cancelled = true;
    };
  }, [role, candidatesByRole]);

  // Each block below adjusts state directly during render (React's documented pattern for
  // derived state — see the equivalent single-level version this replaced) rather than in an
  // effect, so a change at one cascade level clears every level beneath it before this render
  // commits: Role clears Line/Region/Area/Name; Line clears Region/Area/Name; and so on.
  const [prevRole, setPrevRole] = React.useState(role);
  if (role !== prevRole) {
    setPrevRole(role);
    setLine(ANY_VALUE);
    setRegion(ANY_VALUE);
    setArea(ANY_VALUE);
    setHrId(AUTO_PICK_VALUE);
  }

  const [prevLine, setPrevLine] = React.useState(line);
  if (line !== prevLine) {
    setPrevLine(line);
    setRegion(ANY_VALUE);
    setArea(ANY_VALUE);
    setHrId(AUTO_PICK_VALUE);
  }

  const [prevRegion, setPrevRegion] = React.useState(region);
  if (region !== prevRegion) {
    setPrevRegion(region);
    setArea(ANY_VALUE);
    setHrId(AUTO_PICK_VALUE);
  }

  const [prevArea, setPrevArea] = React.useState(area);
  if (area !== prevArea) {
    setPrevArea(area);
    setHrId(AUTO_PICK_VALUE);
  }

  const previewParams = new URLSearchParams({ role });
  if (hrId) {
    previewParams.set("hrId", hrId);
  } else {
    if (line) previewParams.set("line", line);
    if (region) previewParams.set("region", region);
    if (area) previewParams.set("area", area);
  }
  // The switch is a POST (audit point 17, 2026-10-26): it ends this browser's real session, so it is
  // never a link a page elsewhere could fire. The fields travel as hidden inputs of one form.
  const previewFields = [...previewParams.entries()];
  const pickedName = nameOptions.find((candidate) => candidate.hrId === hrId);
  const launchLabel = pickedName ? pickedName.fullName : `an auto-picked ${role}`;

  return (
    <div className="max-w-xl border border-slate-200 bg-white p-6 shadow-[0_4px_16px_rgba(15,23,42,0.07)]">
      {error === "no_candidate" ? (
        <div className="mb-4 border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
          No active employee found for that combination. Try widening line/region/area, or another role.
        </div>
      ) : null}

      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-500" htmlFor="dev-preview-role">
            Role
          </label>
          <SearchableSelect
            aria-label="Role"
            id="dev-preview-role"
            onValueChange={(value) => setRole(value as PhoenixRole)}
            value={role}
          >
            {roles.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </SearchableSelect>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-500" htmlFor="dev-preview-line">
            Line
          </label>
          <SearchableSelect aria-label="Line" disabled={isLoading} id="dev-preview-line" onValueChange={setLine} value={line}>
            <option value={ANY_VALUE}>Any line ({lineOptions.length ? "auto-pick" : "none for this role"})</option>
            {lineOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </SearchableSelect>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-500" htmlFor="dev-preview-region">
            Region
          </label>
          <SearchableSelect
            aria-label="Region"
            disabled={isLoading}
            id="dev-preview-region"
            onValueChange={setRegion}
            value={region}
          >
            <option value={ANY_VALUE}>Any region ({regionOptions.length ? "auto-pick" : "none for this selection"})</option>
            {regionOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </SearchableSelect>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-500" htmlFor="dev-preview-area">
            Area / District (DM territory)
          </label>
          <SearchableSelect aria-label="Area" disabled={isLoading} id="dev-preview-area" onValueChange={setArea} value={area}>
            <option value={ANY_VALUE}>Any area ({areaOptions.length ? "auto-pick" : "none for this selection"})</option>
            {areaOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </SearchableSelect>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-500" htmlFor="dev-preview-name">
            Name
          </label>
          {/* wrapValue: the default label and "Name — Area" are wider than a phone-width field, which
              clipped them mid-word ("Auto-pick a real active employee (r"). */}
          <SearchableSelect
            aria-label="Name"
            disabled={isLoading}
            id="dev-preview-name"
            onValueChange={setHrId}
            value={hrId}
            wrapValue
          >
            <option value={AUTO_PICK_VALUE}>Auto-pick a real active employee (recommended)</option>
            {nameOptions.map((candidate) => (
              <option key={candidate.hrId} value={candidate.hrId}>
                {candidate.fullName}
                {candidate.areaName ? ` — ${candidate.areaName}` : ""}
              </option>
            ))}
          </SearchableSelect>
          {isLoading ? <p className="mt-1 text-xs text-slate-400">Loading {role} candidates…</p> : null}
        </div>

        <form
          action="/api/dev-auth/preview"
          method="post"
          onSubmit={(event) => {
            if (launching) {
              event.preventDefault();
              return;
            }
            setLaunching(true);
          }}
        >
          {previewFields.map(([name, value]) => (
            <input key={name} name={name} type="hidden" value={value} />
          ))}
          <button
            aria-disabled={launching || undefined}
            className={`inline-flex items-center justify-center bg-orange-600 px-4 py-2 text-sm font-bold text-white shadow-[0_8px_20px_rgba(234,88,12,0.25)] transition ${
              launching ? "cursor-wait opacity-70" : "hover:bg-orange-700"
            }`}
            type="submit"
          >
            {launching ? `Opening preview as ${launchLabel}…` : `Launch preview as ${launchLabel}`}
          </button>
        </form>

        {launching ? (
          <p aria-live="polite" className="text-xs font-semibold text-slate-600">
            Switching you over. The first open of a page compiles it on this laptop and can take a minute — there is
            no need to click again.
          </p>
        ) : null}

        <p className="text-xs leading-5 text-slate-500">
          This ends your current admin session in this browser and starts an 8-hour preview session as{" "}
          {pickedName ? pickedName.fullName : `a real, active ${role} (auto-picked)`}, with their genuine data. Sign
          back in normally afterward to return to your own account.
        </p>
      </div>
    </div>
  );
}
