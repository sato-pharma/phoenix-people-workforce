"use client";

import { Download, FileText, Loader2, Search, Trash2, UploadCloud, UserSearch } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

// employee-cv-limits, NOT employee-cv: the server module imports node:crypto and the service-role
// client, and pulling either into a browser bundle is a webpack build error. See that file's header.
import {
  CV_EMPTY_NOTICE,
  EMPLOYEE_CV_ACCEPT_ATTRIBUTE,
  EMPLOYEE_CV_TYPES_SENTENCE,
  MAX_EMPLOYEE_CV_BYTES,
  employeeCvHref,
  type EmployeeCvSource,
} from "@/lib/employees/employee-cv-limits";

/**
 * The CV on the employee master record — the two places a person touches it.
 *
 * `EmployeeCvPicker` sits on the Add Employee form, where the employee does not exist yet: it
 * STAGES the chosen file and hands back a draft id the save carries. `EmployeeCvManager` sits on
 * the master details panel of somebody who already exists, beside the photo manager, and reads or
 * replaces the file directly.
 *
 * Two components rather than one with a mode flag, because they are genuinely different: one has
 * nothing to read back and cannot show what is on file, and the other has no draft to carry.
 *
 * Both take their limits from ./employee-cv-limits rather than restating them, so the sentence a
 * person reads, the rule the server enforces and the bucket's own allow-list cannot drift apart.
 */

const ACCEPT = EMPLOYEE_CV_ACCEPT_ATTRIBUTE;

