"use client";

// Who is being interviewed — the owner, 2026-09-18: "I can either schedule from interviews on system
// or I can upload … a CV … from system or outside the system, both applicable."
//
//   From Phoenix   a candidate already in Recruitment, found by name, phone or e-mail.
//   From outside   a name, and a phone, an e-mail and a CV when there are any. "Also add to
//                  Recruitment" (on by default) makes them a candidate with the CV filed on their
//                  record; off keeps them on this booking only.

import { FileUp, Loader2, Search, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Action } from "@/components/recruitment/workstation/workstation-look";
import { cn } from "@/lib/utils";

import { type CalendarApi } from "./calendar-api";
import { NoteLine, Segmented, Switch } from "./calendar-dialog";
import { phxFieldClassName, phxLabelTextClassName } from "@/components/ui/form-tokens";
import { adminRecessedDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

export type CandidateMatch = { id: string; name: string; jobTitle: string | null };

export type PersonChoice =
  | { kind: "phoenix"; candidate: CandidateMatch | null }
  | { kind: "outside"; name: string; phone: string; email: string; cv: File | null; addToRecruitment: boolean };

export const CV_LIMIT_BYTES = 10 * 1024 * 1024;
const CV_ACCEPT = ".pdf,.doc,.docx,.png,.jpg,.jpeg,.webp";

export function initialPersonChoice(canSearch: boolean, canAdd: boolean): PersonChoice {
  return canSearch ? { candidate: null, kind: "phoenix" } : blankOutside(canAdd);
}

function blankOutside(canAdd: boolean): PersonChoice {
  return { addToRecruitment: canAdd, cv: null, email: "", kind: "outside", name: "", phone: "" };
}

/** The sentence that says what is still missing, or null when the person is chosen. */
export function personProblem(choice: PersonChoice): string | null {
  if (choice.kind === "phoenix") return choice.candidate ? null : "Choose the candidate.";
  if (choice.name.trim().length < 2) return "Write the person's name.";
  if (choice.cv && choice.cv.size > CV_LIMIT_BYTES) return "The CV is larger than 10 MB.";
  return null;
}

export function personLabel(choice: PersonChoice): string {
  return choice.kind === "phoenix" ? (choice.candidate?.name ?? "") : choice.name.trim();
}

/** Book: JSON for a Phoenix candidate, multipart when an outside person's CV rides along. */
export async function submitBooking(api: CalendarApi, choice: PersonChoice, fields: Record<string, unknown>) {
  const body =
    choice.kind === "phoenix"
      ? { ...fields, candidateId: choice.candidate?.id ?? null }
      : {
          ...fields,
          addToRecruitment: choice.addToRecruitment,
          external: { email: choice.email.trim(), name: choice.name.trim(), phone: choice.phone.trim() },
        };
  if (choice.kind === "outside" && choice.cv) {
    const form = new FormData();
    form.set("payload", JSON.stringify(body));
    form.set("cv", choice.cv);
    return api.postForm("/bookings", form);
  }
  return api.post("/bookings", body);
}

const inputClass = `${phxFieldClassName} block`;

export function PersonPicker({
  api,
  canAdd,
  canSearch,
  onChange,
  value,
}: {
  api: CalendarApi;
  /** May make an outside person a Recruitment candidate. */
  canAdd: boolean;
  /** May search Recruitment's candidates. */
  canSearch: boolean;
  onChange: (choice: PersonChoice) => void;
  value: PersonChoice;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ text: string; people: CandidateMatch[]; error: string | null } | null>(null);
  const text = query.trim();
  const searchable = text.length >= 2;
  const answered = searchable && found !== null && found.text === text;

  useEffect(() => {
    if (!canSearch || text.length < 2) return;
    let live = true;
    const timer = window.setTimeout(() => {
      api
        .get(`/candidates/search?q=${encodeURIComponent(text)}`)
        .then((data) => {
          if (live) setFound({ error: null, people: Array.isArray(data.candidates) ? (data.candidates as CandidateMatch[]) : [], text });
        })
        .catch((reason) => {
          if (live) setFound({ error: reason instanceof Error ? reason.message : "The search failed.", people: [], text });
        });
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [api, canSearch, text]);

  return (
    <div className="flex flex-col gap-3">
      <Segmented
        label="Who"
        onChange={(kind) => {
          if (kind === value.kind) return;
          onChange(kind === "phoenix" ? { candidate: null, kind: "phoenix" } : blankOutside(canAdd));
        }}
        options={[
          { disabled: !canSearch, label: "From Phoenix", value: "phoenix" },
          { label: "From outside", value: "outside" },
        ]}
        value={value.kind}
      />
      {!canSearch ? (
        <p className="text-[11px] text-slate-500">Finding someone already in Recruitment needs access to its candidates; book them from their CV instead.</p>
      ) : null}

      {value.kind === "phoenix" ? (
        value.candidate ? (
          <div className={`flex items-start justify-between gap-2 border border-orange-200 border-l-[3px] border-l-orange-500 bg-orange-50 px-3 py-2 ${adminSoftDepthClassName}`}>
            <span className="min-w-0">
              <span className="block break-words text-[14px] font-bold text-slate-900">{value.candidate.name}</span>
              {value.candidate.jobTitle ? <span className="block break-words text-[12px] text-slate-600">Applied for {value.candidate.jobTitle}</span> : null}
            </span>
            <Action onClick={() => onChange({ candidate: null, kind: "phoenix" })} tone="ghost">
              Change
            </Action>
          </div>
        ) : (
          <div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                aria-label="Find a candidate"
                autoComplete="off"
                className={cn(inputClass, "h-9 pl-8")}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Name, phone or e-mail"
                type="search"
                value={query}
              />
            </div>
            {searchable ? (
              <ul className={`mt-1 max-h-56 divide-y divide-slate-100 overflow-y-auto border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
                {!answered ? (
                  <li className="flex items-center gap-1.5 px-3 py-2 text-[12px] text-slate-500">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
                  </li>
                ) : found?.error ? (
                  <li className="px-3 py-2 text-[12px] font-semibold text-red-700">{found.error}</li>
                ) : (found?.people.length ?? 0) === 0 ? (
                  <li className="px-3 py-2 text-[12px] text-slate-500">Nobody in Recruitment by that. Book them From outside.</li>
                ) : (
                  found?.people.map((person) => (
                    <li key={person.id}>
                      <button
                        className="block w-full px-3 py-2 text-left transition-colors hover:bg-orange-50 focus-visible:bg-orange-50 focus-visible:outline-none"
                        onClick={() => onChange({ candidate: person, kind: "phoenix" })}
                        type="button"
                      >
                        <span className="block break-words text-[13px] font-semibold text-slate-900">{person.name}</span>
                        {person.jobTitle ? <span className="block break-words text-[11px] text-slate-500">{person.jobTitle}</span> : null}
                      </button>
                    </li>
                  ))
                )}
              </ul>
            ) : (
              <p className="mt-1 text-[11px] text-slate-500">Type at least two letters or digits.</p>
            )}
          </div>
        )
      ) : (
        <div className="flex flex-col gap-2.5">
          <label className="block">
            <span className={phxLabelTextClassName}>Name</span>
            <input
              autoComplete="off"
              className={cn(inputClass, "mt-1")}
              maxLength={200}
              onChange={(event) => onChange({ ...value, name: event.target.value })}
              value={value.name}
            />
          </label>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <label className="block">
              <span className={phxLabelTextClassName}>Phone (optional)</span>
              <input
                autoComplete="off"
                className={cn(inputClass, "mt-1")}
                inputMode="tel"
                maxLength={40}
                onChange={(event) => onChange({ ...value, phone: event.target.value })}
                placeholder="01xxxxxxxxx"
                value={value.phone}
              />
            </label>
            <label className="block">
              <span className={phxLabelTextClassName}>E-mail (optional)</span>
              <input
                autoComplete="off"
                className={cn(inputClass, "mt-1")}
                inputMode="email"
                maxLength={200}
                onChange={(event) => onChange({ ...value, email: event.target.value })}
                value={value.email}
              />
            </label>
          </div>
          <div>
            <span className={phxLabelTextClassName}>CV (optional)</span>
            {value.cv ? (
              <div className={`mt-1 flex items-center justify-between gap-2 border border-slate-200 bg-slate-50 px-3 py-2 ${adminRecessedDepthClassName}`}>
                <span className="min-w-0 break-all text-[12px] font-semibold text-slate-800">{value.cv.name}</span>
                <button
                  aria-label="Remove the CV"
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center border border-transparent text-slate-500 hover:border-slate-200 hover:text-slate-900"
                  onClick={() => onChange({ ...value, cv: null })}
                  type="button"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <label className="mt-1 flex cursor-pointer items-center gap-2 border border-dashed border-slate-300 bg-white px-3 py-2.5 text-[12px] font-semibold text-slate-600 hover:border-orange-400 hover:text-orange-700">
                <FileUp className="h-4 w-4" />
                Upload a PDF, Word file or picture, up to 10 MB
                <input
                  accept={CV_ACCEPT}
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    event.target.value = "";
                    onChange({ ...value, cv: file });
                  }}
                  type="file"
                />
              </label>
            )}
            {value.cv && value.cv.size > CV_LIMIT_BYTES ? <p className="mt-1 text-[11px] font-semibold text-red-700">The CV is larger than 10 MB.</p> : null}
          </div>
          <Switch
            checked={value.addToRecruitment}
            disabled={!canAdd}
            hint={
              !canAdd
                ? "Adding people to Recruitment needs access to create candidates, so this person stays on the calendar only."
                : value.addToRecruitment
                  ? "They become a Recruitment candidate, with the CV on their record. Someone already there by phone or e-mail is matched instead."
                  : "They stay on this interview only — not in Recruitment. The CV opens from the calendar."
            }
            label="Also add to Recruitment"
            onChange={(checked) => onChange({ ...value, addToRecruitment: checked })}
          />
          {!value.addToRecruitment ? <NoteLine tone="amber">Nothing is sent to them either way.</NoteLine> : null}
        </div>
      )}
    </div>
  );
}
