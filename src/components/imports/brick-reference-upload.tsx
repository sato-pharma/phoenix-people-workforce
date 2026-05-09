"use client";

import * as React from "react";
import { FolderUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/ui/loading-state";
import {
  AdminCallout,
  AdminSectionHeader,
  adminPanelClassName,
} from "@/components/admin/admin-design-system";

type PreviewPayload = {
  detectedColumns: string[];
  fileName: string;
  line: string;
  summary: {
    areas: number;
    bricks: number;
    rows: number;
  };
};

export function BrickReferenceUpload() {
  const [line, setLine] = React.useState("Pedia");
  const [selectedFile, setSelectedFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<PreviewPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    setPreview(null);
    setError(null);
    setSuccess(null);
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);
    formData.append("line", line);

    setIsPreviewing(true);
    try {
      const response = await fetch("/api/imports/bricks/dry-run", {
        body: formData,
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "Brick reference preview failed.");
        return;
      }
      setPreview(payload);
    } catch {
      setError("Brick reference preview failed.");
    } finally {
      setIsPreviewing(false);
    }
  }

  async function handleConfirm() {
    if (!selectedFile) return;

    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("line", line);

    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch("/api/imports/bricks/confirm", {
        body: formData,
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "Brick reference import failed.");
        return;
      }
      setSuccess(
        `${payload.summary.bricks} bricks across ${payload.summary.areas} areas were saved for ${payload.line}.`,
      );
    } catch {
      setError("Brick reference import failed.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card className={`${adminPanelClassName} p-4`}>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-4">
            <AdminSectionHeader
              description={`Import line-scoped brick references. File is validated before being applied for ${line}.`}
              title="Brick Reference"
            />
            <div className="grid gap-4 sm:grid-cols-[180px_minmax(0,1fr)]">
              <div>
                <label className="mb-2 block text-[11px] font-black uppercase tracking-[0.18em] text-[#64748B]" htmlFor="brick-line">
                  Line
                </label>
                <Input id="brick-line" onChange={(event) => setLine(event.target.value)} value={line} />
              </div>
            </div>
            <label className="flex min-h-[200px] cursor-pointer flex-col items-center justify-center rounded-[20px] border border-dashed border-[#CBD5E1] bg-white px-6 py-10 text-center transition hover:border-[#FDBA74] hover:bg-[#FFF7ED]/40">
              <div className="rounded-3xl border border-[#FED7AA] bg-[#FFF7ED] p-4 text-[#F97316]">
                <FolderUp className="h-8 w-8" />
              </div>
              <span className="mt-5 text-lg font-bold tracking-[-0.03em] text-[#0F172A]">
                Upload brick reference file
              </span>
              <span className="mt-2 max-w-md text-sm leading-6 text-[#64748B]">
                Supported formats: <span className="font-semibold text-[#0F172A]">.xlsx</span> and <span className="font-semibold text-[#0F172A]">.xls</span>.
              </span>
              <div className="mt-4 inline-flex items-center rounded-xl border border-[#E2E8F0] bg-white px-4 py-2 text-sm font-semibold text-[#0F172A]">
                Choose workbook
              </div>
              <Input
                accept=".xlsx,.xls,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="sr-only"
                onChange={handleFileChange}
                type="file"
              />
            </label>
          </div>

          <div className="rounded-[18px] border border-[#D7E0EA] bg-[#FCFDFE] p-5">
            <AdminSectionHeader
              action={
                <AdminCallout tone={selectedFile ? "success" : "neutral"}>
                  {selectedFile ? selectedFile.name : "No file selected"}
                </AdminCallout>
              }
              description="Preview then confirm to overwrite the managed source for the selected line."
              title="Import action"
            />

            <div className="mt-4 rounded-2xl border border-[#E2E8F0] bg-white p-4">
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#64748B]">Selected file</p>
              <p className="mt-2 break-words text-base font-semibold text-[#0F172A]">
                {selectedFile?.name ?? "No file selected"}
              </p>
              <p className="mt-2 text-sm text-[#64748B]">
                {isPreviewing ? "Reading workbook..." : preview ? "Preview ready." : "Choose a workbook to inspect."}
              </p>
            </div>

            <Button className="mt-4 h-11 w-full rounded-xl text-sm font-semibold" disabled={!preview || isSaving} onClick={handleConfirm}>
              {isSaving ? (
                <>
                  <LoadingSpinner className="text-white" />
                  Saving reference...
                </>
              ) : (
                "Confirm import"
              )}
            </Button>
          </div>
        </div>
      </Card>

      {error ? <AdminCallout tone="danger">{error}</AdminCallout> : null}
      {success ? <AdminCallout tone="success">{success}</AdminCallout> : null}

      {preview ? (
        <Card className={`${adminPanelClassName} p-4`}>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-[#E2E8F0] bg-[#FCFDFE] p-4">
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#64748B]">Rows read</p>
              <p className="mt-2 text-3xl font-black text-[#0F172A]">{preview.summary.rows}</p>
            </div>
            <div className="rounded-2xl border border-[#E2E8F0] bg-[#FCFDFE] p-4">
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#64748B]">Areas</p>
              <p className="mt-2 text-3xl font-black text-[#0F172A]">{preview.summary.areas}</p>
            </div>
            <div className="rounded-2xl border border-[#E2E8F0] bg-[#FCFDFE] p-4">
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#64748B]">Parsed bricks</p>
              <p className="mt-2 text-3xl font-black text-[#0F172A]">{preview.summary.bricks}</p>
            </div>
          </div>

          <div className="mt-6">
            <p className="text-sm font-semibold text-[#0F172A]">Detected columns</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {preview.detectedColumns.map((column) => (
                <span key={column} className="rounded-full border border-[#E2E8F0] bg-[#FCFDFE] px-3 py-1 text-xs font-semibold text-[#475569]">
                  {column}
                </span>
              ))}
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
