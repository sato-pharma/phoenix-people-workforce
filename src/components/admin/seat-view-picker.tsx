"use client";

import * as React from "react";

import { FormField } from "@/components/ui/form-kit";
import { phxButtonAccentClassName, phxFormErrorClassName, phxFormPanelClassName } from "@/components/ui/form-tokens";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { DevPreviewCandidate } from "@/lib/auth/dev-preview-picker";
import type { PhoenixRole } from "@/lib/auth/permissions";
import { SEAT_VIEW_START_PATH } from "@/lib/auth/seat-view-constants";
import { hardNavigate } from "@/lib/navigation/browser-navigation";
import { cn } from "@/lib/utils";

// VIEW AS SEAT picker (src/lib/auth/seat-view.ts). An office seat is opened by its title alone; a field
// or portal seat needs one real person holding it, narrowed Line -> Region -> Area -> Name. The server
// checks the person again (seat-view-service.ts), so nothing picked here is trusted.

export type SeatViewPickerChoice = {
  role: PhoenixRole;
  label: string;
  group: "office" | "portal";
};

const ANY = "";

function distinctSorted(values: Array<string | null>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function matching(candidates: DevPreviewCandidate[], filters: { area?: string; line?: string; region?: string }) {
  return candidates.filter(
    (candidate) =>
      (!filters.line || candidate.lineName === filters.line) &&
      (!filters.region || candidate.regionName === filters.region) &&
      (!filters.area || candidate.areaName === filters.area),
  );
}

export function SeatViewPicker({
  candidatesByRole,
  choices,
}: {
  candidatesByRole: Partial<Record<PhoenixRole, DevPreviewCandidate[]>>;
  choices: SeatViewPickerChoice[];
}) {
  const officeChoices = choices.filter((choice) => choice.group === "office");
  const portalChoices = choices.filter((choice) => choice.group === "portal");

  const [role, setRole] = React.useState<PhoenixRole | "">(officeChoices[0]?.role ?? portalChoices[0]?.role ?? "");
  const choice = choices.find((option) => option.role === role) ?? null;
  const isPortal = choice?.group === "portal";
  const candidates = (role ? candidatesByRole[role] : undefined) ?? [];

  const [line, setLine] = React.useState(ANY);
  const [region, setRegion] = React.useState(ANY);
  const [area, setArea] = React.useState(ANY);
  const [hrId, setHrId] = React.useState(ANY);
  const [opening, setOpening] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Each level clears every level beneath it, adjusted during render (React's pattern for derived state).
  const [prevRole, setPrevRole] = React.useState(role);
  if (role !== prevRole) {
    setPrevRole(role);
    setLine(ANY);
    setRegion(ANY);
    setArea(ANY);
    setHrId(ANY);
  }
  const [prevLine, setPrevLine] = React.useState(line);
  if (line !== prevLine) {
    setPrevLine(line);
    setRegion(ANY);
    setArea(ANY);
    setHrId(ANY);
  }
  const [prevRegion, setPrevRegion] = React.useState(region);
  if (region !== prevRegion) {
    setPrevRegion(region);
    setArea(ANY);
    setHrId(ANY);
  }
  const [prevArea, setPrevArea] = React.useState(area);
  if (area !== prevArea) {
    setPrevArea(area);
    setHrId(ANY);
  }

  // Coming back to this page out of the browser's page cache restores a locked button; unlock it.
  React.useEffect(() => {
    function onPageShow(event: PageTransitionEvent) {
      if (event.persisted) setOpening(false);
    }
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  const lineOptions = distinctSorted(candidates.map((candidate) => candidate.lineName));
  const regionOptions = distinctSorted(matching(candidates, { line }).map((candidate) => candidate.regionName));
  const areaOptions = distinctSorted(matching(candidates, { line, region }).map((candidate) => candidate.areaName));
  const nameOptions = matching(candidates, { area, line, region });
  const person = isPortal ? nameOptions.find((candidate) => candidate.hrId === hrId) ?? null : null;

  const canOpen = Boolean(choice) && (!isPortal || Boolean(person)) && !opening;
  const openLabel = choice
    ? person
      ? `View as ${person.fullName} · ${choice.label}`
      : `View as ${choice.label}`
    : "Pick a seat";

  async function open() {
    if (!canOpen || !choice) return;
    setOpening(true);
    setError(null);
    try {
      const response = await fetch(SEAT_VIEW_START_PATH, {
        body: JSON.stringify({ hrId: person?.hrId ?? null, role: choice.role }),
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as { landingPath?: string; message?: string };
      if (!response.ok || !payload.landingPath) {
        setError(payload.message ?? "The view could not be opened.");
        setOpening(false);
        return;
      }
      hardNavigate(payload.landingPath);
    } catch {
      setError("The view could not be opened. Check the connection and try again.");
      setOpening(false);
    }
  }

  return (
    <div className={cn(phxFormPanelClassName, "max-w-xl p-6")}>
      {error ? <div className={cn(phxFormErrorClassName, "mb-4")}>{error}</div> : null}

      <div className="space-y-4">
        <FormField htmlFor="seat-view-seat" label="Seat">
          <SearchableSelect
            aria-label="Seat"
            id="seat-view-seat"
            onValueChange={(value) => setRole(value as PhoenixRole)}
            value={role}
            wrapValue
          >
            <optgroup label="Office seats">
              {officeChoices.map((option) => (
                <option key={option.role} value={option.role}>
                  {option.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Field & portal seats — pick a person">
              {portalChoices.map((option) => (
                <option key={option.role} value={option.role}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          </SearchableSelect>
        </FormField>

        {isPortal ? (
          <>
            <FormField htmlFor="seat-view-line" label="Line">
              <SearchableSelect aria-label="Line" id="seat-view-line" onValueChange={setLine} value={line}>
                <option value={ANY}>{lineOptions.length ? "Any line" : "No line for this seat"}</option>
                {lineOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </SearchableSelect>
            </FormField>

            <FormField htmlFor="seat-view-region" label="Region">
              <SearchableSelect aria-label="Region" id="seat-view-region" onValueChange={setRegion} value={region}>
                <option value={ANY}>{regionOptions.length ? "Any region" : "No region for this choice"}</option>
                {regionOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </SearchableSelect>
            </FormField>

            <FormField htmlFor="seat-view-area" label="Area">
              <SearchableSelect aria-label="Area" id="seat-view-area" onValueChange={setArea} value={area}>
                <option value={ANY}>{areaOptions.length ? "Any area" : "No area for this choice"}</option>
                {areaOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </SearchableSelect>
            </FormField>

            <FormField
              hint={nameOptions.length ? `${nameOptions.length} active people hold this seat here.` : undefined}
              htmlFor="seat-view-name"
              label="Person"
              required
            >
              <SearchableSelect aria-label="Person" id="seat-view-name" onValueChange={setHrId} value={hrId} wrapValue>
                <option value={ANY}>{nameOptions.length ? "Pick a person" : "Nobody active holds this seat here"}</option>
                {nameOptions.map((candidate) => (
                  <option key={candidate.hrId} value={candidate.hrId}>
                    {candidate.fullName}
                    {candidate.areaName ? ` — ${candidate.areaName}` : ""}
                  </option>
                ))}
              </SearchableSelect>
            </FormField>
          </>
        ) : null}

        <button className={phxButtonAccentClassName} disabled={!canOpen} onClick={open} type="button">
          {opening ? "Opening the view…" : openLabel}
        </button>

        <p className="text-xs leading-5 text-slate-500">
          {isPortal
            ? "You will see this person's portal with their real data. "
            : "You will see the seat's pages, menus and data as its holder would. "}
          Read only: every save, send, approval and export is refused, and nothing is recorded as done by the seat.
          Your own sign-in stays as it is. The view ends by itself after one hour, or when you press Exit view.
        </p>
      </div>
    </div>
  );
}
