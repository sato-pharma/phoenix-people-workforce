"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  candidateFolderKeyLabels,
  candidateFolderKindLabels,
  candidateFolderLabel,
  candidateFolderRefusal,
  districtManagerFolderOptions,
  type CandidateFolderKind,
} from "@/lib/recruitment/candidate-folder";
import { suggestFolderFromDeclaredAnswers } from "@/lib/recruitment/candidate-folder-suggestion";
import type { CandidateFolderAreaOption } from "@/lib/recruitment/candidate-folder-options";
import { managerFolderKinds, type ManagerFolderFiling } from "@/lib/recruitment/manager-folder-shelf";
import type { Candidate } from "@/lib/recruitment/types";

/**
 * "File this CV for later" — the manager's own shelf, on one candidate card.
 *
 * The owner, 2026-08-30: *"and I want him to have a folders like like me."* He had just been given
 * the recruiter's shelf and asked for the same thing on the receiving side, which is the sharper
 * need of the two: a District Manager sent five CVs, wanting one, has exactly two answers for the
 * other four today — "Interview" or "Not interested" — and neither is true of a good CV that is not
 * needed this month.
 *
 * THE ONE THING TO KNOW BEFORE EDITING THIS. It writes to the MANAGER's table, not to the candidate
 * row. The recruiter's near-identical control files through the route under
 * `api/recruitment/candidates/[id]/folder`, which takes the CV out of the pool every recruiter works
 * from; this one files through `api/recruitment/hiring-manager/candidates/[candidateId]/folder` and
 * Talent Acquisition's screen does not move. Pointing this at the other URL would make a District
 * Manager tidying his inbox delete CVs from recruitment's queue, invisibly. See
 * manager-folder-shelf.ts.
 *
 * The shelves, the labels and the key vocabulary are imported from the recruiter's own module rather
 * than restated, so "Medical Representative → Nasr City" means one thing across both screens.
 */
