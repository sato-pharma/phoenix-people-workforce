"use client";

// Talent Acquisition — create a candidate from an uploaded CV. AI extracts the fields
// (src/lib/recruitment/cv-extraction.ts) for the selected position's schema
// (src/lib/recruitment/cv-field-schemas.ts — only Medical Rep has real fields today); this
// panel then hands the raw extraction to the drag-and-drop review board
// (cv-extraction-review-board.tsx) before saving.

import { useRef, useState } from "react";

import { CvExtractionReviewBoard } from "@/components/recruitment/cv-extraction-review-board";
import { Button } from "@/components/ui/button";
import type { ExtractedCandidateFields } from "@/lib/recruitment/cv-extraction";
import { defaultCvPositionKey, getCvPositionSchema, listCvPositionSchemas } from "@/lib/recruitment/cv-field-schemas";

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
      if (!extractedFields) throw new Error("The AI did not return any fields.");

      setCandidateId(newCandidateId);
      setExtractionId(typeof extraction.extractionId === "string" ? extraction.extractionId : null);
      setFields(extractedFields);
      setStage("review");
      if (fileRef.current) fileRef.current.value = "";
    } catch (caught) {
      // A partially-created stub candidate (e.g. upload succeeded but extraction failed) is
      // left as-is — Talent Acquisition can still find it in the pool and finish it manually.
      setError(caught instanceof Error ? caught.message : "AI CV extraction failed.");
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
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded-md border border-gray-200 px-2 py-1.5 text-sm"
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
        <input ref={fileRef} accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" className="text-sm" type="file" />
        <Button disabled={busy} onClick={() => void startFromCv()} variant="secondary">
          {busy ? "Reading CV…" : "Create from CV (AI)"}
        </Button>
        {error ? <p className="text-xs text-rose-600">{error}</p> : null}
      </div>
    );
  }

  return (
    <CvExtractionReviewBoard busy={busy} error={error} fields={fields} onCancel={cancel} onSave={save} schema={schema} />
  );
}
