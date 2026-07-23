"use client";

// Talent Acquisition — create a Medical Rep candidate from an uploaded CV. AI extracts the
// fields (src/lib/recruitment/cv-extraction.ts); this panel shows them pre-filled for review,
// flags anything the AI wasn't confident about, and lets Talent Acquisition edit any field
// before saving — the "auto-populate, then correct if needed" flow, so the common case is a
// single click rather than retyping everything by hand.

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ExtractedCandidateFields, ExtractedFieldConfidence } from "@/lib/recruitment/cv-extraction";

type FieldKey = keyof ExtractedCandidateFields;

type DraftFields = {
  fullName: string;
  email: string;
  phone: string;
  address: string;
  governorate: string;
  faculty: string;
  university: string;
  hasPriorWorkExperience: string; // "" | "true" | "false"
  hasMedicalRepExperience: string; // "" | "true" | "false"
  medicalRepEmployer: string;
  medicalRepExperienceFrom: string;
  medicalRepExperienceTo: string;
};

const emptyDraft: DraftFields = {
  address: "",
  email: "",
  faculty: "",
  fullName: "",
  governorate: "",
  hasMedicalRepExperience: "",
  hasPriorWorkExperience: "",
  medicalRepEmployer: "",
  medicalRepExperienceFrom: "",
  medicalRepExperienceTo: "",
  phone: "",
  university: "",
};

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

function draftFromExtraction(fields: ExtractedCandidateFields): { draft: DraftFields; confidence: Partial<Record<FieldKey, ExtractedFieldConfidence>> } {
  const boolToStr = (value: boolean | null) => (value === true ? "true" : value === false ? "false" : "");
  const draft: DraftFields = {
    address: fields.address.value ?? "",
    email: fields.email.value ?? "",
    faculty: fields.faculty.value ?? "",
    fullName: fields.fullName.value ?? "",
    governorate: fields.governorate.value ?? "",
    hasMedicalRepExperience: boolToStr(fields.hasMedicalRepExperience.value),
    hasPriorWorkExperience: boolToStr(fields.hasPriorWorkExperience.value),
    medicalRepEmployer: fields.medicalRepEmployer.value ?? "",
    medicalRepExperienceFrom: fields.medicalRepExperienceFrom.value ?? "",
    medicalRepExperienceTo: fields.medicalRepExperienceTo.value ?? "",
    phone: fields.phone.value ?? "",
    university: fields.university.value ?? "",
  };
  const confidence: Partial<Record<FieldKey, ExtractedFieldConfidence>> = {};
  (Object.keys(fields) as FieldKey[]).forEach((key) => {
    confidence[key] = fields[key].confidence;
  });
  return { draft, confidence };
}

function FieldLabel({ children, low }: { children: React.ReactNode; low: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
      {children}
      {low ? (
        <span className="rounded border border-amber-200 bg-amber-50 px-1 py-0.5 text-[10px] font-semibold text-amber-700">
          Check this
        </span>
      ) : null}
    </span>
  );
}

