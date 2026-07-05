"use client";

import { useState } from "react";
import {
  AlertCircle,
  Award,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  Save,
  Send,
  Sparkles,
  Target,
  UserRound,
} from "lucide-react";

import {
  AdminSectionHeader,
  adminInsetPanelClassName,
  adminPanelClassName,
  adminSoftPanelClassName,
} from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  coachingMaxScore,
  coachingParameterLabels,
  coachingPerformanceZoneDisplayLabels,
  coachingScoreItems,
  type CoachingParameterKey,
  type CoachingScoreItemKey,
} from "@/lib/coaching/constants";
import { calculateCoachingScore } from "@/lib/coaching/scoring";
import type {
  CoachingPerformanceZone,
  CoachingReportDetail,
  CoachingScoreInput,
} from "@/lib/coaching/types";
import { cn, formatEmployeeDisplayName } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";


type CoachingEmployeeOption = {
  areaName: string | null;
  fullName: string;
  hrId: string;
  jobTitle: string | null;
  lineName: string | null;
  teamId: number | null;
};

type CoachingReportFormProps = {
  coach: {
    hrId: string | null;
    name: string;
    role: string;
  };
  employees: CoachingEmployeeOption[];
  /**
   * When provided, the form opens in "resume draft" mode: state is hydrated from
   * the existing draft and Save Draft / Submit Report act on that report id.
   */
  initialDraft?: CoachingReportDetail | null;
};

type FormMessage = {
  text: string;
  tone: "danger" | "success";
};

type ScoreItemNotes = Partial<Record<CoachingScoreItemKey, {
  areaToBeImproved: string;
  strengthPoint: string;
}>>;

type ApiResponse<T> = {
  data?: T;
  message?: string;
  error?: string;
};

const categoryOrder: CoachingParameterKey[] = [
  "knowledge",
  "call_structure_skills",
  "business_intelligence",
  "business_planning",
  "personal_skills",
];

const categoryLetters: Record<CoachingParameterKey, string> = {
  business_intelligence: "C",
  business_planning: "D",
  call_structure_skills: "B",
  knowledge: "A",
  personal_skills: "E",
};

const ratingMeanings = [
  { label: "No Score", value: "0" },
  { label: "Below Expectations", value: "1" },
  { label: "Needs Improvement", value: "2" },
  { label: "Within Average", value: "3" },
  { label: "Meets Expectations", value: "4" },
  { label: "Exceeds Expectations", value: "5" },
];

const zoneClassNames: Record<CoachingPerformanceZone, string> = {
  critical_red: "border-rose-200 bg-rose-50 text-rose-700",
  excellence_zone: "border-amber-200 bg-amber-50 text-amber-800",
  green_zone: "border-emerald-200 bg-emerald-50 text-emerald-700",
  red_zone: "border-rose-200 bg-rose-50 text-rose-700",
  yellow_zone: "border-orange-200 bg-orange-50 text-orange-700",
};

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function groupScoreItems() {
  return categoryOrder.map((category) => ({
    category,
    items: coachingScoreItems.filter((item) => item.category === category),
    label: coachingParameterLabels[category],
  }));
}

function scoreCompletion(scores: Partial<Record<CoachingScoreItemKey, number>>) {
  return coachingScoreItems.filter((item) => Number.isInteger(scores[item.key])).length;
}

function totalPartialScore(scores: Partial<Record<CoachingScoreItemKey, number>>) {
  return coachingScoreItems.reduce((total, item) => total + (scores[item.key] ?? 0), 0);
}

function completeScoreInput(scores: Partial<Record<CoachingScoreItemKey, number>>): CoachingScoreInput | null {
  if (scoreCompletion(scores) !== coachingScoreItems.length) return null;
  return Object.fromEntries(coachingScoreItems.map((item) => [item.key, scores[item.key]])) as CoachingScoreInput;
}

