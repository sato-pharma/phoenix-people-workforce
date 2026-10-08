"use client";

/**
 * Phoenix CRM — validations the system never held, and the Super Admin's power to refuse one.
 *
 * The Google check covers AM customers only (`googleCheckApplies`), so a doctor's validation is never
 * held and never appears in the queue above; an AM one that matched its listing does not either. Before
 * this list there was no way to take one back — it had to be undone in SQL.
 *
 * Refusing writes the same review the automatic check would have written and runs the same reject, so
 * the rep reads the system's own wording ("The system could not confirm this place") and never that
 * a person looked at him. Since 2026-10-08 the Super Admin also picks WHAT IS WRONG WITH THE PHOTO from
 * a closed list, and that one sentence is the only thing the rep is told; the note is still required
 * and is still kept on the record, never shown to him.
 *
 * Desktop draws the module's `CrmTable` (`table-fixed` with a colgroup, never a min-width in a
 * scroller); a phone draws the same rows as cards. Square corners throughout.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import { RefusalNoteHint, RefusalReasonField } from "@/components/phoenix-crm/refusal-reason-field";
import {
  CrmButton,
  CrmCardsOnPhone,
  CrmEmpty,
  CrmNote,
  CrmPill,
  CrmSearchField,
  CrmShowMore,
  CrmTable,
  crmTdClassName,
  crmTextareaClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import { VALIDATION_NOTE_LABEL, type ValidationRefusalReason } from "@/lib/phoenix-crm/validation-feedback";
import type { ValidatedPlaceRow } from "@/lib/phoenix-crm/view-types";

/** What the system read on the signboard, in the Super Admin's words. A verdict, never a decision. */
const SIGNBOARD_TEXT: Record<NonNullable<ValidatedPlaceRow["signboard"]>["verdict"], string> = {
  match: "The signboard names this customer",
  other_name: "The signboard names somebody else",
  no_name: "No name to judge on the signboard",
  unjudged: "The signboard could not be read",
};

const PAGE = 25;

function readingText(label: string, reading: ValidatedPlaceRow["pin"]): string | null {
  if (!reading) return null;
  const accuracy = reading.accuracyMeters === null ? "accuracy unknown" : `within ${Math.round(reading.accuracyMeters)} m`;
  return `${label}: ${reading.lat.toFixed(5)}, ${reading.lon.toFixed(5)} (${accuracy})`;
}

function Who({ row }: { row: ValidatedPlaceRow }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="break-words text-sm font-black text-slate-900" dir="auto">
        {row.customerName}
      </p>
      <p className="break-words text-xs font-semibold text-slate-500">{[row.listType, row.speciality].filter(Boolean).join(" · ")}</p>
      <p className="break-words text-sm text-slate-700">{row.repName}</p>
      <p className="break-words text-xs text-slate-500">{row.territory}</p>
      <p className="break-words text-xs text-slate-500">Validated {row.validatedAtText}</p>
      <div className="flex min-w-0 flex-wrap gap-1">
        {row.reviewed ? null : <CrmPill tone="info">Never looked at</CrmPill>}
        {row.isTest ? <CrmPill>Test entry</CrmPill> : null}
      </div>
    </div>
  );
}