function formatSize(bytes: number | null | undefined): string {
  const value = Number(bytes ?? 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function sourceLabel(source: EmployeeCvSource | null | undefined): string {
  // "Copied from the candidate record" is not decoration: it says this is the document the person
  // actually applied with, which is a different thing from one somebody attached afterwards.
  return source === "recruitment" ? "Copied from the candidate record" : "Uploaded";
}

/** Client-side guard, so an obviously wrong file is refused before it is sent. */
function rejectionFor(file: File): string | null {
  if (file.size > MAX_EMPLOYEE_CV_BYTES) return "That file is larger than 15 MB.";
  if (file.size === 0) return "That file is empty.";
  const name = file.name.toLowerCase();
  const looksAllowed = /\.(pdf|docx?|jpe?g|png|webp)$/.test(name);
  if (!looksAllowed) return `A CV must be ${EMPLOYEE_CV_TYPES_SENTENCE}.`;
  return null;
}

export type StagedCv = { draftId: string; fileName: string; sizeBytes: number };

/**
 * Add Employee: choose the CV now, attach it the moment the employee exists.
 *
 * The file is uploaded to the staging route AS SOON AS IT IS CHOSEN rather than at save time.
 * That is deliberate — a 15MB scan on Egyptian mobile data would otherwise sit inside the save
 * request, and a person who watches "Create Master Record" spin for forty seconds presses it
 * again. Here the upload happens while they are still filling in the rest of the form, and the
 * save carries a short id.
 */
export function EmployeeCvPicker({
  onChange,
  staged,
}: {
  onChange: (staged: StagedCv | null) => void;
  staged: StagedCv | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    const rejection = rejectionFor(file);
    if (rejection) {
      setError(rejection);
      return;
    }
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/employees/cv-staging", { body, method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as {
        draftId?: string;
        fileName?: string;
        message?: string;
        sizeBytes?: number;
      };
      if (!response.ok || !payload.draftId) {
        throw new Error(payload.message || "The CV could not be uploaded.");
      }
      onChange({
        draftId: payload.draftId,
        fileName: payload.fileName ?? file.name,
        sizeBytes: payload.sizeBytes ?? file.size,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "The CV could not be uploaded.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="border border-phx-line bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileText aria-hidden="true" className="h-4 w-4 shrink-0 text-phx-ink-soft" />
          <span className="text-xs font-black uppercase tracking-widest text-phx-ink-2">CV</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            accept={ACCEPT}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
            }}
            ref={inputRef}
            type="file"
          />
          <button
            className="inline-flex h-9 items-center gap-2 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink-2 transition hover:bg-phx-paper disabled:opacity-50"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            type="button"
          >
            {busy ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud aria-hidden="true" className="h-3.5 w-3.5" />}
            {staged ? "Choose a different file" : "Attach the CV"}
          </button>
          {staged ? (
            <button
              className="inline-flex h-9 items-center gap-2 border border-phx-line bg-white px-3 text-xs font-bold text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
              disabled={busy}
              onClick={() => {
                onChange(null);
                setError(null);
              }}
              type="button"
            >
              <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
              Remove
            </button>
          ) : null}
        </div>
      </div>

      <p className="mt-2 break-words text-phx-xs leading-5 text-phx-ink-faint">
        {staged
          ? `${staged.fileName}${formatSize(staged.sizeBytes) ? ` · ${formatSize(staged.sizeBytes)}` : ""} — filed on this person's master record when the employee is created.`
          : `Optional. ${EMPLOYEE_CV_TYPES_SENTENCE.replace(/^a /, "A ")}, up to 15 MB. When the hire came from a recruitment application, the candidate's own CV is copied across automatically and nothing needs choosing here.`}
      </p>

      {error ? <p className="mt-2 break-words text-phx-xs font-semibold text-rose-700">{error}</p> : null}
    </div>
  );
}

type CvRecord = {
  contentType: string;
  fileName: string;
  sizeBytes: number | null;
  source: EmployeeCvSource;
  uploadedAt: string | null;
};

/** One candidate the search offered — mirrors CandidateCvMatch on the server. */
type CandidateMatch = {
  candidateId: string;
  candidateName: string;
  cvFileName: string;
  cvUploadedAt: string | null;
  phoneTail: string | null;
};

/**
 * Carry the CV across from the candidate record — for somebody hired before the two were linked.
 *
 * 🔴 IT SEARCHES AND OFFERS; IT NEVER MATCHES. There is no "find this person's CV" button, and
 * that absence is the design. Measured on production 2026-09-29: of the 8 employees with no CV
 * whose mobile matched a candidate who had one, THREE were different people — a CV forwarded over
 * WhatsApp carries the forwarder's number, so one HR person's own mobile matched three strangers'
 * CVs. Whoever attaches it reads the candidate's name, the tail of their phone and the CV's own
 * filename, and decides. A stranger's CV filed under an employee's name is worse than none.
 *
 * Seeded with the employee's own name so the ordinary case is: open, look, attach.
 */
function CarryFromRecruitment({
  employeeName,
  endpoint,
  onAttached,
}: {
  employeeName?: string | null;
  endpoint: string;
  onAttached: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(String(employeeName ?? "").trim());
  const [matches, setMatches] = useState<CandidateMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [attaching, setAttaching] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const search = useCallback(async () => {
    const q = query.trim();
    if (q.length < 3) {
      setNote("Type at least three letters of the candidate's name, or their phone number.");
      setMatches(null);
      return;
    }
    setNote(null);
    setSearching(true);
    try {
      const response = await fetch(`${endpoint}?candidates=${encodeURIComponent(q)}`, {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        candidates?: CandidateMatch[];
        message?: string;
      };
      if (!response.ok) throw new Error(payload.message || "The candidate search failed.");
      setMatches(Array.isArray(payload.candidates) ? payload.candidates : []);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "The candidate search failed.");
      setMatches(null);
    } finally {
      setSearching(false);
    }
  }, [endpoint, query]);

  async function attach(match: CandidateMatch) {
    setNote(null);
    setAttaching(match.candidateId);
    try {
      const response = await fetch(endpoint, {
        body: JSON.stringify({ candidateId: match.candidateId }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) throw new Error(payload.message || "That CV could not be carried across.");
      await onAttached();
      setOpen(false);
      setMatches(null);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "That CV could not be carried across.");
    } finally {
      setAttaching(null);
    }
  }

  if (!open) {
    return (
      <button
        className="inline-flex h-9 items-center gap-2 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink-2 transition hover:bg-phx-paper"
        onClick={() => setOpen(true)}
        type="button"
      >
        <UserSearch aria-hidden="true" className="h-3.5 w-3.5" />
        From recruitment
      </button>
    );
  }

  return (
    <div className="mt-3 w-full border border-phx-line bg-phx-paper p-3">
      <p className="break-words text-phx-xs leading-5 text-phx-ink-faint">
        Search the candidate this person applied as, then check the name, the phone and the file
        name before attaching — the CV becomes part of their permanent record.
      </p>
      {/* w-full + flex-wrap, never a fixed width: this panel opens inside a details drawer that is
          a phone's width on mobile, and the FITS-THE-SCREEN rule is fit by wrapping. */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          className="h-9 min-w-0 flex-1 border border-phx-line bg-white px-2 text-xs text-phx-ink-2"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void search();
            }
          }}
          placeholder="Candidate name or phone"
          value={query}
        />
        <button
          className="inline-flex h-9 items-center gap-2 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink-2 transition hover:bg-white disabled:opacity-50"
          disabled={searching}
          onClick={() => void search()}
          type="button"
        >
          {searching ? (
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Search aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          Search
        </button>
        <button
          className="inline-flex h-9 items-center px-2 text-xs font-bold text-phx-ink-faint transition hover:text-phx-ink-2"
          onClick={() => {
            setOpen(false);
            setMatches(null);
            setNote(null);
          }}
          type="button"
        >
          Cancel
        </button>
      </div>

      {matches ? (
        matches.length === 0 ? (
          <p className="mt-2 break-words text-phx-xs text-phx-ink-faint">
            No candidate with a CV on file matches that. Only candidates who actually have a CV are
            offered — there is nothing to carry from the others.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {matches.map((match) => (
              <li
                className="flex flex-wrap items-center justify-between gap-2 border border-phx-line bg-white p-2"
                key={match.candidateId}
              >
                <div className="min-w-0">
                  <p className="break-words text-xs font-bold text-phx-ink-2">{match.candidateName}</p>
                  <p className="break-words text-phx-2xs text-phx-ink-faint">
                    {match.cvFileName}
                    {match.phoneTail ? ` · phone ends ${match.phoneTail}` : ""}
                  </p>
                </div>
                <button
                  className="inline-flex h-8 shrink-0 items-center gap-2 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink-2 transition hover:bg-phx-paper disabled:opacity-50"
                  disabled={attaching !== null}
                  onClick={() => void attach(match)}
                  type="button"
                >
                  {attaching === match.candidateId ? (
                    <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  Attach this CV
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {note ? <p className="mt-2 break-words text-phx-xs font-semibold text-rose-700">{note}</p> : null}
    </div>
  );
}

/**
 * The master details panel: what is on file, and the three things that can be done to it.
 *
 * The reader here is HR looking at an existing record, so this one loads the metadata (`?meta=1`)
 * rather than being told it — the panel opens from a directory row that does not carry it, and a
 * second query for one person is cheaper than widening the directory's select list for every row
 * on every render.
 */
export function EmployeeCvManager({
  employeeName,
  hrId,
}: {
  /** Only ever used to seed the candidate search box, so the common case is open-look-attach. */
  employeeName?: string | null;
  hrId: string;
}) {
  const endpoint = employeeCvHref(hrId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [cv, setCv] = useState<CvRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permitted, setPermitted] = useState(true);

  /**
   * Re-read what is on file. Called from the upload handler, where a setState is ordinary.
   *
   * `loading` starts true and this only ever turns it off — a refresh after an upload needs no
   * spinner of its own, because `busy` is already showing on the button that triggered it.
   */
  const load = useCallback(async () => {
    try {
      const response = await fetch(`${endpoint}?meta=1`, { cache: "no-store" });
      if (response.status === 403 || response.status === 401) {
        setPermitted(false);
        return;
      }
      const payload = (await response.json().catch(() => ({}))) as { cv?: CvRecord | null };
      setCv(payload.cv ?? null);
    } catch {
      setCv(null);
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  // Initial read, written as a promise chain rather than `void load()` so every setState lands
  // inside a callback. Calling an async loader straight from an effect body trips
  // react-hooks/set-state-in-effect, which is an ERROR here — the same shape, and the same
  // solution, as BiometricDevicesCard.
  useEffect(() => {
    let active = true;

    fetch(`${endpoint}?meta=1`, { cache: "no-store" })
      .then(async (response) => {
        if (!active) return;
        // A reader without the grant sees nothing at all rather than a disabled button: this is
        // not a capability they are one click away from having, and offering it would be a lie.
        if (response.status === 403 || response.status === 401) {
          setPermitted(false);
          return;
        }
        const payload = (await response.json().catch(() => ({}))) as { cv?: CvRecord | null };
        if (active) setCv(payload.cv ?? null);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [endpoint]);

  async function upload(file: File) {
    setError(null);
    const rejection = rejectionFor(file);
    if (rejection) {
      setError(rejection);
      return;
    }
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch(endpoint, { body, method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) throw new Error(payload.message || "The CV could not be uploaded.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The CV could not be uploaded.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove() {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(endpoint, { method: "DELETE" });
      const payload = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) throw new Error(payload.message || "The CV could not be removed.");
      setCv(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The CV could not be removed.");
    } finally {
      setBusy(false);
    }
  }

  if (!permitted) return null;

  return (
    <div className="border border-phx-line bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileText aria-hidden="true" className="h-4 w-4 shrink-0 text-phx-ink-soft" />
          <span className="text-xs font-black uppercase tracking-widest text-phx-ink-2">CV</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {cv ? (
            <a
              className="inline-flex h-9 items-center gap-2 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink-2 transition hover:bg-phx-paper"
              href={endpoint}
              rel="noreferrer"
            >
              <Download aria-hidden="true" className="h-3.5 w-3.5" />
              Download
            </a>
          ) : null}
          <input
            accept={ACCEPT}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
            ref={inputRef}
            type="file"
          />
          <button
            className="inline-flex h-9 items-center gap-2 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink-2 transition hover:bg-phx-paper disabled:opacity-50"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            type="button"
          >
            {busy ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud aria-hidden="true" className="h-3.5 w-3.5" />}
            {cv ? "Replace" : "Attach the CV"}
          </button>
          {/* Offered only when there is nothing on file. Once a CV is attached, replacing it with
              a candidate's copy is the rarer act and the Replace button above already does it
              from a file — keeping both here would put two ways to overwrite a document side by
              side, on a panel whose other buttons are Download and Remove. */}
          {cv ? null : (
            <CarryFromRecruitment
              employeeName={employeeName}
              endpoint={endpoint}
              onAttached={load}
            />
          )}
          {cv ? (
            <button
              className="inline-flex h-9 items-center gap-2 border border-phx-line bg-white px-3 text-xs font-bold text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
              disabled={busy}
              onClick={() => void remove()}
              type="button"
            >
              <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
              Remove
            </button>
          ) : null}
        </div>
      </div>

      <p className="mt-2 break-words text-phx-xs leading-5 text-phx-ink-faint">
        {loading
          ? "Reading the record…"
          : cv
            ? `${cv.fileName}${formatSize(cv.sizeBytes) ? ` · ${formatSize(cv.sizeBytes)}` : ""} · ${sourceLabel(cv.source)}`
            // One wording for "there is nothing on this record", shared with the organogram seat
            // popup: two screens saying it two ways is how a sentence the owner chose drifts.
            : `${CV_EMPTY_NOTICE}.`}
      </p>

      {error ? <p className="mt-2 break-words text-phx-xs font-semibold text-rose-700">{error}</p> : null}
    </div>
  );
}