function completeScorePayload(
  scores: Partial<Record<CoachingScoreItemKey, number>>,
  notes: ScoreItemNotes,
): CoachingScoreInput | null {
  if (scoreCompletion(scores) !== coachingScoreItems.length) return null;
  return Object.fromEntries(coachingScoreItems.map((item) => [
    item.key,
    {
      areaToBeImproved: notes[item.key]?.areaToBeImproved.trim() || null,
      score: scores[item.key] as number,
      strengthPoint: notes[item.key]?.strengthPoint.trim() || null,
    },
  ])) as CoachingScoreInput;
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as ApiResponse<T>;
  if (!response.ok) {
    throw new Error(payload.message || payload.error || "Coaching request failed.");
  }
  if (!payload.data) {
    throw new Error("Coaching API returned no data.");
  }
  return payload.data;
}

function FieldLabel({
  children,
  required,
}: {
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <span className="mb-2 block text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">
      {children}
      {required ? <span className="ml-1 text-[#F97316]">*</span> : null}
    </span>
  );
}

function DetailPill({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={cn(adminInsetPanelClassName, "px-3 py-2.5")}>
      <p className="text-[10px] font-black uppercase tracking-[0.15em] text-[#94A3B8]">{label}</p>
      <p className="mt-1 truncate text-sm font-bold text-[#0F172A]">{value || "-"}</p>
    </div>
  );
}

function initialScoresFromDraft(draft: CoachingReportDetail | null | undefined) {
  const scores: Partial<Record<CoachingScoreItemKey, number>> = {};
  if (!draft) return scores;
  for (const item of draft.scores) {
    if (Number.isInteger(item.score)) scores[item.score_item_key] = item.score;
  }
  return scores;
}

function initialNotesFromDraft(draft: CoachingReportDetail | null | undefined) {
  const notes: ScoreItemNotes = {};
  if (!draft) return notes;
  for (const item of draft.scores) {
    notes[item.score_item_key] = {
      areaToBeImproved: item.area_to_be_improved ?? "",
      strengthPoint: item.strength_point ?? "",
    };
  }
  return notes;
}