export function CvExtractionPanel({ onCreated }: { onCreated: (candidateId: string) => void }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [stage, setStage] = useState<"idle" | "review">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [extractionId, setExtractionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftFields>(emptyDraft);
  const [confidence, setConfidence] = useState<Partial<Record<FieldKey, ExtractedFieldConfidence>>>({});

  const set = (key: keyof DraftFields) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft((prev) => ({ ...prev, [key]: event.target.value }));

  const startFromCv = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose a CV file first.");
      return;
    }
    setBusy(true);
    setError(null);
    let newCandidateId: string | null = null;
    try {
      const created = await postJson("/api/recruitment/candidates", { fullName: "Pending CV Review" });
      const candidate = created.candidate as { id: string } | undefined;
      if (!candidate?.id) throw new Error("Could not create the candidate record.");
      newCandidateId = candidate.id;

      const formData = new FormData();
      formData.append("file", file);
      formData.append("kind", "cv");
      const uploadRes = await fetch(`/api/recruitment/candidates/${newCandidateId}/files`, { body: formData, method: "POST" });
      const uploadData = (await uploadRes.json().catch(() => ({}))) as Record<string, unknown>;
      if (!uploadRes.ok) throw new Error(typeof uploadData.message === "string" ? uploadData.message : "CV upload failed.");

      const extraction = await postJson(`/api/recruitment/candidates/${newCandidateId}/cv-extract`, {});
      const fields = extraction.fields as ExtractedCandidateFields | undefined;
      if (!fields) throw new Error("The AI did not return any fields.");

      const { draft: nextDraft, confidence: nextConfidence } = draftFromExtraction(fields);
      setCandidateId(newCandidateId);
      setExtractionId(typeof extraction.extractionId === "string" ? extraction.extractionId : null);
      setDraft(nextDraft);
      setConfidence(nextConfidence);
      setStage("review");
      if (fileRef.current) fileRef.current.value = "";
    } catch (caught) {
      // A partially-created stub candidate (e.g. upload succeeded but extraction failed) is
      // left as-is — Talent Acquisition can still find it in the pool and finish it manually.
      setError(caught instanceof Error ? caught.message : "AI CV extraction failed.");
      setStage("idle");
      void newCandidateId;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!candidateId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/recruitment/candidates/${candidateId}`, {
        body: JSON.stringify({
          address: draft.address || null,
          email: draft.email || null,
          extractionId,
          faculty: draft.faculty || null,
          fullName: draft.fullName.trim(),
          governorate: draft.governorate || null,
          hasMedicalRepExperience: draft.hasMedicalRepExperience ? draft.hasMedicalRepExperience === "true" : null,
          hasPriorWorkExperience: draft.hasPriorWorkExperience ? draft.hasPriorWorkExperience === "true" : null,
          medicalRepEmployer: draft.medicalRepEmployer || null,
          medicalRepExperienceFrom: draft.medicalRepExperienceFrom || null,
          medicalRepExperienceTo: draft.medicalRepExperienceTo || null,
          phone: draft.phone || null,
        }),
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
    setDraft(emptyDraft);
    setConfidence({});
    setError(null);
  };

  if (stage !== "review") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <input ref={fileRef} accept=".pdf,.doc,.docx" className="text-sm" type="file" />
        <Button disabled={busy} onClick={() => void startFromCv()} variant="secondary">
          {busy ? "Reading CV…" : "Create from CV (AI)"}
        </Button>
        {error ? <p className="text-xs text-rose-600">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded border border-slate-200 bg-slate-50/60 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Review the AI-extracted fields, correct anything wrong, then save.
      </p>
      {error ? <p className="text-xs text-rose-600">{error}</p> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <FieldLabel low={confidence.fullName === "low"}>Full name</FieldLabel>
          <Input onChange={set("fullName")} value={draft.fullName} />
        </div>
        <div>
          <FieldLabel low={confidence.email === "low"}>Email</FieldLabel>
          <Input onChange={set("email")} value={draft.email} />
        </div>
        <div>
          <FieldLabel low={confidence.phone === "low"}>Phone</FieldLabel>
          <Input onChange={set("phone")} value={draft.phone} />
        </div>
        <div>
          <FieldLabel low={confidence.address === "low"}>Address</FieldLabel>
          <Input onChange={set("address")} value={draft.address} />
        </div>
        <div>
          <FieldLabel low={confidence.governorate === "low"}>Governorate</FieldLabel>
          <Input onChange={set("governorate")} value={draft.governorate} />
        </div>
        <div>
          <FieldLabel low={confidence.faculty === "low"}>Faculty</FieldLabel>
          <Input onChange={set("faculty")} value={draft.faculty} />
        </div>
        <div>
          <FieldLabel low={confidence.university === "low"}>University</FieldLabel>
          <Input onChange={set("university")} value={draft.university} />
        </div>
        <div>
          <FieldLabel low={confidence.hasPriorWorkExperience === "low"}>Prior work experience</FieldLabel>
          <select
            className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
            onChange={set("hasPriorWorkExperience")}
            value={draft.hasPriorWorkExperience}
          >
            <option value="">Not stated</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </div>
        <div>
          <FieldLabel low={confidence.hasMedicalRepExperience === "low"}>Medical Rep experience</FieldLabel>
          <select
            className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
            onChange={set("hasMedicalRepExperience")}
            value={draft.hasMedicalRepExperience}
          >
            <option value="">Not stated</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </div>
        {draft.hasMedicalRepExperience === "true" ? (
          <>
            <div>
              <FieldLabel low={confidence.medicalRepEmployer === "low"}>Medical Rep employer</FieldLabel>
              <Input onChange={set("medicalRepEmployer")} value={draft.medicalRepEmployer} />
            </div>
            <div>
              <FieldLabel low={confidence.medicalRepExperienceFrom === "low"}>From</FieldLabel>
              <Input onChange={set("medicalRepExperienceFrom")} type="date" value={draft.medicalRepExperienceFrom} />
            </div>
            <div>
              <FieldLabel low={confidence.medicalRepExperienceTo === "low"}>To</FieldLabel>
              <Input onChange={set("medicalRepExperienceTo")} type="date" value={draft.medicalRepExperienceTo} />
            </div>
          </>
        ) : null}
      </div>

      <div className="flex gap-2">
        <Button disabled={busy || !draft.fullName.trim()} onClick={() => void save()}>
          Save candidate
        </Button>
        <Button disabled={busy} onClick={cancel} variant="ghost">
          Cancel
        </Button>
      </div>
    </div>
  );
}
