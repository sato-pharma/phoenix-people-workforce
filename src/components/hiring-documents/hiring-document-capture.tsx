"use client";

import {
  AlertTriangle,
  Camera,
  Download,
  Eye,
  FileScan,
  Loader2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import * as React from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { FILE_SOURCE_BADGE } from "@/lib/hiring-documents/file-source-badge";
import { hiringDocumentsFor } from "@/lib/hiring-documents/readiness-signal";
import {
  hiringDocumentScanQueue,
  nextScanQueueItem,
  scanQueueKey,
  scanQueueProgress,
} from "@/lib/hiring-documents/scan-queue";
import type {
  HiringDocumentDefinition,
  HiringDocumentEmployeeRow,
  HiringDocumentFile,
} from "@/lib/hiring-documents/types";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { phxSelectClassName } from "@/components/ui/form-tokens";

type Props = {
  canManage: boolean;
  /** Removing a scan is permanent, so it is narrower than receiving one (mayRemoveHiringDocumentFile). */
  canRemoveFiles: boolean;
  documents: HiringDocumentDefinition[];
  employees: HiringDocumentEmployeeRow[];
  /** Set when the panel was opened from a grid cell, so it lands on that exact pair. */
  initialDocumentId?: string | null;
  initialEmployeeHrId?: string | null;
  /** Reload the dashboard so the grid's ticks and file counts follow what happened here. */
  onChanged: () => void | Promise<void>;
};

/** A page waiting to be assembled into a scan, held in the browser until Save. */
type StagedPage = {
  file: File;
  id: string;
  previewUrl: string;
};

const scanModeOptions = [
  {
    description: "Keeps official seals, stamps and ID photographs as they are. Use this unless the page is plain text.",
    label: "Colour",
    value: "colour",
  },
  { description: "Black and white, for a photocopied or plain typed page.", label: "Greyscale", value: "greyscale" },
  {
    description: "Greyscale with the contrast pushed harder, for faint print or a poor photocopy.",
    label: "High contrast",
    value: "high-contrast",
  },
] as const;

const panelLabelClassName = "mb-1 block text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-soft";
const selectClassName  = phxSelectClassName;

function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Africa/Cairo, always — a timestamp on a personnel document is read by people in Cairo. */
function formatUploadedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return stableEnGbFormatter({
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(date);
}

/** One outstanding paper. Pressing it points the form at that paper. */
function outstandingChoiceClassName(active: boolean): string {
  return active
    ? "border border-phx-accent bg-phx-accent-soft px-2.5 py-1 text-phx-xs font-black text-phx-ink"
    : "border border-phx-line bg-white px-2.5 py-1 text-phx-xs font-bold text-phx-ink hover:border-phx-accent-line";
}

export function HiringDocumentCapture({
  canManage,
  canRemoveFiles,
  documents,
  employees,
  initialDocumentId,
  initialEmployeeHrId,
  onChanged,
}: Props) {
  const [employeeHrId, setEmployeeHrId] = React.useState(initialEmployeeHrId ?? "");
  const [documentId, setDocumentId] = React.useState(initialDocumentId ?? "");
  const [scanMode, setScanMode] = React.useState<string>("colour");
  const [stagedPages, setStagedPages] = React.useState<StagedPage[]>([]);
  const [files, setFiles] = React.useState<HiringDocumentFile[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [queueRunning, setQueueRunning] = React.useState(false);
  /** Filed or skipped on this walk through the queue. */
  const [queuePassed, setQueuePassed] = React.useState<ReadonlySet<string>>(() => new Set());
  // Read after an upload's awaits, where the state above is the value from before she may have left.
  const queueRunningRef = React.useRef(false);

  const cameraInputRef = React.useRef<HTMLInputElement>(null);
  const galleryInputRef = React.useRef<HTMLInputElement>(null);
  const uploadInputRef = React.useRef<HTMLInputElement>(null);

  const selectedEmployee = React.useMemo(
    () => employees.find((employee) => employee.hrId === employeeHrId) ?? null,
    [employees, employeeHrId],
  );
  const selectedDocument = React.useMemo(
    () => documents.find((document) => document.id === documentId) ?? null,
    [documents, documentId],
  );
  const scanQueue = React.useMemo(
    () => (canManage ? hiringDocumentScanQueue(documents, employees) : []),
    [canManage, documents, employees],
  );
  const queueProgress = scanQueueProgress(scanQueue, queuePassed);

  function runQueue(passed: ReadonlySet<string>) {
    queueRunningRef.current = true;
    setQueueRunning(true);
    setQueuePassed(passed);
    const next = nextScanQueueItem(scanQueue, passed);
    if (next) {
      setEmployeeHrId(next.employeeHrId);
      setDocumentId(next.documentId);
    }
  }

  function leaveQueue() {
    queueRunningRef.current = false;
    setQueueRunning(false);
    setQueuePassed(new Set());
  }

  /** Past the paper on screen. The files effect then reads the next one's, so nothing here re-reads. */
  function passQueuePaper() {
    runQueue(new Set(queuePassed).add(scanQueueKey(employeeHrId, documentId)));
  }

  /** Choosing a person or a paper by hand means she has left the queue's order, so it lets go. */
  function chooseEmployee(hrId: string) {
    leaveQueue();
    setEmployeeHrId(hrId);
  }

  function chooseDocument(id: string) {
    leaveQueue();
    setDocumentId(id);
  }

  // Object URLs are a manual allocation the garbage collector will not reclaim. Held in a ref so
  // the unmount cleanup sees the CURRENT staged list — closing over the state directly would revoke
  // the empty array this component mounted with and leak every photograph HR ever staged.
  const stagedPagesRef = React.useRef<StagedPage[]>([]);
  React.useEffect(() => {
    stagedPagesRef.current = stagedPages;
  }, [stagedPages]);
  React.useEffect(() => {
    return () => {
      for (const page of stagedPagesRef.current) URL.revokeObjectURL(page.previewUrl);
    };
  }, []);

  const loadFiles = React.useCallback(async (): Promise<HiringDocumentFile[]> => {
    if (!employeeHrId || !documentId) return [];
    const params = new URLSearchParams({ documentId, employeeHrId });
    const response = await fetch(`/api/hiring-documents/files?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message ?? payload.error ?? "Unable to load the files on record.");
    return (payload.files ?? []) as HiringDocumentFile[];
  }, [documentId, employeeHrId]);

  // `react-hooks/set-state-in-effect` is an ERROR in this repo, so every setState here lives inside
  // the scheduled callback rather than the effect body. The `cancelled` flag is not ceremony: HR
  // changing employee twice quickly would otherwise let the first request's answer land last and
  // show one employee's documents under another's name.
  React.useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      if (!employeeHrId || !documentId) {
        setFiles([]);
        return;
      }
      setIsLoadingFiles(true);
      setError(null);
      loadFiles()
        .then((loaded) => {
          if (!cancelled) setFiles(loaded);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setError(cause instanceof Error ? cause.message : "Unable to load the files on record.");
          setFiles([]);
        })
        .finally(() => {
          if (!cancelled) setIsLoadingFiles(false);
        });
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [documentId, employeeHrId, loadFiles]);

  /** Re-read the list after an attach or a delete, where an error belongs to that action. */
  async function reloadFiles() {
    try {
      setFiles(await loadFiles());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load the files on record.");
    }
  }

  function stagePages(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const added: StagedPage[] = Array.from(fileList).map((file, index) => ({
      file,
      id: `${file.name}-${file.size}-${Date.now()}-${index}`,
      previewUrl: URL.createObjectURL(file),
    }));
    setStagedPages((current) => [...current, ...added]);
    setNotice(null);
    setError(null);
  }

  function removeStagedPage(id: string) {
    setStagedPages((current) => {
      const page = current.find((entry) => entry.id === id);
      if (page) URL.revokeObjectURL(page.previewUrl);
      return current.filter((entry) => entry.id !== id);
    });
  }

  function clearStagedPages() {
    setStagedPages((current) => {
      for (const page of current) URL.revokeObjectURL(page.previewUrl);
      return [];
    });
  }

  async function submit(mode: "scan" | "upload", chosen: File[]) {
    if (!canManage) return;
    if (!employeeHrId || !documentId) {
      setError("Choose an employee and a document first.");
      return;
    }
    if (chosen.length === 0) return;

    setBusy(mode);
    setError(null);
    setNotice(null);

    try {
      const body = new FormData();
      body.set("employeeHrId", employeeHrId);
      body.set("documentId", documentId);
      body.set("mode", mode);
      if (mode === "scan") body.set("scanMode", scanMode);
      for (const file of chosen) body.append("file", file);

      const response = await fetch("/api/hiring-documents/files", { body, method: "POST" });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "Unable to attach the document.");
        return;
      }

      if (mode === "scan") clearStagedPages();
      const documentName = selectedDocument?.name ?? "the document";
      const employeeName = selectedEmployee?.fullName ?? employeeHrId;
      setNotice(
        mode === "scan"
          ? `Scanned ${chosen.length} ${chosen.length === 1 ? "page" : "pages"} into one PDF for ${employeeName} — ${documentName} is now marked submitted.`
          : `Attached ${chosen.length} ${chosen.length === 1 ? "file" : "files"} for ${employeeName} — ${documentName} is now marked submitted.`,
      );
      await reloadFiles();
      await onChanged();
      // LAST, because `reloadFiles` still holds this paper: moving first would list its files under
      // the next paper's heading. And never with pages still staged: an upload leaves them there, and
      // they would then save under the wrong paper.
      if (queueRunningRef.current && (mode === "scan" || stagedPages.length === 0)) passQueuePaper();
    } catch {
      setError("Unable to attach the document.");
    } finally {
      setBusy(null);
    }
  }

  async function deleteFile(file: HiringDocumentFile) {
    if (!canManage) return;
    setBusy(`delete:${file.id}`);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/hiring-documents/files/${file.id}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "Unable to remove the file.");
        return;
      }
      setNotice(
        payload.remainingFiles === 0
          ? `Removed ${file.fileName}. Nothing is on file now, so the document went back to pending.`
          : `Removed ${file.fileName}.`,
      );
      await reloadFiles();
      await onChanged();
    } catch {
      setError("Unable to remove the file.");
    } finally {
      setBusy(null);
    }
  }

  const outstanding = React.useMemo<{
    notSubmitted: HiringDocumentDefinition[];
    tickedWithNothingOnFile: HiringDocumentDefinition[];
  }>(() => {
    if (!selectedEmployee) return { notSubmitted: [], tickedWithNothingOnFile: [] };
    const notSubmitted: HiringDocumentDefinition[] = [];
    const tickedWithNothingOnFile: HiringDocumentDefinition[] = [];
    // The applicable documents only: listing a clearance as "not submitted" for somebody who has
    // not left would put five permanent items on every active employee's outstanding list — the
    // same defect the readiness figures had before the exit flag (owner ruling, 2026-09-29).
    for (const document of hiringDocumentsFor(documents, selectedEmployee)) {
      const entry = selectedEmployee.documents[document.id];
      if (!entry || entry.status !== "submitted") {
        notSubmitted.push(document);
      } else if (entry.fileCount === 0) {
        tickedWithNothingOnFile.push(document);
      }
    }
    return { notSubmitted, tickedWithNothingOnFile };
  }, [documents, selectedEmployee]);

  return (
    <div className="space-y-4">
      {error ? (
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-[#B91C1C]" />
          <div>
            <h2 className="text-sm font-bold text-[#B91C1C]">Capture failed</h2>
            <p className="mt-1 text-sm text-[#991B1B]">{error}</p>
          </div>
        </AdminCallout>
      ) : null}
      {notice ? (
        <AdminCallout tone="success">
          <FileScan className="mt-0.5 h-5 w-5 text-[#166534]" />
          <p className="text-sm font-bold text-[#166534]">{notice}</p>
        </AdminCallout>
      ) : null}

      {canManage && queueRunning && queueProgress.position <= queueProgress.total ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-phx-accent bg-phx-accent-soft p-4">
          <div className="min-w-0 flex-1 basis-56">
            <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-soft">
              Paper {queueProgress.position} of {queueProgress.total}
            </p>
            <p className="mt-1 break-words text-sm font-black text-phx-ink" dir="auto">{selectedEmployee?.fullName}</p>
            <p className="break-words text-sm font-semibold text-phx-ink-soft">{selectedDocument?.name}</p>
            {stagedPages.length > 0 ? (
              <p className="mt-1 text-phx-xs font-bold text-phx-warn">Save or discard the pages below before you skip this paper.</p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy !== null || stagedPages.length > 0} onClick={passQueuePaper} type="button" variant="secondary">
              Skip
            </Button>
            <Button disabled={busy !== null} onClick={leaveQueue} type="button" variant="ghost">
              Stop
            </Button>
          </div>
        </div>
      ) : null}
      {canManage && queueRunning && queueProgress.position > queueProgress.total ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-phx-line bg-white p-4 shadow-none">
          <p className="min-w-0 flex-1 basis-56 text-sm font-black text-phx-ink">
            {queueProgress.skipped === 0
              ? "The queue is finished. Every ticked paper has a scan on file."
              : `The queue is finished. ${queueProgress.skipped} skipped ${queueProgress.skipped === 1 ? "paper is" : "papers are"} still without a scan.`}
          </p>
          <div className="flex flex-wrap gap-2">
            {queueProgress.skipped > 0 ? (
              <Button onClick={() => runQueue(new Set())} type="button" variant="secondary">
                Go through skipped
              </Button>
            ) : null}
            <Button onClick={leaveQueue} type="button" variant="ghost">
              Close
            </Button>
          </div>
        </div>
      ) : null}
      {canManage && !queueRunning && scanQueue.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-phx-line bg-white p-4 shadow-none">
          <div className="min-w-0 flex-1 basis-56">
            <p className="text-sm font-black text-phx-ink">
              {scanQueue.length} {scanQueue.length === 1 ? "paper is" : "papers are"} ticked with no scan on file
            </p>
            <p className="mt-0.5 text-phx-xs font-semibold text-phx-ink-soft">
              One at a time, newest hire first. Saving a scan moves to the next paper.
            </p>
          </div>
          <Button onClick={() => runQueue(new Set())} type="button">
            Start the queue
          </Button>
        </div>
      ) : null}

      <Card className="space-y-4 border border-phx-line bg-white p-4 shadow-none">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className={panelLabelClassName}>Employee</span>
            <SearchableSelect
              className={selectClassName}
              onChange={(event) => chooseEmployee(event.target.value)}
              value={employeeHrId}
            >
              <option value="">Choose an employee</option>
              {employees.map((employee) => (
                <option key={employee.hrId} value={employee.hrId}>
                  {employee.fullName} — {employee.hrId}
                </option>
              ))}
            </SearchableSelect>
          </label>
          <label className="block">
            <span className={panelLabelClassName}>Document</span>
            <SearchableSelect
              className={selectClassName}
              onChange={(event) => chooseDocument(event.target.value)}
              value={documentId}
            >
              <option value="">Choose a document</option>
              {documents.map((document) => (
                <option key={document.id} value={document.id}>
                  {document.name}
                </option>
              ))}
            </SearchableSelect>
          </label>
        </div>

        {selectedEmployee ? (
          <div className="border-t border-phx-line pt-3">
            <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-soft">
              Still outstanding for {selectedEmployee.fullName}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {outstanding.notSubmitted.length === 0 ? (
                <p className="text-sm font-bold text-phx-ok">Every document is submitted</p>
              ) : (
                outstanding.notSubmitted.map((document) => (
                  <button
                    aria-pressed={document.id === documentId}
                    className={outstandingChoiceClassName(document.id === documentId)}
                    key={document.id}
                    onClick={() => chooseDocument(document.id)}
                    type="button"
                  >
                    {document.name}
                  </button>
                ))
              )}
            </div>
            {outstanding.tickedWithNothingOnFile.length > 0 ? (
              <div className="mt-3">
                <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-[#B45309]">
                  Ticked, but no scan on file
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {outstanding.tickedWithNothingOnFile.map((document) => (
                    <button
                      aria-pressed={document.id === documentId}
                      className={outstandingChoiceClassName(document.id === documentId)}
                      key={document.id}
                      onClick={() => chooseDocument(document.id)}
                      type="button"
                    >
                      {document.name}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </Card>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      {/* ── Scan with the camera ──────────────────────────────────────────────────────────── */}
      <Card className="space-y-4 border border-phx-line bg-white p-4 shadow-none">
        <div>
          <h3 className="text-sm font-black uppercase tracking-[0.12em] text-phx-ink">Scan with the camera</h3>
          <p className="mt-1 text-sm text-phx-ink-soft">
            Photograph each page. Phoenix straightens the orientation, lifts the contrast, and saves every page as one
            PDF.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {scanModeOptions.map((option) => (
            <button
              className={`border p-3 text-left transition ${
                scanMode === option.value
                  ? "border-phx-accent bg-phx-accent-soft"
                  : "border-phx-line bg-white hover:border-phx-accent-line"
              }`}
              key={option.value}
              onClick={() => setScanMode(option.value)}
              type="button"
            >
              <span className="block text-sm font-bold text-phx-ink">{option.label}</span>
              <span className="mt-1 block text-xs text-phx-ink-soft">{option.description}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* `capture="environment"` opens the rear camera on a phone and is ignored on a laptop,
              where this input simply becomes a second file picker. One control, both places. */}
          <input
            accept="image/*"
            capture="environment"
            className="hidden"
            multiple
            onChange={(event) => {
              stagePages(event.target.files);
              event.target.value = "";
            }}
            ref={cameraInputRef}
            type="file"
          />
          <input
            accept="image/*"
            className="hidden"
            multiple
            onChange={(event) => {
              stagePages(event.target.files);
              event.target.value = "";
            }}
            ref={galleryInputRef}
            type="file"
          />
          <Button disabled={!canManage} onClick={() => cameraInputRef.current?.click()} type="button" variant="default">
            <Camera className="mr-2 h-4 w-4" />
            Photograph a page
          </Button>
          <Button
            disabled={!canManage}
            onClick={() => galleryInputRef.current?.click()}
            type="button"
            variant="secondary"
          >
            <Upload className="mr-2 h-4 w-4" />
            Add pages from this device
          </Button>
        </div>

        {stagedPages.length > 0 ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {stagedPages.map((page, index) => (
                <div className="relative overflow-hidden border border-phx-line bg-phx-paper" key={page.id}>
                  {/* A staged page is a local object URL, never a remote asset, so next/image would
                      add a loader for nothing. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img alt={`Page ${index + 1}`} className="h-32 w-full object-cover" src={page.previewUrl} />
                  <span className="absolute left-2 top-2 bg-phx-ink px-2 py-0.5 text-phx-2xs font-black text-white">
                    Page {index + 1}
                  </span>
                  <button
                    aria-label={`Remove page ${index + 1}`}
                    className="absolute right-2 top-2 bg-white p-1 text-[#B91C1C]"
                    onClick={() => removeStagedPage(page.id)}
                    type="button"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={!canManage || busy !== null || !employeeHrId || !documentId}
                onClick={() => void submit("scan", stagedPages.map((page) => page.file))}
                type="button"
              >
                {busy === "scan" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileScan className="mr-2 h-4 w-4" />}
                Save {stagedPages.length} {stagedPages.length === 1 ? "page" : "pages"} as one PDF
              </Button>
              <Button disabled={busy !== null} onClick={clearStagedPages} type="button" variant="ghost">
                Discard pages
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      {/* ── Upload a file as it is ────────────────────────────────────────────────────────── */}
      <Card className="space-y-3 border border-phx-line bg-white p-4 shadow-none">
        <div>
          <h3 className="text-sm font-black uppercase tracking-[0.12em] text-phx-ink">Upload a file as it is</h3>
          <p className="mt-1 text-sm text-phx-ink-soft">
            For a PDF that came off the office scanner, or a picture that already looks right. Nothing is changed — the
            file is stored exactly as it arrives. PDF, JPG, PNG or WEBP, up to 15 MB each.
          </p>
        </div>
        <input
          accept="application/pdf,image/jpeg,image/png,image/webp"
          className="hidden"
          multiple
          onChange={(event) => {
            const chosen = Array.from(event.target.files ?? []);
            event.target.value = "";
            void submit("upload", chosen);
          }}
          ref={uploadInputRef}
          type="file"
        />
        <Button
          disabled={!canManage || busy !== null || !employeeHrId || !documentId}
          onClick={() => uploadInputRef.current?.click()}
          type="button"
          variant="secondary"
        >
          {busy === "upload" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
          Choose files
        </Button>
      </Card>

      </div>

      {/* ── What is already on file ───────────────────────────────────────────────────────── */}
      <Card className="space-y-3 border border-phx-line bg-white p-4 shadow-none">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-black uppercase tracking-[0.12em] text-phx-ink">On file</h3>
          {isLoadingFiles ? <Loader2 className="h-4 w-4 animate-spin text-phx-ink-soft" /> : null}
        </div>

        {!employeeHrId || !documentId ? (
          <p className="text-sm text-phx-ink-soft">Choose an employee and a document to see what has been filed.</p>
        ) : files.length === 0 ? (
          <p className="text-sm text-phx-ink-soft">Nothing has been scanned or uploaded for this document yet.</p>
        ) : (
          <ul className="space-y-2">
            {files.map((file) => (
              <li
                className="flex flex-wrap items-center justify-between gap-3 border border-phx-line bg-phx-paper px-3 py-2"
                key={file.id}
              >
                {/*
                  WRAPS, NEVER SCROLLS. An issued file's name is long by construction — the paper,
                  the employee and the signed date, so it says what it is once it has been
                  downloaded and left this screen. At 375px that name was 188px wider than its box
                  and sat in its own horizontal scroller; wrapping is the permitted answer and
                  shortening the name is not, because the ellipsis ban and the name's whole purpose
                  both point the other way.
                */}
                <div className="min-w-0 flex-1 basis-full sm:basis-auto">
                  <p className="break-words text-sm font-semibold text-phx-ink">{file.fileName}</p>
                  <p className="mt-0.5 break-words text-xs text-phx-ink-soft">
                    {formatUploadedAt(file.uploadedAt)} · {formatSize(file.sizeBytes)}
                    {file.pageCount ? ` · ${file.pageCount} ${file.pageCount === 1 ? "page" : "pages"}` : ""}
                    {file.uploadedByName ? ` · ${file.uploadedByName}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={FILE_SOURCE_BADGE[file.source].tone}>
                    {FILE_SOURCE_BADGE[file.source].label}
                  </Badge>
                  <Button asChild className="h-8 w-8 p-0" title="View" variant="secondary">
                    <a href={`/api/hiring-documents/files/${file.id}`} rel="noreferrer" target="_blank">
                      <Eye className="h-4 w-4" />
                    </a>
                  </Button>
                  <Button asChild className="h-8 w-8 p-0" title="Download" variant="secondary">
                    <a href={`/api/hiring-documents/files/${file.id}?download=1`}>
                      <Download className="h-4 w-4" />
                    </a>
                  </Button>
                  {canRemoveFiles ? (
                    <Button
                      aria-label={`Remove ${file.fileName}`}
                      className="h-8 w-8 p-0"
                      disabled={!canManage || busy !== null}
                      onClick={() => void deleteFile(file)}
                      title="Remove"
                      variant="destructive"
                    >
                      {busy === `delete:${file.id}` ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
