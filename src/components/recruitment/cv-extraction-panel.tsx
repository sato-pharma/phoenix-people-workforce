"use client";

// The recruiter — create a candidate from an uploaded CV. AI extracts the fields
// (src/lib/recruitment/cv-extraction.ts) against the universal schema
// (src/lib/recruitment/cv-field-schemas.ts); this panel then hands the raw extraction to the
// drag-and-drop review board (cv-extraction-review-board.tsx) before saving.
//
// The position picker below is deliberately conditional. There used to be two templates and the
// reviewer had to declare the role BEFORE the CV was read — which is backwards, since the CV is
// what says what the role is. The schema is now universal and the job title is an extracted field,
// so the picker renders only if some future schema is added alongside it.
//
// THE LOOK (2026-10-19 premium sweep): the idle row sits in the module's recessed toolbar tray —
// the file well, then the one action — and a failure is said on a rose rule that wraps.

import { useRef, useState } from "react";
import { AlertCircle, FileUp, Loader2, Sparkles } from "lucide-react";

import { adminControlDepthClassName, adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";
import { CvExtractionReviewBoard } from "@/components/recruitment/cv-extraction-review-board";
import { recruitmentToolbarClassName } from "@/components/recruitment/recruitment-premium";
import type { ExtractedCandidateFields } from "@/lib/recruitment/cv-extraction";
import { defaultCvPositionKey, getCvPositionSchema, listCvPositionSchemas } from "@/lib/recruitment/cv-field-schemas";
import { phxButtonGhostClassName, phxLabelTextClassName, phxSelectClassName } from "@/components/ui/form-tokens";

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Request failed.");
  return data;
}

const positionOptions = listCvPositionSchemas();

export function CvExtractionPanel({ onCreated }: { onCreated: (candidateId: string) => void }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [stage, setStage] = useState<"idle" | "review">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [extractionId, setExtractionId] = useState<string | null>(null);
  const [fields, setFields] = useState<ExtractedCandidateFields>({});
  const [positionKey, setPositionKey] = useState(defaultCvPositionKey);
  const schema = getCvPositionSchema(positionKey)!;

  const startFromCv = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose a CV file first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await postJson("/api/recruitment/candidates", { fullName: "Pending CV Review" });
      const candidate = created.candidate as { id: string } | undefined;
      if (!candidate?.id) throw new Error("Could not create the candidate record.");
      const newCandidateId = candidate.id;

      const formData = new FormData();
      formData.append("file", file);
      formData.append("kind", "cv");
      const uploadRes = await fetch(`/api/recruitment/candidates/${newCandidateId}/files`, { body: formData, method: "POST" });
      const uploadData = (await uploadRes.json().catch(() => ({}))) as Record<string, unknown>;
      if (!uploadRes.ok) throw new Error(typeof uploadData.message === "string" ? uploadData.message : "CV upload failed.");

      const extraction = await postJson(`/api/recruitment/candidates/${newCandidateId}/cv-extract`, { positionKey });
      const extractedFields = extraction.fields as ExtractedCandidateFields | undefined;
      if (!extractedFields) throw new Error("No fields were returned. Try again.");

      setCandidateId(newCandidateId);
      setExtractionId(typeof extraction.extractionId === "string" ? extraction.extractionId : null);
      setFields(extractedFields);
      setStage("review");
      if (fileRef.current) fileRef.current.value = "";
    } catch (caught) {
      // A partially-created stub candidate (e.g. upload succeeded but extraction failed) is
      // left as-is — the recruiter can still find it in the pool and finish it manually.
      setError(caught instanceof Error ? caught.message : "CV extraction failed.");
      setStage("idle");
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    // Best-effort cleanup of the "Pending CV Review" stub if the reviewer backs out —
    // failures here (e.g. no delete permission) are silently ignored.
    if (candidateId) {
      void fetch(`/api/recruitment/candidates/${candidateId}`, { method: "DELETE" }).catch(() => {});
    }
    setStage("idle");
    setBusy(false);
    setCandidateId(null);
    setExtractionId(null);
    setFields({});
    setError(null);
  };

  const save = async (values: Record<string, unknown>) => {
    if (!candidateId) return;
    if (!String(values.fullName ?? "").trim()) {
      setError("Full name is required — drag or type a value into that column first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/recruitment/candidates/${candidateId}`, {
        body: JSON.stringify({ ...values, extractionId }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Failed to save the candidate.");
      onCreated(candidateId);
      cancel();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to save the candidate.");
    } finally {
      setBusy(false);
    }
  };

  if (stage !== "review") {
    return (
      <div className={recruitmentToolbarClassName}>
        {positionOptions.length > 1 ? (
          <select
            className={phxSelectClassName}
            disabled={busy}
            onChange={(event) => setPositionKey(event.target.value)}
            value={positionKey}
          >
            {positionOptions.map((option) => (
              <option key={option.positionKey} value={option.positionKey}>
                {option.label}
              </option>
            ))}
          </select>
        ) : null}
        <div className="flex min-w-0 grow basis-60 flex-col gap-1.5">
          <span className={`inline-flex items-center gap-1.5 ${phxLabelTextClassName}`}>
            <FileUp aria-hidden="true" className="h-3.5 w-3.5 text-orange-600" />
            CV file
          </span>
          <span
            className={`flex min-w-0 items-center border border-dashed border-slate-300 bg-white px-3 py-2 ${adminRecessedDepthClassName}`}
          >
            <input
              ref={fileRef}
              accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
              className="min-w-0 max-w-full text-sm text-slate-700"
              type="file"
            />
          </span>
        </div>
        <button
          className={`${phxButtonGhostClassName} ${adminControlDepthClassName} disabled:shadow-none`}
          disabled={busy}
          onClick={() => void startFromCv()}
          type="button"
        >
          {busy ? (
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles aria-hidden="true" className="h-3.5 w-3.5 text-orange-600" />
          )}
          {busy ? "Reading CV…" : "Create from CV"}
        </button>
        {error ? (
          <p
            className="flex basis-full items-start gap-2 border-l-[3px] border-rose-500 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800"
            role="alert"
          >
            <AlertCircle aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <CvExtractionReviewBoard busy={busy} error={error} fields={fields} onCancel={cancel} onSave={save} schema={schema} />
  );
}