export function CandidateFolderControl({
  areaOptions,
  candidate,
  filing,
  onChanged,
}: {
  areaOptions: CandidateFolderAreaOption[];
  candidate: Candidate;
  /** This manager's filing of this CV, or null when it is still in his live list. */
  filing: ManagerFolderFiling | null;
  onChanged: (filing: ManagerFolderFiling | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Where the candidate's OWN answers say they belong, used to pre-select the picker. Only ever a
  // starting point — the manager can change both halves before pressing File, and a candidate who
  // never answered simply opens on the first shelf with nothing chosen.
  // A shelf this manager cannot see is not a starting point either: a <select> whose value matches
  // none of its options renders blank and files nothing, so the suggestion has to pass the same list
  // the options come from rather than be trusted because it happens not to produce one today.
  const declared = suggestFolderFromDeclaredAnswers({ ...candidate, folder: null }).suggestion;
  const suggested = declared && managerFolderKinds.includes(declared.kind) ? declared : null;
  const [kind, setKind] = useState<CandidateFolderKind>(suggested?.kind ?? "medical_rep");
  const [key, setKey] = useState(suggested?.key ?? "");

  // The recruiter's own rule, imported rather than restated: a rejected CV is not waiting on a seat,
  // and filing it would put an answered candidate into a folder somebody opens next March.
  const refusal = candidateFolderRefusal(candidate);

  const send = async (body: object | null) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/recruitment/hiring-manager/candidates/${candidate.id}/folder`, {
        body: body ? JSON.stringify(body) : undefined,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        method: body ? "PATCH" : "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error(typeof data.message === "string" ? data.message : "That did not save.");
      }
      onChanged((data.filing as ManagerFolderFiling | undefined) ?? null);
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not save.");
    } finally {
      setBusy(false);
    }
  };

  if (filing) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2">
        <span className="whitespace-nowrap text-xs font-semibold text-amber-900">
          In your folder · {candidateFolderKindLabels[filing.kind]} · {candidateFolderLabel(filing.kind, filing.key)}
        </span>
        <button
          className="whitespace-nowrap rounded-md border border-amber-300 bg-white px-2.5 py-1 text-phx-xs font-semibold text-amber-900 transition hover:bg-amber-100 disabled:opacity-50"
          disabled={busy}
          onClick={() => void send(null)}
          type="button"
        >
          {busy ? "Working…" : "Return to my list"}
        </button>
        {error ? <span className="text-phx-xs text-rose-600">{error}</span> : null}
      </div>
    );
  }

  if (refusal) {
    // Shown rather than hidden. A card with no button and no reason reads as a bug; this reads as an
    // answer, and it is the same sentence the API would give back.
    return <p className="text-phx-xs text-slate-400">{refusal}</p>;
  }

  if (!open) {
    return (
      <button
        className="w-fit whitespace-nowrap rounded-md border border-gray-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
        onClick={() => setOpen(true)}
        type="button"
      >
        Keep for later
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-sky-200 bg-sky-50/60 p-3">
      <p className="text-phx-xs font-semibold uppercase tracking-wide text-sky-900">
        Keep this CV in one of your folders
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <select
          className="h-9 w-full min-w-0 rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-900 sm:w-56"
          onChange={(event) => {
            setKind(event.target.value as CandidateFolderKind);
            // The key means a different thing on every shelf, so carrying "Nasr City" over to the
            // region shelf would file the CV under a region that does not exist.
            setKey("");
          }}
          value={kind}
        >
          {/*
            managerFolderKinds, NOT the recruiter's full list. Paramedical is an eligibility answer
            the recruitment team applies, and a manager's shelf never shows it — offering it here
            would let him file a CV onto a shelf he cannot then open, which loses it from his live
            list and shows it nowhere. One list drives both the picker and the shelves.
          */}
          {managerFolderKinds.map((option) => (
            <option key={option} value={option}>
              {candidateFolderKindLabels[option]}
            </option>
          ))}
        </select>
        <FolderKeyInput
          areaOptions={areaOptions}
          candidateId={candidate.id}
          kind={kind}
          onChange={setKey}
          value={key}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy || key.trim().length === 0} onClick={() => void send({ key, kind })}>
          {busy ? "Filing…" : "File it"}
        </Button>
        <button
          className="whitespace-nowrap rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
          onClick={() => setOpen(false)}
          type="button"
        >
          Cancel
        </button>
        {error ? <span className="text-phx-xs text-rose-600">{error}</span> : null}
      </div>
    </div>
  );
}

/**
 * The second question, which is a different question on each shelf.
 *
 * A Medical Representative is filed by AREA, a District Manager by REGION, anything else by a typed
 * JOB TITLE — so picking the shelf changes what this control even is. Areas are grouped under their
 * RECRUITMENT region, which is not always their sales region: Sharkia files under Delta (3) here and
 * under Delta (2) in the sales geography, deliberately, and `candidate-folder-options.ts` is where
 * that rule lives.
 */
function FolderKeyInput({
  areaOptions,
  candidateId,
  kind,
  onChange,
  value,
}: {
  areaOptions: CandidateFolderAreaOption[];
  candidateId: string;
  kind: CandidateFolderKind;
  onChange: (value: string) => void;
  value: string;
}) {
  const regionOptions = districtManagerFolderOptions();

  if (kind === "other") {
    return (
      <input
        className="h-9 w-full min-w-0 rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-900"
        id={`manager-folder-key-${candidateId}`}
        onChange={(event) => onChange(event.target.value)}
        placeholder={candidateFolderKeyLabels.other}
        value={value}
      />
    );
  }

  const areasByRegion = new Map<string, string[]>();
  for (const area of areaOptions) {
    const list = areasByRegion.get(area.regionCode);
    if (list) list.push(area.name);
    else areasByRegion.set(area.regionCode, [area.name]);
  }

  return (
    <select
      className="h-9 w-full min-w-0 rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-900"
      id={`manager-folder-key-${candidateId}`}
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      <option value="">{`Choose a ${candidateFolderKeyLabels[kind].toLowerCase()}…`}</option>
      {kind === "district_manager"
        ? regionOptions.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))
        : regionOptions.map((region) => {
            const areas = areasByRegion.get(region.key) ?? [];
            if (areas.length === 0) return null;
            return (
              <optgroup key={region.key} label={region.label}>
                {areas.map((area) => (
                  <option key={area} value={area}>
                    {area}
                  </option>
                ))}
              </optgroup>
            );
          })}
    </select>
  );
}