function Place({ row }: { row: ValidatedPlaceRow }) {
  const readings = [readingText("Photo", row.photo), readingText("Capture location", row.pin)].filter((line): line is string => line !== null);
  return (
    <div className="min-w-0 space-y-0.5 text-sm text-slate-700">
      {row.placeLabel ? (
        <p className="break-words font-semibold" dir="auto">
          {row.placeLabel}
        </p>
      ) : null}
      {row.address ? <p className="break-words text-xs text-slate-500">{row.address}</p> : null}
      {row.brickName || row.areaName ? <p className="break-words text-xs text-slate-500">{[row.brickName, row.areaName].filter(Boolean).join(" · ")}</p> : null}
      {readings.map((line) => (
        <p key={line} className="break-words text-xs text-slate-500">
          {line}
        </p>
      ))}
      <a className="inline-block text-xs font-black text-orange-700 underline underline-offset-2" href={row.mapsLink} rel="noreferrer" target="_blank">
        Open where they stood in Google Maps
      </a>
      <div className="space-y-0.5 border-t border-slate-100 pt-1">
        {row.signboard ? (
          <CrmPill tone={row.signboard.verdict === "match" ? "good" : row.signboard.verdict === "unjudged" ? "neutral" : "warn"}>
            {SIGNBOARD_TEXT[row.signboard.verdict]}
          </CrmPill>
        ) : (
          <p className="text-xs text-slate-500">The signboard has not been read yet.</p>
        )}
        {row.signboard?.signText ? (
          <p className="break-words text-xs text-slate-700" dir="auto">
            {row.signboard.signText}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** What refusing this row costs, in plain words — read before the button, not after. */
function Cost({ row }: { row: ValidatedPlaceRow }) {
  const lines = [
    row.otherPlaces === 0
      ? "They go back to To validate — this is the customer's only place."
      : `The customer keeps ${row.otherPlaces === 1 ? "their other place" : `their other ${row.otherPlaces} places`}, so they stay validated.`,
    row.visits === 0 ? "No visit is measured against it yet." : `${row.visits} ${row.visits === 1 ? "visit is" : "visits are"} measured against it, and ${row.visits === 1 ? "it loses its distance" : "they lose their distances"}.`,
  ];
  return (
    <ul className="space-y-0.5">
      {lines.map((line) => (
        <li key={line} className="break-words text-xs text-slate-600">
          {line}
        </li>
      ))}
    </ul>
  );
}

function Refuse({ row }: { row: ValidatedPlaceRow }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<ValidationRefusalReason | "">("");
  const [armed, setArmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function refuse() {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/validation-reviews/refuse", { placeId: row.placeId, note, refusalReason: reason }, "refused");
      router.refresh();
    } catch (error) {
      setProblem(messageOf(error));
      setSaving(false);
      setArmed(false);
    }
  }

  return (
    <div className="space-y-2">
      <Cost row={row} />
      <RefusalReasonField
        disabled={saving}
        id={`refuse-reason-${row.placeId}`}
        onChange={(next) => {
          setReason(next);
          setArmed(false);
        }}
        value={reason}
      />
      <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor={`refuse-note-${row.placeId}`}>
        {VALIDATION_NOTE_LABEL}
      </label>
      <textarea
        className={crmTextareaClassName}
        disabled={saving}
        id={`refuse-note-${row.placeId}`}
        maxLength={500}
        onChange={(event) => {
          setNote(event.target.value);
          setArmed(false);
        }}
        rows={2}
        value={note}
      />
      <RefusalNoteHint />
      {armed ? (
        <div className="space-y-2">
          <CrmNote tone="warn">This retires the place and cannot be undone — they validate the customer again from their own list.</CrmNote>
          <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
            <CrmButton disabled={saving} onClick={() => void refuse()} variant="danger">
              {saving ? "Refusing…" : "Yes, refuse it"}
            </CrmButton>
            <CrmButton disabled={saving} onClick={() => setArmed(false)}>
              Keep it
            </CrmButton>
          </div>
        </div>
      ) : (
        <CrmButton disabled={reason === "" || note.trim().length === 0} onClick={() => setArmed(true)} variant="danger">
          Refuse this validation
        </CrmButton>
      )}
      {(reason === "" || note.trim().length === 0) && !armed ? (
        <p className="text-xs text-slate-500">Choose what is wrong with the photo and write the note first.</p>
      ) : null}
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}

/**
 * `showSearch` is false when the board above owns the filtering (the Place checks page) — the list is
 * then handed rows that are already narrowed, and its own search box would be a second, confusing one.
 * It stays true by default so the component keeps its own search anywhere it is used on its own.
 */
export function ValidatedPlaceList({ rows, showSearch = true }: { rows: ValidatedPlaceRow[]; showSearch?: boolean }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  const found = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    if (!wanted) return rows;
    return rows.filter((row) =>
      [row.customerName, row.repName, row.territory, row.placeLabel, row.brickName, row.areaName, row.address]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .some((value) => value.toLowerCase().includes(wanted)),
    );
  }, [query, rows]);
  const shown = found.slice(0, page * PAGE);

  return (
    <div className="min-w-0 space-y-3">
      {showSearch ? (
        <div className="px-4 pt-4 md:max-w-md">
          <CrmSearchField
            id="validated-place-search"
            label="Find a customer, a rep or a territory"
            onChange={(next) => {
              setQuery(next);
              setPage(1);
            }}
            placeholder="Name, rep, brick or area"
            value={query}
          />
        </div>
      ) : null}

      {found.length === 0 ? (
        <div className="px-4 pb-4">
          <CrmEmpty message={showSearch ? "Nothing here matches what you typed." : "Nothing here matches these filters."} title="No validation found" />
        </div>
      ) : (
        <>
          <CrmCardsOnPhone>
            {shown.map((row) => (
              <div key={row.placeId} className="space-y-3 px-4 py-4">
                <div className="flex min-w-0 gap-3">
                  <CrmPhotoThumb alt={`Signboard photo for ${row.customerName}`} path={row.photoPath} />
                  <Who row={row} />
                </div>
                <Place row={row} />
                <Refuse row={row} />
              </div>
            ))}
          </CrmCardsOnPhone>
          <CrmTable columns={["12%", "24%", "34%", "30%"]}>
            <thead>
              <tr>
                <th className={crmThClassName}>Photo</th>
                <th className={crmThClassName}>Customer and rep</th>
                <th className={crmThClassName}>The place they saved</th>
                <th className={crmThClassName}>Refuse it</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.placeId} className="even:bg-slate-50/60">
                  <td className={crmTdClassName}>
                    <CrmPhotoThumb alt={`Signboard photo for ${row.customerName}`} path={row.photoPath} />
                  </td>
                  <td className={crmTdClassName}>
                    <Who row={row} />
                  </td>
                  <td className={crmTdClassName}>
                    <Place row={row} />
                  </td>
                  <td className={crmTdClassName}>
                    <Refuse row={row} />
                  </td>
                </tr>
              ))}
            </tbody>
          </CrmTable>
          <div className="px-4 pb-4">
            <CrmShowMore left={found.length - shown.length} onMore={() => setPage((current) => current + 1)} page={PAGE} />
          </div>
        </>
      )}
    </div>
  );
}
