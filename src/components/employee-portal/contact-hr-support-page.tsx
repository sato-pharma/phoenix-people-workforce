"use client";

// ITS OWN FILE (2026-10-01, "slow to transfer between page and page"): Request Support lived inside
// employee-portal-dashboard.tsx, and a client module ships whole — so opening this one form
// downloaded the dashboard with it, recharts and the incentive calculators included (171 KB gzip of
// its own JS, 91 KB of it recharts, measured on the production build). The block below moved here
// byte for byte: what it renders, reads, sends and stores is unchanged.

import { useEffect, useRef, useState } from "react";
import { CalendarClock, CheckCircle2, Clock, Send, Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  PortalEmptyState,
  PortalMetricCard,
  PortalRecordCard,
  PortalSection,
  PortalSkeleton,
} from "@/components/employee-portal/portal-primitives";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { CONTACT_HR_DRAFT_KEY_BASE, ownerScopedStorageKey } from "@/lib/browser-storage/owner-scoped";
import type { EmployeePortalShellData } from "@/lib/employee-portal/service";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";
import {
  phxFieldClassName,
  phxFieldInvalidClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";

type SupportRequestRow = {
  attachments: { name: string; size: number; type: string }[];
  category: string;
  createdAt: string;
  description: string;
  employeeName: string;
  hrId: string;
  id: string;
  status: string;
  subcategory: string | null;
  subject: string;
};

// The draft is kept per person (`phoenix:contact-hr-draft:v2:<HR id>`): one key for the whole
// browser restored one person's message to HR for whoever signed in next on the same device.
const LEGACY_SUPPORT_DRAFT_KEY = "phoenix:contact-hr-draft:v1";
const DESCRIPTION_SOFT_LIMIT = 1000;

const hrRequestSubcategories = [
  "Profile change",
  "Document request",
  "Policy clarification",
  "Leave dispute",
] as const;

export function ContactHRSupportPage({
  data,
  initialRequests = null,
}: {
  data: EmployeePortalShellData;
  /**
   * The rep's own requests, read on the server with the page. When present the counters print
   * real numbers on first paint — Open, Resolved and Sent read "—" for as long as the browser
   * was still fetching them, which on a slow phone was the whole first look. Null = the server
   * read failed, and the browser tries once more on mount.
   */
  initialRequests?: SupportRequestRow[] | null;
}) {
  const employeeName = data.employee.fullName || data.employee.hrId || "your profile";
  const draftKey = ownerScopedStorageKey(CONTACT_HR_DRAFT_KEY_BASE, data.employee.hrId);
  const [category, setCategory] = useState("");
  const [subcategory, setSubcategory] = useState("");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const [alertNotDelivered, setAlertNotDelivered] = useState(false);
  const [recentRequests, setRecentRequests] = useState<SupportRequestRow[]>(() => initialRequests ?? []);
  const [isLoadingRequests, setIsLoadingRequests] = useState(initialRequests === null);
  // A FAILED READ IS NOT AN EMPTY HISTORY. Without this, a rep with twelve open tickets and a
  // down API was shown "No recent requests — your support history will appear here after your
  // first request": a confident, specific and false statement about his own record. AGENTS.md §1
  // — a confident zero is worse than an error.
  const [requestsError, setRequestsError] = useState(false);
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const draftRestoredRef = useRef(false);

  // There used to be three "support desks" here, each with an Email and a WhatsApp button. Their
  // addresses were placeholders on a non-existent domain and a dummy phone number — a rep who
  // tapped one wrote to nobody. Every request goes through the form below instead: it is saved,
  // HR is alerted in-app, by email and on Telegram, and the rep can follow it in the list.
  // (Pinned by tests/employee-portal-navigation.test.ts.)

  /* -------- Load recent requests on mount -------- */
  useEffect(() => {
    if (initialRequests !== null) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/support/requests?limit=25", {
          headers: { "Content-Type": "application/json" },
        });
        if (!response.ok) {
          if (!cancelled) {
            setRecentRequests([]);
            setRequestsError(true);
          }
          return;
        }
        const payload = (await response.json()) as { items?: SupportRequestRow[] };
        if (!cancelled) {
          setRecentRequests(payload.items ?? []);
          setRequestsError(false);
        }
      } catch {
        if (!cancelled) {
          setRecentRequests([]);
          setRequestsError(true);
        }
      } finally {
        if (!cancelled) setIsLoadingRequests(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // Mount only: the server's list is the page's starting state, never re-read when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* -------- Restore draft from localStorage on first mount -------- */
  useEffect(() => {
    if (draftRestoredRef.current) return;
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(LEGACY_SUPPORT_DRAFT_KEY);
      const raw = draftKey ? window.localStorage.getItem(draftKey) : null;
      if (!raw) {
        draftRestoredRef.current = true;
        return;
      }
      const draft = JSON.parse(raw) as {
        category?: string;
        description?: string;
        subcategory?: string;
        subject?: string;
      };
      // Hydration-safe restore: localStorage can only be read after mount
      // on the client. The setState calls here are intentional and bounded
      // to a single post-mount effect (draftRestoredRef ensures it runs
      // only once). See React docs: "Restoring state on first render".
      /* eslint-disable react-hooks/set-state-in-effect */
      if (draft.category) setCategory(draft.category);
      if (draft.subcategory) setSubcategory(draft.subcategory);
      if (draft.subject) setSubject(draft.subject);
      if (draft.description) setDescription(draft.description);
      /* eslint-enable react-hooks/set-state-in-effect */
    } catch {
      // ignore corrupt draft
    } finally {
      draftRestoredRef.current = true;
    }
  }, [draftKey]);

  /* -------- Persist draft to localStorage (lightweight debounce via render) -------- */
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!draftRestoredRef.current || !draftKey) return;
    const hasAnything = category || subcategory || subject || description;
    try {
      if (hasAnything) {
        window.localStorage.setItem(
          draftKey,
          JSON.stringify({ category, description, subcategory, subject }),
        );
      } else {
        window.localStorage.removeItem(draftKey);
      }
    } catch {
      // storage full / disabled - silently ignore
    }
  }, [category, subcategory, subject, description, draftKey]);

  useEffect(() => {
    return () => {
      if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
    };
  }, []);

  /* Derived state: clear subcategory in the category change handler rather
   * than inside a useEffect (avoids the react-hooks/set-state-in-effect
   * lint rule + a cascading render). See handleCategoryChange below. */
  const handleCategoryChange = (next: string) => {
    setCategory(next);
    if (next !== "HR Request" && subcategory) {
      setSubcategory("");
    }
  };

  const handleFilesAdded = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const incoming = Array.from(files);
    setAttachments((existing) => {
      const seen = new Set(existing.map((f) => `${f.name}:${f.size}`));
      const merged = [...existing];
      for (const file of incoming) {
        const key = `${file.name}:${file.size}`;
        if (!seen.has(key) && file.size <= 10 * 1024 * 1024) {
          merged.push(file);
          seen.add(key);
        }
      }
      return merged.slice(0, 10);
    });
  };

  const removeAttachment = (name: string, size: number) => {
    setAttachments((existing) =>
      existing.filter((f) => !(f.name === name && f.size === size)),
    );
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatRequestDate = (iso: string) => {
    if (!iso) return "-";
    try {
      return stableEnGbFormatter({
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: PHOENIX_BUSINESS_TIME_ZONE,
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    setAlertNotDelivered(false);
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/support/requests", {
        body: JSON.stringify({
          attachments: attachments.map((f) => ({
            name: f.name,
            size: f.size,
            type: f.type,
          })),
          category,
          description,
          employeeName,
          subcategory: subcategory || null,
          subject,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        item?: SupportRequestRow;
        message?: string;
        notification?: { recipientCount?: number };
      };
      if (!response.ok) {
        throw new Error(
          payload.message ?? "We couldn't submit your request. Try again.",
        );
      }
      if (payload.item) {
        setRecentRequests((prev) => [payload.item as SupportRequestRow, ...prev]);
      }
      // The request is saved either way; say so plainly when no one could be alerted, rather
      // than letting the rep believe HR already has it in front of them.
      setAlertNotDelivered(payload.notification?.recipientCount === 0);
      setShowSuccess(true);
      setCategory("");
      setSubcategory("");
      setSubject("");
      setDescription("");
      setAttachments([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (typeof window !== "undefined" && draftKey) {
        try {
          window.localStorage.removeItem(draftKey);
        } catch {
          // ignore
        }
      }
      successTimeoutRef.current = setTimeout(() => setShowSuccess(false), 6000);
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : "We couldn't submit your request. Try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const openCount = recentRequests.filter((request) => request.status === "Pending" || request.status === "In Progress").length;
  const resolvedCount = recentRequests.filter((request) => request.status === "Resolved" || request.status === "Closed").length;
  const lastTicket = recentRequests[0] ?? null;
  const descriptionCount = description.length;
  const descriptionOverSoftLimit = descriptionCount > DESCRIPTION_SOFT_LIMIT;

  const inputClass  = phxFieldClassName;
  const labelClass = "text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500";

  return (
    <div className="space-y-5" dir="auto">
      {/* ---- The rep's own tickets, in numbers (every panel prints a measurement) ---- */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <PortalMetricCard
          accent="sky"
          icon={Clock}
          label="Open"
          note="Waiting for HR or in progress"
          value={isLoadingRequests || requestsError ? "—" : openCount}
        />
        <PortalMetricCard
          accent="emerald"
          icon={CheckCircle2}
          label="Resolved"
          note="Answered and closed"
          value={isLoadingRequests || requestsError ? "—" : resolvedCount}
        />
        <PortalMetricCard
          accent="orange"
          icon={Send}
          label="Sent"
          note="Your requests on record"
          value={isLoadingRequests || requestsError ? "—" : recentRequests.length}
        />
        <PortalMetricCard
          accent="slate"
          icon={CalendarClock}
          label="Last sent"
          note={lastTicket ? lastTicket.status : "No request yet"}
          value={
            <span className="text-base leading-tight">
              {lastTicket ? formatRequestDate(lastTicket.createdAt) : "—"}
            </span>
          }
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        {/* ---- Request Form ---- */}
        <PortalSection
          description="Tell HR what you need. Your draft is kept on this device until you send it."
          eyebrow="New request"
          title="Request Support"
        >
          <form
            aria-busy={isSubmitting}
            className="space-y-4 px-4 py-4 sm:px-5 sm:py-5"
            onSubmit={handleSubmit}
          >
            {showSuccess && (
              <div
                aria-live="polite"
                className="flex items-start gap-2 border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-phx-sm font-semibold text-emerald-800"
                role="status"
              >
                <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0 break-words">
                  Request submitted successfully.
                  {alertNotDelivered
                    ? " HR could not be alerted automatically, but your request is saved and waiting in their queue."
                    : " HR has been alerted and you can follow it below."}
                </span>
              </div>
            )}
            {submitError && (
              <div
                aria-live="polite"
                className="border border-rose-200 bg-rose-50 px-3 py-2.5 text-phx-sm font-semibold text-rose-700"
                role="status"
              >
                <span className="break-words">{submitError}</span>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className={`mb-1.5 block ${labelClass}`}>Category</span>
                <SearchableSelect
                  aria-label="Support category"
                  className={inputClass}
                  onChange={(e) => handleCategoryChange(e.target.value)}
                  required
                  value={category}
                >
                  <option value="">Select a category</option>
                  <option value="Payslip & Earnings">Payslip & Earnings</option>
                  <option value="System Issue">System Issue</option>
                  <option value="HR Request">HR Request</option>
                  <option value="Other">Other</option>
                </SearchableSelect>
              </label>

              {/* Conditional sub-category - only when "HR Request" is selected */}
              {category === "HR Request" ? (
                <label className="block">
                  <span className={`mb-1.5 block ${labelClass}`}>
                    HR Request type
                  </span>
                  <SearchableSelect
                    aria-label="HR request subcategory"
                    className={inputClass}
                    onChange={(e) => setSubcategory(e.target.value)}
                    required
                    value={subcategory}
                  >
                    <option value="">Select an HR request type</option>
                    {hrRequestSubcategories.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </SearchableSelect>
                </label>
              ) : null}
            </div>

            <label className="block">
              <span className={`mb-1.5 block ${labelClass}`}>Subject</span>
              <input
                aria-label="Support subject"
                className={inputClass}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Enter a short subject"
                required
                value={subject}
              />
            </label>

            <label className="block">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className={labelClass}>Description</span>
                <span
                  aria-live="polite"
                  className={`text-phx-2xs font-semibold tabular-nums ${
                    descriptionOverSoftLimit ? "text-rose-600" : "text-slate-400"
                  }`}
                >
                  {descriptionCount} / {DESCRIPTION_SOFT_LIMIT}
                </span>
              </div>
              <textarea
                aria-label="Support description"
                className={`${phxTextareaClassName} ${descriptionOverSoftLimit ? phxFieldInvalidClassName : ""}`}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe your issue or request in detail..."
                required
                rows={5}
                value={description}
              />
              {descriptionOverSoftLimit && (
                <p className="mt-1 text-phx-2xs font-semibold text-rose-600">
                  Tip: keep the description under {DESCRIPTION_SOFT_LIMIT} characters
                  so it&apos;s easier to triage.
                </p>
              )}
            </label>

            <div>
              <span className={`mb-1.5 block ${labelClass}`}>
                Attachments (optional)
              </span>
              <input
                accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                aria-label="Attachments"
                className="sr-only"
                multiple
                onChange={(e) => handleFilesAdded(e.target.files)}
                ref={fileInputRef}
                type="file"
              />
              <button
                aria-label="Choose files to attach"
                className="flex min-h-16 w-full cursor-pointer flex-col items-center justify-center border border-dashed border-slate-300 bg-slate-50/40 px-3 py-3 text-center transition hover:border-orange-300 hover:bg-slate-50/80"
                onClick={() => fileInputRef.current?.click()}
                type="button"
              >
                <Upload className="mb-1 h-4 w-4 text-slate-400" />
                <p className="text-phx-xs font-semibold text-slate-600">
                  Tap to choose files
                </p>
                <p className="text-phx-2xs text-slate-400">
                  Max 10 MB each &middot; up to 10 files &middot; PDF, PNG, JPG
                </p>
              </button>
              {attachments.length > 0 && (
                <ul className="mt-2 grid gap-1.5">
                  {attachments.map((file) => (
                    <li
                      className="flex min-w-0 items-center gap-2 border border-orange-200 bg-orange-50 py-1 pl-2.5 pr-1 text-phx-xs font-medium text-orange-800"
                      key={`${file.name}-${file.size}`}
                    >
                      {/* A phone camera's file name is one unbroken token; it breaks anywhere
                          rather than pushing the row past the card. */}
                      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                        {file.name}
                      </span>
                      <span className="shrink-0 text-phx-2xs tabular-nums text-orange-600">
                        {formatFileSize(file.size)}
                      </span>
                      <button
                        aria-label={`Remove ${file.name}`}
                        className="inline-flex h-9 w-9 shrink-0 items-center justify-center text-orange-500 transition hover:bg-orange-100 hover:text-orange-700"
                        onClick={() => removeAttachment(file.name, file.size)}
                        type="button"
                      >
                        <X aria-hidden className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <Button
              aria-label="Submit support request"
              className="h-11 w-full text-sm font-semibold"
              disabled={isSubmitting}
              type="submit"
            >
              {isSubmitting ? (
                "Submitting..."
              ) : (
                <>
                  <Send className="mr-2 h-4 w-4" />
                  Submit Request
                </>
              )}
            </Button>
          </form>
        </PortalSection>

        {/* ---- What happens next (replaces the placeholder "desks") ---- */}
        <PortalSection eyebrow="How it works" title="What happens next">
          <ol className="divide-y divide-slate-100">
            {[
              {
                body: "Pick a category and describe what you need. Attach a document or a screenshot if it helps.",
                title: "You send the request",
              },
              {
                body: "HR is alerted the moment it is saved, in the app, by email and on Telegram.",
                title: "HR picks it up",
              },
              {
                body: "Its status changes here from Pending to In Progress, then Resolved. Check back any time.",
                title: "You follow it here",
              },
            ].map((step, index) => (
              <li className="flex gap-3 px-4 py-3.5 sm:px-5" key={step.title}>
                <span
                  aria-hidden
                  className="flex h-8 w-8 shrink-0 items-center justify-center bg-slate-900 text-phx-sm font-black tabular-nums text-orange-300"
                >
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-phx-md font-bold text-slate-900">{step.title}</p>
                  <p className="mt-0.5 break-words text-phx-sm leading-relaxed text-slate-500">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-3 text-phx-xs font-semibold text-slate-500 sm:px-5">
            For anything urgent, still send it here, so the request is tracked and nothing is lost.
          </div>
        </PortalSection>
      </div>

      {/* ---- Recent Requests ---- */}
      <PortalSection
        actions={
          recentRequests.length > 0 ? (
            <span className="bg-slate-900 px-2.5 py-1 text-phx-xs font-bold uppercase tracking-wide text-slate-100 tabular-nums">
              {recentRequests.length} {recentRequests.length === 1 ? "request" : "requests"}
            </span>
          ) : null
        }
        description="Track your support history"
        eyebrow="History"
        title="Recent Requests"
      >
        {isLoadingRequests ? (
          <div className="space-y-2 px-4 py-4 sm:px-5" aria-busy="true">
            <span className="sr-only">Loading...</span>
            <PortalSkeleton className="h-12 w-full" />
            <PortalSkeleton className="h-12 w-full" />
          </div>
        ) : requestsError ? (
          // Says what happened, and does NOT claim the history is empty — see requestsError above.
          <PortalEmptyState
            message="Your requests could not be loaded just now. They have not been lost — reload the page to try again."
            title="Could not load your requests"
          />
        ) : recentRequests.length === 0 ? (
          <PortalEmptyState
            message="Your support history will appear here after your first request."
            title="No recent requests"
          />
        ) : (
          <>
            {/* Tablet and desktop: fixed layout and a colgroup — fits its column at every width,
                with no sideways scroll (the fits-the-screen rule). No raw request ID: a rep
                recognises a request by its subject and date. */}
            <div className="hidden md:block">
              <table className="w-full table-fixed text-left text-phx-md">
                <colgroup>
                  <col className="w-[44%]" />
                  <col className="w-[22%]" />
                  <col className="w-[14%]" />
                  <col className="w-[20%]" />
                </colgroup>
                <thead>
                  <tr>
                    <th className="px-3 py-2.5">Subject</th>
                    <th className="px-3 py-2.5">Category</th>
                    <th className="px-3 py-2.5">Status</th>
                    <th className="px-3 py-2.5">Sent</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {recentRequests.map((request) => (
                    <tr className="align-top transition hover:bg-orange-50/30" key={request.id}>
                      <td className="px-3 py-2.5">
                        <p className="break-words font-semibold text-slate-900">{request.subject}</p>
                        {request.description ? (
                          <p className="mt-0.5 whitespace-pre-line break-words text-phx-sm leading-relaxed text-slate-500">
                            {request.description}
                          </p>
                        ) : null}
                      </td>
                      <td className="break-words px-3 py-2.5 text-slate-600">
                        {request.category}
                        {request.subcategory ? (
                          <span className="block text-phx-sm text-slate-400">{request.subcategory}</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5">
                        <SupportStatusChip status={request.status} />
                      </td>
                      <td className="px-3 py-2.5 tabular-nums text-slate-600">
                        {formatRequestDate(request.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Phone: one card per request. */}
            <div className="divide-y divide-slate-100 md:hidden">
              {recentRequests.map((request) => (
                <PortalRecordCard
                  accent={supportStatusAccent(request.status)}
                  key={request.id}
                  meta={`${request.category}${request.subcategory ? ` · ${request.subcategory}` : ""} · ${formatRequestDate(request.createdAt)}`}
                  status={<SupportStatusChip status={request.status} />}
                  title={request.subject}
                >
                  {request.description ? (
                    <p className="whitespace-pre-line break-words text-phx-sm leading-relaxed text-slate-600">
                      {request.description}
                    </p>
                  ) : null}
                  {request.attachments.length > 0 ? (
                    <p className="mt-1.5 text-phx-2xs font-bold uppercase tracking-wider text-slate-400">
                      {request.attachments.length} attachment{request.attachments.length === 1 ? "" : "s"}
                    </p>
                  ) : null}
                </PortalRecordCard>
              ))}
            </div>
          </>
        )}
      </PortalSection>
    </div>
  );
}

function supportStatusAccent(status: string): "sky" | "amber" | "emerald" | "slate" {
  if (status === "Pending") return "sky";
  if (status === "In Progress") return "amber";
  if (status === "Resolved") return "emerald";
  return "slate";
}

function SupportStatusChip({ status }: { status: string }) {
  const tone =
    status === "In Progress"
      ? "border-amber-200 bg-amber-50 text-amber-700"
      : status === "Resolved"
        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
        : status === "Pending"
          ? "border-sky-200 bg-sky-50 text-sky-700"
          : "border-slate-200 bg-slate-100 text-slate-600";
  return (
    <span className={`inline-flex whitespace-nowrap border px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wider ${tone}`}>
      {status}
    </span>
  );
}
