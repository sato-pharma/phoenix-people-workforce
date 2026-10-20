"use client";

// Recruitment workspace — "Place this candidate" (owner, 20 Oct 2026, on Needs placing: pick Applying
// for from a drop-down, then the Region, then the Area — only that region's areas — and answer most of
// the WhatsApp questions by hand, so the person is placed exactly from his entries).
//
// THE ORDER IS HIS: Applying for → Region → Area, then that role's own questions. The role list is the
// bot's menu with the bot's labels; the regions and areas carry their vacant seats; the area list is
// the chosen region's only, and empties when the region changes. Each question is a drop-down of its
// options (with "Other — type it" for an answer the list does not hold) or a box for a typed answer,
// started from whatever is on record; a follow-up appears only when the answer it follows says so.
//
// ONE PRESS SAVES AND PLACES (`PUT /api/recruitment/candidates/[id]/answers`). Only the answers HR
// changed are sent — an answer the applicant gave and HR left alone stays the applicant's — and each
// one saved says "added by HR" with the name. The rules are `placing-rules.ts`, shared with the server.

import { AlertTriangle, Loader2, MapPin, Tags, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { getJson } from "@/components/recruitment/recruitment-fetch";
import type { WorkspaceActions } from "@/components/recruitment/workspace/use-workspace-actions";
import { errorText } from "@/components/recruitment/workspace/workspace-format";
import { FormField } from "@/components/ui/form-kit";
import { phxButtonAccentClassName, phxFieldClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import type { CandidateRoleFamily } from "@/lib/recruitment/candidate-role-family";
import { placingRefusal, placingShape, visiblePlacingQuestions, type PlacingQuestion } from "@/lib/recruitment/workspace/placing-rules";
import type { WorkspaceRoleTab } from "@/lib/recruitment/workspace/role-tabs";
import type { WorkspacePlaces, WorkspaceRow } from "@/lib/recruitment/workspace/types";
import { cn } from "@/lib/utils";

/** The select's own value for "the answer is typed, not one of the list". */
const TYPED = "__typed__";

type FormData = {
  roles: { family: CandidateRoleFamily; label: string }[];
  roleFamily: CandidateRoleFamily | null;
  questions: PlacingQuestion[];
  places: WorkspacePlaces;
  current: Record<string, string>;
  regionCode: string | null;
  areaCode: string | null;
};

function readForm(data: Record<string, unknown>): FormData {
  return {
    areaCode: typeof data.areaCode === "string" ? data.areaCode : null,
    current: (data.current as Record<string, string> | undefined) ?? {},
    places: (data.places as WorkspacePlaces | undefined) ?? { regions: [] },
    questions: Array.isArray(data.questions) ? (data.questions as PlacingQuestion[]) : [],
    regionCode: typeof data.regionCode === "string" ? data.regionCode : null,
    roleFamily: typeof data.roleFamily === "string" ? (data.roleFamily as CandidateRoleFamily) : null,
    roles: Array.isArray(data.roles) ? (data.roles as FormData["roles"]) : [],
  };
}

function seatsLabel(name: string, vacant: number): string {
  return vacant > 0 ? `${name} · ${vacant} vacant` : name;
}

function MissingMark() {
  return (
    <span className="ml-1.5 inline-flex items-center gap-0.5 border border-dashed border-amber-400 bg-amber-50 px-1 font-bold normal-case tracking-normal text-amber-800">
      <AlertTriangle aria-hidden className="h-3 w-3" />
      Missing
    </span>
  );
}

function QuestionField({
  disabled,
  missing,
  onChange,
  question,
  typedMode,
  onTypedMode,
  value,
}: {
  disabled: boolean;
  missing: boolean;
  onChange: (value: string) => void;
  question: PlacingQuestion;
  typedMode: boolean;
  onTypedMode: (on: boolean) => void;
  value: string;
}) {
  const id = `ws-place-${question.key}`;
  const label = (
    <>
      <span dir="auto">{question.label}</span>
      {missing ? <MissingMark /> : null}
    </>
  );
  if (question.options.length === 0) {
    return (
      <FormField htmlFor={id} label={label}>
        <input
          className={cn(phxFieldClassName, "h-9 text-sm")}
          dir="auto"
          disabled={disabled}
          id={id}
          maxLength={300}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Type the answer"
          value={value}
        />
      </FormField>
    );
  }
  const listed = question.options.some((option) => option.title === value);
  const selectValue = typedMode || (value && !listed) ? TYPED : value;
  return (
    <FormField htmlFor={id} label={label}>
      <select
        className={cn(phxSelectClassName, "h-9 text-sm")}
        disabled={disabled}
        id={id}
        onChange={(event) => {
          const next = event.target.value;
          if (next === TYPED) {
            onTypedMode(true);
            if (listed) onChange("");
            return;
          }
          onTypedMode(false);
          onChange(next);
        }}
        value={selectValue}
      >
        <option value="">Not answered</option>
        {question.options.map((option) => (
          <option key={option.value || option.title} value={option.title}>
            {option.title}
          </option>
        ))}
        <option value={TYPED}>Other — type it</option>
      </select>
      {selectValue === TYPED ? (
        <input
          aria-label={`${question.label} — typed answer`}
          autoFocus={typedMode && !value}
          className={cn(phxFieldClassName, "mt-1.5 h-9 text-sm")}
          dir="auto"
          disabled={disabled}
          maxLength={300}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Type the answer"
          value={value}
        />
      ) : null}
    </FormField>
  );
}

export function PlacingForm({
  actions,
  editorName,
  framed = true,
  leaves,
  onClose,
  onPlaced,
  roleTabs,
  row,
}: {
  actions: WorkspaceActions;
  editorName: string | null;
  /** Draws its own titled box. False inside a panel that already has one. */
  framed?: boolean;
  /** True on Needs placing: the placed row leaves the list. */
  leaves: boolean;
  onClose?: () => void;
  onPlaced?: () => void;
  roleTabs: readonly WorkspaceRoleTab[];
  row: WorkspaceRow;
}) {
  const [form, setForm] = useState<{ phase: "loading" } | { phase: "ready"; data: FormData } | { phase: "failed"; message: string }>({ phase: "loading" });
  const [family, setFamily] = useState("");
  const [regionCode, setRegionCode] = useState("");
  const [areaCode, setAreaCode] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [typed, setTyped] = useState<Record<string, boolean>>({});
  const [switching, setSwitching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getJson(`/api/recruitment/candidates/${row.id}/answers`)
      .then((raw) => {
        if (!active) return;
        const data = readForm(raw);
        setForm({ data, phase: "ready" });
        setFamily(data.roleFamily ?? "");
        setRegionCode(data.regionCode ?? "");
        setAreaCode(data.areaCode ?? "");
        setAnswers({ ...data.current });
      })
      .catch((error: unknown) => {
        if (active) setForm({ message: errorText(error, "The placing form could not be loaded."), phase: "failed" });
      });
    return () => {
      active = false;
    };
  }, [row.id]);

  const data = form.phase === "ready" ? form.data : null;
  const shape = placingShape(family || null);
  const region = data?.places.regions.find((entry) => entry.code === regionCode) ?? null;
  const visible = useMemo(() => (data ? visiblePlacingQuestions(data.questions, answers) : []), [answers, data]);

  const chooseRole = async (next: string) => {
    setFamily(next);
    setProblem(null);
    if (!next) return;
    setSwitching(true);
    try {
      const fresh = readForm(await getJson(`/api/recruitment/candidates/${row.id}/answers?family=${encodeURIComponent(next)}`));
      setForm({ data: fresh, phase: "ready" });
      const nextShape = placingShape(next);
      if (!nextShape.region || !fresh.places.regions.some((entry) => entry.code === regionCode)) {
        setRegionCode(nextShape.region ? (fresh.regionCode ?? "") : "");
        setAreaCode(nextShape.area ? (fresh.areaCode ?? "") : "");
      } else if (!nextShape.area) {
        setAreaCode("");
      }
    } catch (error) {
      setProblem(errorText(error, "That role's questions could not be loaded."));
    } finally {
      setSwitching(false);
    }
  };

  const save = async () => {
    if (!data) return;
    const changed: Record<string, string | null> = {};
    for (const question of visible) {
      const now = (answers[question.key] ?? "").trim();
      const was = (data.current[question.key] ?? "").trim();
      if (now !== was) changed[question.key] = now || null;
    }
    const input = { answers: changed, areaCode: areaCode || null, regionCode: regionCode || null, roleFamily: family || null };
    const refusal = placingRefusal(input, roleTabs);
    if (refusal) {
      setProblem(refusal);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await actions.placeWithAnswers(row, input, { editorName, leaves });
      onPlaced?.();
    } catch (error) {
      setProblem(errorText(error, "The CV was not placed."));
      setBusy(false);
    }
  };

  const missingCount = visible.filter((question) => !(answers[question.key] ?? "").trim()).length;
  const disabled = busy || switching;

  const body =
    form.phase === "loading" ? (
      <p className="flex items-center gap-2 text-sm font-semibold text-slate-600" role="status">
        <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Reading the questions and the places…
      </p>
    ) : form.phase === "failed" ? (
      <p className="break-words border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs font-bold text-rose-800" dir="auto" role="alert">
        {form.message}
      </p>
    ) : (
      <div className="space-y-3 @container">
        <div className="grid grid-cols-1 gap-3 @min-[560px]:grid-cols-3">
          <FormField htmlFor={`ws-place-role-${row.id}`} label={<>Applying for{!family ? <MissingMark /> : null}</>}>
            <select
              className={cn(phxSelectClassName, "h-9 text-sm")}
              disabled={disabled}
              id={`ws-place-role-${row.id}`}
              onChange={(event) => void chooseRole(event.target.value)}
              value={family}
            >
              <option value="">Choose the role…</option>
              {form.data.roles.map((role) => (
                <option key={role.family} value={role.family}>
                  {role.label}
                </option>
              ))}
            </select>
          </FormField>
          {shape.region ? (
            <FormField htmlFor={`ws-place-region-${row.id}`} label={<>Region{!regionCode ? <MissingMark /> : null}</>}>
              <select
                className={cn(phxSelectClassName, "h-9 text-sm")}
                disabled={disabled}
                id={`ws-place-region-${row.id}`}
                onChange={(event) => {
                  setRegionCode(event.target.value);
                  setAreaCode("");
                }}
                value={regionCode}
              >
                <option value="">Choose the region…</option>
                {form.data.places.regions.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {seatsLabel(entry.name, entry.vacantSeats)}
                  </option>
                ))}
              </select>
            </FormField>
          ) : null}
          {shape.area ? (
            <FormField htmlFor={`ws-place-area-${row.id}`} label={<>Area{!areaCode ? <MissingMark /> : null}</>}>
              <select
                className={cn(phxSelectClassName, "h-9 text-sm")}
                disabled={disabled || !region}
                id={`ws-place-area-${row.id}`}
                onChange={(event) => setAreaCode(event.target.value)}
                value={areaCode}
              >
                <option value="">{region ? `Choose an area in ${region.name}…` : "Choose the region first"}</option>
                {(region?.areas ?? []).map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {seatsLabel(entry.name, entry.vacantSeats)}
                  </option>
                ))}
              </select>
            </FormField>
          ) : null}
        </div>

        {family ? (
          visible.length > 0 ? (
            <div className="border-t border-slate-200 pt-3">
              <p className="mb-2 text-xs font-bold text-slate-600">
                {missingCount > 0
                  ? `The WhatsApp questions for this role — ${missingCount} not answered yet.`
                  : "The WhatsApp questions for this role — every one answered."}
              </p>
              <div className="grid grid-cols-1 gap-3 @min-[560px]:grid-cols-2 @min-[860px]:grid-cols-3">
                {visible.map((question) => (
                  <QuestionField
                    disabled={disabled}
                    key={question.key}
                    missing={!(answers[question.key] ?? "").trim()}
                    onChange={(value) => setAnswers((current) => ({ ...current, [question.key]: value }))}
                    onTypedMode={(on) => setTyped((current) => ({ ...current, [question.key]: on }))}
                    question={question}
                    typedMode={Boolean(typed[question.key])}
                    value={answers[question.key] ?? ""}
                  />
                ))}
              </div>
            </div>
          ) : (
            <p className="text-xs font-semibold text-slate-500">This role is asked no other WhatsApp questions.</p>
          )
        ) : (
          <p className="text-xs font-semibold text-slate-500">Choose the role, and its WhatsApp questions appear here.</p>
        )}

        {problem ? (
          <p className="break-words border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs font-bold text-rose-800" dir="auto" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <button className={cn(phxButtonAccentClassName, "h-9 px-4 text-xs")} disabled={disabled || !family} onClick={() => void save()} type="button">
            {busy ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <Tags aria-hidden className="h-3.5 w-3.5" />}
            Save and place
          </button>
          <span className="text-xs font-medium text-slate-500">
            Each answer you type is marked “added by HR” with your name. Answers you leave as they are stay the applicant&apos;s.
          </span>
        </div>
      </div>
    );

  if (!framed) return body;
  return (
    <section aria-label={`Place ${row.name}`} className={`border border-orange-200 bg-white ${adminSoftDepthClassName}`}>
      <div className="flex items-center justify-between gap-3 border-b border-orange-200 bg-orange-50/70 px-3 py-2">
        <p className="inline-flex items-center gap-1.5 text-xs font-black uppercase tracking-[0.1em] text-slate-800">
          <MapPin aria-hidden className="h-3.5 w-3.5 text-orange-600" />
          <span dir="auto">{`Place ${row.name}`}</span>
        </p>
        {onClose ? (
          <button aria-label="Close" className="p-0.5 text-slate-500 transition hover:text-slate-900" onClick={onClose} type="button">
            <X aria-hidden className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      <div className="p-3">{body}</div>
    </section>
  );
}