export function CoachingReportForm({ coach, employees, initialDraft }: CoachingReportFormProps) {
  const [selectedHrId, setSelectedHrId] = useState(initialDraft?.report.medical_rep_hr_id ?? "");
  const [coachingDate, setCoachingDate] = useState(
    initialDraft?.report.coaching_date?.slice(0, 10) ?? todayIsoDate(),
  );
  const [areaOfDevelopment, setAreaOfDevelopment] = useState(initialDraft?.report.area_of_development ?? "");
  const [strengthPoints, setStrengthPoints] = useState(initialDraft?.report.strength_points ?? "");
  const [generalRemarks, setGeneralRemarks] = useState(initialDraft?.report.general_remarks ?? "");
  const [scores, setScores] = useState<Partial<Record<CoachingScoreItemKey, number>>>(
    () => initialScoresFromDraft(initialDraft),
  );
  const [scoreNotes, setScoreNotes] = useState<ScoreItemNotes>(() => initialNotesFromDraft(initialDraft));
  const [draftId, setDraftId] = useState<string | null>(initialDraft?.report.id ?? null);
  const [result, setResult] = useState<CoachingReportDetail | null>(null);
  const [message, setMessage] = useState<FormMessage | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const selectedEmployee = employees.find((employee) => employee.hrId === selectedHrId) ?? null;
  const completedScores = scoreCompletion(scores);
  const partialScore = totalPartialScore(scores);
  const completeScores = completeScoreInput(scores);
  const completeScorePayloadWithNotes = completeScorePayload(scores, scoreNotes);
  const liveScore = completeScores ? calculateCoachingScore(completeScores) : null;
  const groups = groupScoreItems();

  function validateDraftFields() {
    if (!selectedHrId) throw new Error("Select a Medical Rep.");
    if (!coachingDate) throw new Error("Coaching date is required.");
  }

  function validateSubmitFields() {
    validateDraftFields();
    if (!areaOfDevelopment.trim()) throw new Error("Overall Area of Development is required.");
    if (!strengthPoints.trim()) throw new Error("Overall Strength Points is required.");
    if (!generalRemarks.trim()) throw new Error("General Remarks is required.");
  }

  function buildPayload(includeScores: boolean) {
    return {
      areaOfDevelopment: areaOfDevelopment.trim(),
      coachingDate,
      generalRemarks: generalRemarks.trim(),
      medicalRepHrId: selectedHrId,
      ...(includeScores && completeScorePayloadWithNotes ? { scores: completeScorePayloadWithNotes } : {}),
      strengthPoints: strengthPoints.trim(),
    };
  }

  function updateScoreNote(
    key: CoachingScoreItemKey,
    noteKey: "areaToBeImproved" | "strengthPoint",
    value: string,
  ) {
    setScoreNotes((current) => ({
      ...current,
      [key]: {
        areaToBeImproved: current[key]?.areaToBeImproved ?? "",
        strengthPoint: current[key]?.strengthPoint ?? "",
        [noteKey]: value,
      },
    }));
  }

  function handleSaveDraft() {
    void (async () => {
      setIsSaving(true);
      try {
        setMessage(null);
        validateDraftFields();
        const payload = buildPayload(Boolean(completeScores));
        const response = await fetch(draftId ? `/api/coaching/reports/${draftId}` : "/api/coaching/reports", {
          body: JSON.stringify(payload),
          headers: { "Content-Type": "application/json" },
          method: draftId ? "PATCH" : "POST",
        });
        const detail = await parseApiResponse<CoachingReportDetail>(response);
        setDraftId(detail.report.id);
        setResult(detail);
        setMessage({
          text: `Draft saved${detail.report.report_number ? `: ${detail.report.report_number}` : ""}.`,
          tone: "success",
        });
      } catch (error) {
        setMessage({
          text: error instanceof Error ? error.message : "Failed to save coaching draft.",
          tone: "danger",
        });
      } finally {
        setIsSaving(false);
      }
    })();
  }

  function handleSubmitReport() {
    void (async () => {
      setIsSubmitting(true);
      try {
        setMessage(null);
        validateSubmitFields();
        if (!completeScores || !completeScorePayloadWithNotes) {
          throw new Error("Submit requires all 20 scoring items.");
        }

        let activeDraftId = draftId;
        if (!activeDraftId) {
          const createResponse = await fetch("/api/coaching/reports", {
            body: JSON.stringify(buildPayload(true)),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          });
          const created = await parseApiResponse<CoachingReportDetail>(createResponse);
          activeDraftId = created.report.id;
          setDraftId(activeDraftId);
        } else {
          const patchResponse = await fetch(`/api/coaching/reports/${activeDraftId}`, {
            body: JSON.stringify(buildPayload(true)),
            headers: { "Content-Type": "application/json" },
            method: "PATCH",
          });
          await parseApiResponse<CoachingReportDetail>(patchResponse);
        }

        const submitResponse = await fetch(`/api/coaching/reports/${activeDraftId}/submit`, {
          body: JSON.stringify({
            areaOfDevelopment: areaOfDevelopment.trim(),
            generalRemarks: generalRemarks.trim(),
            scores: completeScorePayloadWithNotes,
            strengthPoints: strengthPoints.trim(),
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const submitted = await parseApiResponse<CoachingReportDetail>(submitResponse);
        setResult(submitted);
        setMessage({
          text: `Report submitted: ${submitted.report.report_number} (${submitted.report.status}).`,
          tone: "success",
        });
      } catch (error) {
        setMessage({
          text: error instanceof Error ? error.message : "Failed to submit coaching report.",
          tone: "danger",
        });
      } finally {
        setIsSubmitting(false);
      }
    })();
  }

  const isBusy = isSaving || isSubmitting;

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-6">
        <Card className={`${adminPanelClassName} overflow-hidden p-0`}>
          <AdminSectionHeader
            description="Coach identity is locked to the active session. Medical Rep selection uses HR_ID as the submitted value."
            title="Coaching Context"
          />
          <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-2">
            <div className={`${adminSoftPanelClassName} p-4`}>
              <div className="mb-4 flex items-center gap-3">
                <div className="rounded-md bg-[#FFF7ED] p-3 text-[#F97316]">
                  <UserRound className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#64748B]">Coach</p>
                  <h2 className="text-base font-black tracking-[-0.03em] text-[#0F172A] sm:text-lg">{coach.name}</h2>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <DetailPill label="Coach Role" value={coach.role} />
                <DetailPill label="Coach HR ID" value={coach.hrId ?? "Linked account required"} />
              </div>
            </div>

            <div className={`${adminSoftPanelClassName} p-4`}>
              <label className="block">
                <FieldLabel required>Medical Rep</FieldLabel>
                <SearchableSelect
                  className="h-12 w-full rounded-md border border-[#D8E0EA] bg-white px-3 text-sm font-bold text-[#0F172A] outline-none transition focus:border-[#FDBA74] focus:ring-4 focus:ring-[#F97316]/10"
                  onChange={(event) => setSelectedHrId(event.target.value)}
                  value={selectedHrId}
                >
                  <option value="">Select Medical Rep by HR_ID...</option>
                  {employees.map((employee) => (
                    <option key={employee.hrId} value={employee.hrId}>
                      {formatEmployeeDisplayName(employee.fullName)} - {employee.hrId}
                    </option>
                  ))}
                </SearchableSelect>
              </label>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <DetailPill label="HR ID" value={selectedEmployee?.hrId} />
                <DetailPill label="Job Title" value={selectedEmployee?.jobTitle} />
                <DetailPill label="Line" value={selectedEmployee?.lineName} />
                <DetailPill label="Area" value={selectedEmployee?.areaName} />
                {selectedEmployee?.teamId ? (
                  <DetailPill label="Team" value={`Team ${selectedEmployee.teamId}`} />
                ) : null}
              </div>
            </div>

            <label className="block lg:col-span-2">
              <FieldLabel required>Coaching Date</FieldLabel>
              <div className="relative">
                <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#94A3B8]" />
                <input
                  className="h-12 w-full rounded-md border border-[#D8E0EA] bg-white pl-10 pr-3 text-sm font-bold text-[#0F172A] outline-none transition focus:border-[#FDBA74] focus:ring-4 focus:ring-[#F97316]/10"
                  onChange={(event) => setCoachingDate(event.target.value)}
                  type="date"
                  value={coachingDate}
                />
              </div>
            </label>
          </div>
        </Card>

        <Card className={`${adminPanelClassName} overflow-hidden p-0`}>
          <AdminSectionHeader
            description="Rate every field observation from 0 to 5. The score panel updates when all 20 items are complete."
            title="Structured Scoring"
          />
          <div className="border-b border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3 sm:px-5">
            <div className="grid gap-2 md:grid-cols-6">
              {ratingMeanings.map((meaning) => (
                <div className="rounded-md border border-[#E2E8F0] bg-white px-3 py-2" key={meaning.value}>
                  <p className="text-xs font-black text-[#0F172A]">{meaning.value}</p>
                  <p className="mt-0.5 text-[11px] font-semibold leading-4 text-[#64748B]">{meaning.label}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-4 p-4 sm:p-5">
            {groups.map((group) => (
              <div className={`${adminSoftPanelClassName} overflow-hidden`} key={group.category}>
                <div className="flex flex-col gap-2 border-b border-[#E2E8F0] bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#F97316]">
                      {categoryLetters[group.category]}) Parameter
                    </p>
                    <h3 className="mt-1 text-base font-black tracking-[-0.02em] text-[#0F172A]">{group.label}</h3>
                  </div>
                  <span className="rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1 text-xs font-bold text-[#64748B]">
                    {group.items.length} scoring items
                  </span>
                </div>
                <div className="divide-y divide-[#E2E8F0]">
                  {group.items.map((item) => (
                    <div className="grid gap-3 px-4 py-3" key={item.key}>
                      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                        <div>
                          <p className="text-sm font-bold text-[#0F172A]">{item.label}</p>
                          <p className="mt-1 text-xs font-semibold uppercase tracking-[0.12em] text-[#94A3B8]">
                            Point {item.displayOrder} of {coachingScoreItems.length}
                          </p>
                        </div>
                        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                          {[0, 1, 2, 3, 4, 5].map((rating) => {
                            const selected = scores[item.key] === rating;
                            return (
                              <button
                                className={cn(
                                  "h-10 w-full rounded-xl border text-sm font-black transition lg:w-10",
                                  selected
                                    ? "border-[#F97316] bg-[#F97316] text-white shadow-[0_10px_20px_rgba(249,115,22,0.22)]"
                                    : "border-[#D8E0EA] bg-white text-[#475569] hover:border-[#FDBA74] hover:bg-[#FFF7ED]",
                                )}
                                key={rating}
                                onClick={() => setScores((current) => ({ ...current, [item.key]: rating }))}
                                type="button"
                              >
                                {rating}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div className="grid gap-3 lg:grid-cols-2">
                        <label className="block">
                          <span className="mb-1.5 block text-[10px] font-black uppercase tracking-[0.14em] text-[#64748B]">
                            Area to be Improved
                          </span>
                          <textarea
                            className="min-h-20 w-full rounded-md border border-[#D8E0EA] bg-white px-3 py-2.5 text-sm font-semibold leading-5 text-[#0F172A] outline-none transition placeholder:text-[#94A3B8] focus:border-[#FDBA74] focus:ring-4 focus:ring-[#F97316]/10"
                            onChange={(event) => updateScoreNote(item.key, "areaToBeImproved", event.target.value)}
                            placeholder="What should be improved for this point?"
                            value={scoreNotes[item.key]?.areaToBeImproved ?? ""}
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1.5 block text-[10px] font-black uppercase tracking-[0.14em] text-[#64748B]">
                            Strength Point
                          </span>
                          <textarea
                            className="min-h-20 w-full rounded-md border border-[#D8E0EA] bg-white px-3 py-2.5 text-sm font-semibold leading-5 text-[#0F172A] outline-none transition placeholder:text-[#94A3B8] focus:border-[#FDBA74] focus:ring-4 focus:ring-[#F97316]/10"
                            onChange={(event) => updateScoreNote(item.key, "strengthPoint", event.target.value)}
                            placeholder="What was strong in this point?"
                            value={scoreNotes[item.key]?.strengthPoint ?? ""}
                          />
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card className={`${adminPanelClassName} overflow-hidden p-0`}>
          <AdminSectionHeader
            description="Feedback text becomes part of the employee review record and later acknowledgment flow."
            title="Development Feedback"
          />
          <div className="grid gap-4 p-4 sm:p-5">
            {[
              ["Overall Area of Development", areaOfDevelopment, setAreaOfDevelopment],
              ["Overall Strength Points", strengthPoints, setStrengthPoints],
              ["General Remarks", generalRemarks, setGeneralRemarks],
            ].map(([label, value, setValue]) => (
              <label className="block" key={label as string}>
                <FieldLabel required>{label as string}</FieldLabel>
                <textarea
                  className="min-h-28 w-full rounded-md border border-[#D8E0EA] bg-white px-4 py-3 text-sm font-semibold leading-6 text-[#0F172A] outline-none transition placeholder:text-[#94A3B8] focus:border-[#FDBA74] focus:ring-4 focus:ring-[#F97316]/10"
                  onChange={(event) => (setValue as React.Dispatch<React.SetStateAction<string>>)(event.target.value)}
                  placeholder={`Write ${String(label).toLowerCase()}...`}
                  value={value as string}
                />
              </label>
            ))}
          </div>
        </Card>
      </div>

      <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
        <Card className={`${adminPanelClassName} overflow-hidden p-0`}>
          <div className="border-b border-[#E2E8F0] bg-[#0F172A] px-5 py-5 text-white">
            <div className="flex items-center gap-3">
              <div className="rounded-md bg-white/10 p-3 text-[#FDBA74]">
                <Sparkles className="h-5 w-5" />
              </div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-[#FDBA74]">Live Score</p>
                <h2 className="text-xl font-black tracking-[-0.04em]">Field Excellence</h2>
              </div>
            </div>
          </div>

          <div className="space-y-4 p-5">
            <div className="grid grid-cols-2 gap-3">
              <DetailPill label="Actual Score" value={`${partialScore} / ${coachingMaxScore}`} />
              <DetailPill label="Completed" value={`${completedScores} / ${coachingScoreItems.length}`} />
            </div>

            <div className={`${adminSoftPanelClassName} p-4`}>
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">Completion</p>
                <p className="text-xs font-black text-[#0F172A]">{Math.round((completedScores / coachingScoreItems.length) * 100)}%</p>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-[#E2E8F0]">
                <div
                  className="h-full rounded-full bg-[#F97316] transition-all"
                  style={{ width: `${(completedScores / coachingScoreItems.length) * 100}%` }}
                />
              </div>
            </div>

            {liveScore ? (
              <>
                <div className={`${adminSoftPanelClassName} p-4`}>
                  <p className="text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">Final Score</p>
                  <div className="mt-2 flex items-end justify-between gap-3">
                    <p className="text-3xl font-black tracking-[-0.05em] text-[#0F172A] sm:text-4xl">{liveScore.finalScorePercent}%</p>
                    <p className="pb-1 text-sm font-bold text-[#64748B]">{liveScore.actualScore} / {liveScore.maxScore}</p>
                  </div>
                </div>

                <div className={cn("rounded-md border px-4 py-3 text-sm font-black", zoneClassNames[liveScore.performanceZone])}>
                  {coachingPerformanceZoneDisplayLabels[liveScore.performanceZone]}
                </div>

                <div className="grid gap-3">
                  <div className={`${adminInsetPanelClassName} p-4`}>
                    <div className="flex items-start gap-3">
                      <Award className="mt-0.5 h-4 w-4 text-emerald-600" />
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-[0.14em] text-[#64748B]">Strongest Parameter</p>
                        <p className="mt-1 text-sm font-black text-[#0F172A]">{liveScore.strongestParameter.label}</p>
                      </div>
                    </div>
                  </div>
                  <div className={`${adminInsetPanelClassName} p-4`}>
                    <div className="flex items-start gap-3">
                      <Target className="mt-0.5 h-4 w-4 text-[#F97316]" />
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-[0.14em] text-[#64748B]">Key Development Area</p>
                        <p className="mt-1 text-sm font-black text-[#0F172A]">{liveScore.keyDevelopmentArea.label}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="rounded-md border border-dashed border-[#CBD5E1] bg-[#F8FAFC] p-4 text-sm font-semibold leading-6 text-[#64748B]">
                Complete all 20 ratings to calculate the final score, zone, strongest parameter, and key development area.
              </div>
            )}

            {message ? (
              <div
                className={cn(
                  "flex items-start gap-3 rounded-md border px-4 py-3 text-sm font-semibold leading-6",
                  message.tone === "success"
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                    : "border-rose-200 bg-rose-50 text-rose-800",
                )}
              >
                {message.tone === "success" ? <CheckCircle2 className="mt-0.5 h-4 w-4" /> : <AlertCircle className="mt-0.5 h-4 w-4" />}
                <span>{message.text}</span>
              </div>
            ) : null}

            {result ? (
              <div className={`${adminInsetPanelClassName} p-4`}>
                <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#64748B]">Latest Result</p>
                <p className="mt-1 text-sm font-black text-[#0F172A]">{result.report.report_number}</p>
                <p className="mt-1 text-xs font-semibold uppercase tracking-[0.12em] text-[#F97316]">{result.report.status.replace(/_/g, " ")}</p>
              </div>
            ) : null}

            <div className="grid gap-2">
              <Button
                className="h-12 gap-2 rounded-md bg-white text-[#0F172A] ring-1 ring-[#D8E0EA] hover:bg-[#F8FAFC]"
                disabled={isBusy}
                onClick={handleSaveDraft}
                variant="secondary"
              >
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save Draft
              </Button>
              <Button
                className="h-12 gap-2 rounded-md bg-[#F97316] font-black shadow-[0_14px_30px_rgba(249,115,22,0.22)] hover:bg-[#EA580C]"
                disabled={isBusy}
                onClick={handleSubmitReport}
              >
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Submit Report
              </Button>
            </div>

            <div className="flex items-start gap-3 rounded-md border border-[#E2E8F0] bg-[#F8FAFC] p-4 text-xs font-semibold leading-5 text-[#64748B]">
              <ClipboardCheck className="mt-0.5 h-4 w-4 text-[#F97316]" />
              <p>No notification or employee acknowledgment UI is triggered from this screen yet.</p>
            </div>
          </div>
        </Card>
      </aside>
    </div>
  );
}
