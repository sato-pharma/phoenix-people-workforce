"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  MessageSquare,
  Search,
  Send,
  XCircle,
} from "lucide-react";

import { PicturePicker, PictureStrip } from "@/components/deductions/dispute-pictures";
import { DisputeDecisionPanel } from "@/components/disputes/dispute-decision-panel";
import type { DisputeCase } from "@/lib/dispute-center/types.ts";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key.ts";
import { deductionsCategoryLabel } from "@/lib/deductions/calculations.ts";
import { disputeDateLabel } from "@/lib/deductions/dispute-basis.ts";
import type {
  AdminDeductionCommentThread,
  DeductionDisputeBasis,
  DeductionDisputeDelivery,
  DeductionsComment,
} from "@/lib/deductions/types.ts";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";
import {
  phxButtonAccentClassName,
  phxFieldClassName,
  phxHintClassName,
  phxLabelClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

/**
 * The Disputes inbox — every employee comment on a deduction that is still on a payslip, and
 * everything the person answering needs to answer it WITHOUT leaving the page (owner, 2026-10-08:
 * "make me see in the window why was this deduction made so I can [decide] without going to another
 * screen — in very much detail").
 *
 * Each dispute is one card with two halves. The left half is the case file: what raised the
 * deduction, the days, the arithmetic, the evidence the check recorded and the decision that put it
 * on the payslip. The right half is the conversation and the reply box, with the To and CC shown
 * BEFORE the button is pressed and a recap of what was sent after it (owner, 2026-10-08: a reply
 * reaches the employee in the portal and by email, Telegram and in-app, with their managers copied).
 *
 * It exists because a deduction comment mails HR a link, and before this tab that link landed on the
 * current-month collection workspace where no comment is ever shown (owner, 2026-10-06). It is
 * month-independent: a notification deep-links to one with `?tab=disputes&candidate=<id>`, which
 * opens that dispute and scrolls it into view. Replying is Super Admin only (owner, 2026-10-06 —
 * "keep replies super-admin only"); the CEO and HR Operations read a dispute here and cannot answer.
 *
 * The layout rules apply: no horizontal scroll at any width, square edges, names and never codes,
 * nothing truncated. The two halves sit side by side only when the CARD is wide enough
 * (`@container` + `@min-[…]`), not when the viewport is — the tab can live in a narrow column.
 */

type ReplyNotice = { tone: "success" | "error"; text: string };
type Filter = "waiting" | "answered" | "all";

const REPLY_LIMIT = 2000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.error || payload?.message || `Request failed (${response.status})`);
  }
  return payload as T;
}

function formatMoney(value: number): string {
  return stableCurrencyFormatter("en-EG", {
    currency: "EGP",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

// DATE-ONLY (a "YYYY-MM" period key off a synthetic Date.UTC). UTC is CORRECT here and must stay.
function monthLabel(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  if (!year || !month) return monthKey;
  return new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC", year: "numeric" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

/** "2026-09-07" -> "Mon 7 Sept". Date-only, so read off the string and never through a zone. */
function dayChipLabel(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const weekday = WEEKDAYS[new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()];
  const label = disputeDateLabel(iso).replace(/ \d{4}$/, "");
  return `${weekday} ${label}`;
}

function formatDays(value: number): string {
  const text = Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  return `${text} ${value === 1 ? "day" : "days"}`;
}

function payrollColumnLabel(column: string): string {
  if (column === "crm") return "CRM";
  if (column === "finger_print") return "Fingerprint";
  if (column === "loans") return "Loan";
  if (column === "other_deductions") return "Other";
  if (column === "unpaid_vacations") return "Unpaid vacation";
  return column;
}

/** Who wrote a line: the deduction's own employee, or the HR person who replied. */
function commentAuthor(
  comment: AdminDeductionCommentThread["comments"][number],
  line: AdminDeductionCommentThread["line"],
): { name: string; isEmployee: boolean } {
  const isEmployee = Boolean(
    line && comment.authorHrId && compactDeductionsHrId(comment.authorHrId) === line.employeeHrIdCompact,
  );
  const name = isEmployee ? line?.employeeName ?? comment.authorName ?? "Employee" : comment.authorName ?? "HR";
  return { isEmployee, name };
}

/** A dispute is WAITING when the newest line came from the employee's side — nobody answered since. */
function isWaiting(thread: AdminDeductionCommentThread): boolean {
  const newest = thread.comments[0];
  if (!newest) return false;
  return commentAuthor(newest, thread.line).isEmployee;
}

function wholeDaysSince(iso: string | null | undefined): number {
  if (!iso) return 0;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

const chipBase = "inline-flex items-center border px-2 py-0.5 text-phx-xs font-black uppercase tracking-[0.08em]";

function Chip({ tone, children }: { tone: "amber" | "emerald" | "slate" | "orange" | "rose"; children: ReactNode }) {
  const tones = {
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
    orange: "border-orange-200 bg-orange-50 text-orange-700",
    rose: "border-rose-200 bg-rose-50 text-rose-700",
    slate: "border-slate-200 bg-slate-50 text-slate-600",
  } as const;
  return <span className={cn(chipBase, tones[tone])}>{children}</span>;
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">{children}</p>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-slate-100 px-4 py-3 first:border-t-0">
      <SectionLabel>{title}</SectionLabel>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function FactGrid({ rows }: { rows: Array<{ label: string; value: string }> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 @min-[460px]:grid-cols-2">
      {rows.map((row) => (
        <div className="min-w-0" key={row.label}>
          <dt className="text-phx-xs font-bold text-slate-400">{row.label}</dt>
          <dd className="break-words text-sm font-semibold text-slate-800">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DecisionChip({ status }: { status: string }) {
  if (status === "Approved for Payroll") return <Chip tone="emerald">{status}</Chip>;
  if (status === "Do Not Take Action") return <Chip tone="slate">{status}</Chip>;
  if (status === "Pending" || status === "Needs Follow-up" || status === "Disputed") return <Chip tone="amber">{status}</Chip>;
  return <Chip tone="slate">{status}</Chip>;
}

/** The case file: why the deduction exists, in words, with the arithmetic and the evidence. */
function CaseFile({ basis, thread }: { basis: DeductionDisputeBasis | null | undefined; thread: AdminDeductionCommentThread }) {
  const line = thread.line;
  if (!line) return null;

  if (!basis) {
    return (
      <div className="border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-600">
        The detail behind this deduction could not be loaded. The conversation is unaffected.
      </div>
    );
  }

  const cleared = basis.decision?.appliedDates ?? null;
  const days = basis.detectedDates;
  const estimateDiffers =
    basis.estimatedAmount !== null && Math.abs(basis.estimatedAmount - basis.chargedAmount) > 0.005;

  return (
    <div className="border border-slate-200 bg-white">
      <Section title="What was found">
        <p className="break-words text-sm font-semibold leading-relaxed text-slate-900">
          {basis.reason ?? "No reason was recorded with this deduction."}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Chip tone="slate">{basis.detectedBy}</Chip>
          {basis.severity ? <Chip tone={basis.severity === "High" ? "rose" : "amber"}>{basis.severity} severity</Chip> : null}
          {basis.needsReview ? <Chip tone="amber">Was flagged for review</Chip> : null}
        </div>
        <p className="mt-2 break-words text-xs leading-relaxed text-slate-600">{basis.explanation}</p>
      </Section>

      {days.length > 0 ? (
        <Section title={`The ${days.length === 1 ? "day" : "days"} in question`}>
          <ul className="flex flex-wrap gap-1.5">
            {days.map((day) => {
              const charged = cleared === null || cleared.includes(day);
              return (
                <li
                  className={cn(
                    "border px-2 py-1 text-xs font-bold",
                    charged ? "border-slate-300 bg-white text-slate-800" : "border-slate-200 bg-slate-50 text-slate-400 line-through",
                  )}
                  key={day}
                >
                  {dayChipLabel(day)}
                </li>
              );
            })}
          </ul>
          {cleared !== null && cleared.length < days.length ? (
            <p className="mt-2 text-xs font-semibold text-slate-500">
              Struck-through days were cleared by HR and are not charged.
            </p>
          ) : null}
        </Section>
      ) : null}

      <Section title="How the amount is worked out">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 @min-[460px]:grid-cols-4">
          <div className="min-w-0">
            <dt className="text-phx-xs font-bold text-slate-400">Found</dt>
            <dd className="text-sm font-black text-slate-900">
              {basis.unit === "days" ? formatDays(basis.detectedValue) : formatMoney(basis.detectedValue)}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-phx-xs font-bold text-slate-400">{basis.ratePerUnit !== null ? "Rate per day" : "Rate"}</dt>
            <dd className="text-sm font-black text-slate-900">
              {basis.ratePerUnit !== null ? formatMoney(basis.ratePerUnit) : "Not per day"}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-phx-xs font-bold text-slate-400">Calculated</dt>
            <dd className="text-sm font-black text-slate-900">
              {basis.estimatedAmount !== null ? formatMoney(basis.estimatedAmount) : "Not calculated"}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-phx-xs font-bold text-slate-400">On the payslip</dt>
            <dd className="text-sm font-black text-orange-600">{formatMoney(basis.chargedAmount)}</dd>
          </div>
        </dl>
        {basis.rateBasis ? <p className="mt-2 break-words text-xs text-slate-500">Rate: {basis.rateBasis}.</p> : null}
        {estimateDiffers ? (
          <p className="mt-1 text-xs font-semibold text-amber-700">
            HR changed the amount: it was calculated as {formatMoney(basis.estimatedAmount ?? 0)} and is charged as{" "}
            {formatMoney(basis.chargedAmount)}.
          </p>
        ) : null}
      </Section>

      {basis.facts.length > 0 ? (
        <Section title="Evidence the check recorded">
          <FactGrid rows={basis.facts} />
        </Section>
      ) : null}

      <Section title="The decision on record">
        {basis.decision ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <DecisionChip status={basis.decision.status} />
              {basis.decision.decidedByName ? (
                <span className="text-xs font-semibold text-slate-600">
                  by {basis.decision.decidedByName}
                  {basis.decision.decidedAt ? `, ${cairoDateTime(basis.decision.decidedAt)}` : ""}
                </span>
              ) : null}
            </div>
            {basis.decision.reason ? (
              <p className="break-words text-sm text-slate-700">
                <span className="font-bold text-slate-500">Reason: </span>
                {basis.decision.reason}
              </p>
            ) : null}
            {basis.decision.hrNote ? (
              <p className="break-words text-sm text-slate-700">
                <span className="font-bold text-slate-500">HR note: </span>
                {basis.decision.hrNote}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm font-semibold text-slate-500">No decision is recorded against this deduction.</p>
        )}
        {/* A deduction disputed before it was pushed has no publish time to quote (owner, 2026-11-13). */}
        {basis.pushedAt || line.id ? (
          <p className="mt-2 break-words text-xs font-semibold text-slate-500">
            Published to the employee {cairoDateTime(basis.pushedAt ?? basis.publishedAt)}
            {basis.pushedByName ? ` by ${basis.pushedByName}` : ""}.
          </p>
        ) : (
          <p className="mt-2 break-words text-xs font-semibold text-slate-500">
            Not pushed to the payslip yet — the employee disputed it before it was released.
          </p>
        )}
      </Section>
    </div>
  );
}

function ChannelRecap({ delivery }: { delivery: DeductionDisputeDelivery }) {
  const toChannels = delivery.to.telegramLinked ? "portal, email, in-app, push and Telegram" : "portal, email, in-app and push";
  return (
    <div className="mt-3 border border-emerald-200 bg-emerald-50 px-3 py-2.5" role="status">
      <p className="flex items-center gap-1.5 text-sm font-black text-emerald-800">
        <CheckCircle2 aria-hidden className="h-4 w-4 shrink-0" />
        Reply sent
      </p>
      <ul className="mt-1.5 space-y-1 text-xs font-semibold text-emerald-900">
        <li className="break-words">
          To {delivery.to.name}: {toChannels}.
          {delivery.to.telegramLinked ? "" : " Telegram is not linked, so nothing goes there."}
        </li>
        {delivery.cc
          .filter((person) => person.relation === "manager")
          .map((person) => (
            <li className="break-words" key={person.name}>
              Copied to {person.name}
              {person.title ? ` (${person.title})` : ""}: email copy, in-app and push
              {person.telegramLinked ? " and Telegram." : ". Telegram is not linked."}
            </li>
          ))}
        {delivery.cc
          .filter((person) => person.relation === "sender")
          .map((person) => (
            <li className="break-words" key={person.name}>
              A copy of the email is in your own inbox.
            </li>
          ))}
      </ul>
    </div>
  );
}

function AudienceLine({ thread }: { thread: AdminDeductionCommentThread }) {
  const audience = thread.replyAudience;
  if (!audience) {
    return <p className={phxHintClassName}>The reply goes to the employee&rsquo;s portal and is emailed to them.</p>;
  }
  return (
    <div className="mt-2 space-y-1 text-xs font-semibold text-slate-600">
      <p className="break-words">
        <span className="font-black uppercase tracking-[0.08em] text-slate-400">To </span>
        {audience.to.name}
        <span className="text-slate-400"> · portal, email, in-app, push, Telegram if linked</span>
      </p>
      <p className="break-words">
        <span className="font-black uppercase tracking-[0.08em] text-slate-400">CC </span>
        {audience.managers.length > 0
          ? audience.managers.map((manager) => (manager.title ? `${manager.name} (${manager.title})` : manager.name)).join(", ")
          : "No active manager on record"}
        <span className="text-slate-400"> · and a copy to you</span>
      </p>
    </div>
  );
}

/**
 * THE DECISION, ON THE CARD (owner, 2026-11-07: "in deduction disputes I want to be able to approve or
 * reject the dispute … today I do not have the option except reply"). The tab only ever had the reply
 * box; the decision lived in the Dispute Center alone. This is that same panel, fed by that same case
 * and posting to that same route — accept, reduce, reject, and the reopen — so the rule about what the
 * money becomes (withdraw a pushed line first, refund a paid month through Other Additions) stays in
 * ONE place, `src/lib/dispute-center/deduction.ts`. Nothing is decided in the browser.
 */
function CaseDecision({ candidateId, onDecided }: { candidateId: string; onDecided: () => void }) {
  const [dispute, setDispute] = useState<DisputeCase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchJson<{ case: DisputeCase }>(`/api/dispute-center/cases/deduction/${encodeURIComponent(candidateId)}`)
      .then((payload) => {
        if (cancelled) return;
        setError(null);
        setDispute(payload.case);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "The decision could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [candidateId, version]);

  if (error) {
    return (
      <p className="mt-4 border-t border-slate-200 pt-3 text-xs font-semibold text-rose-700" role="alert">
        {error}
      </p>
    );
  }
  if (!dispute) {
    return <p className="mt-4 border-t border-slate-200 pt-3 text-xs font-semibold text-slate-500">Loading the decision</p>;
  }
  if (!dispute.viewer.isReviewer) return null;
  return (
    <div className="mt-4 border-t border-slate-200 pt-4">
      <DisputeDecisionPanel
        dispute={dispute}
        onDone={() => {
          setVersion((current) => current + 1);
          onDecided();
        }}
      />
    </div>
  );
}

export function DisputesTab({ canReply, highlightCandidateId }: { canReply: boolean; highlightCandidateId?: string }) {
  const [threads, setThreads] = useState<AdminDeductionCommentThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pictures, setPictures] = useState<Record<string, File[]>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Record<string, ReplyNotice>>({});
  const [delivered, setDelivered] = useState<Record<string, DeductionDisputeDelivery>>({});
  const [withdrawn, setWithdrawn] = useState<Record<string, boolean>>({});
  const highlightRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setThreads(null);
    setError(null);
    fetchJson<{ threads: AdminDeductionCommentThread[] }>("/api/admin/deductions/comments")
      .then((payload) => {
        if (!cancelled) setThreads(payload.threads ?? []);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load disputes.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // After a decision the list is read again in place, without blanking the screen. An ACCEPTED
  // dispute's line is withdrawn, so the list no longer carries it — its card stays where it is, marked
  // as off the payslip, so the sentence the decision returned is still there to read.
  async function refreshAfterDecision(candidateId: string) {
    try {
      const payload = await fetchJson<{ threads: AdminDeductionCommentThread[] }>("/api/admin/deductions/comments");
      const fresh = payload.threads ?? [];
      const freshIds = new Set(fresh.map((thread) => thread.candidateId));
      const kept = (threads ?? []).filter(
        (thread) => !freshIds.has(thread.candidateId) && (thread.candidateId === candidateId || withdrawn[thread.candidateId]),
      );
      setWithdrawn(Object.fromEntries(kept.map((thread) => [thread.candidateId, true])));
      setThreads([...fresh, ...kept]);
    } catch {
      // The decision itself saved and said so in its own panel; a failed re-read leaves the list as it was.
    }
  }

  // Once the threads are in and the deep-linked one is on screen, bring it into view.
  useEffect(() => {
    if (!highlightCandidateId || !threads) return;
    highlightRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightCandidateId, threads]);

  const counts = useMemo(() => {
    const list = threads ?? [];
    const waiting = list.filter(isWaiting);
    return {
      all: list.length,
      answered: list.length - waiting.length,
      contested: waiting.reduce((sum, thread) => sum + (thread.line?.appliedAmount ?? 0), 0),
      longestWait: waiting.reduce((max, thread) => Math.max(max, wholeDaysSince(thread.latestCommentAt)), 0),
      waiting: waiting.length,
    };
  }, [threads]);

  // The default view is the work: what is waiting. A deep link opens on everything, so the one it
  // names is always on screen even when it was answered in the meantime.
  const activeFilter: Filter = filter ?? (highlightCandidateId ? "all" : counts.waiting > 0 ? "waiting" : "all");

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (threads ?? []).filter((thread) => {
      if (activeFilter === "waiting" && !isWaiting(thread)) return false;
      if (activeFilter === "answered" && isWaiting(thread)) return false;
      if (!needle) return true;
      return String(thread.line?.employeeName ?? "").toLowerCase().includes(needle);
    });
  }, [threads, activeFilter, query]);

  async function submitReply(candidateId: string) {
    const body = String(drafts[candidateId] ?? "").trim();
    const attached = pictures[candidateId] ?? [];
    if (!body && attached.length === 0) {
      setNotice((current) => ({ ...current, [candidateId]: { text: "Write a reply or add a picture first.", tone: "error" } }));
      return;
    }
    setSavingId(candidateId);
    setNotice((current) => {
      const next = { ...current };
      delete next[candidateId];
      return next;
    });
    try {
      const payload = await fetchJson<{ comment: DeductionsComment; delivery: DeductionDisputeDelivery | null }>(
        "/api/admin/deductions/comments",
        attached.length > 0
          ? {
              // Pictures go as multipart; the browser sets the boundary, so no Content-Type here.
              body: (() => {
                const form = new FormData();
                form.append("candidateId", candidateId);
                form.append("body", body);
                for (const file of attached) form.append("images", file, file.name);
                return form;
              })(),
              method: "POST",
            }
          : {
              body: JSON.stringify({ body, candidateId }),
              headers: { "Content-Type": "application/json" },
              method: "POST",
            },
      );
      // Append the reply in place, so the conversation updates without a reload.
      setThreads((current) =>
        (current ?? []).map((thread) =>
          thread.candidateId === candidateId
            ? { ...thread, comments: [payload.comment, ...thread.comments], latestCommentAt: payload.comment.createdAt }
            : thread,
        ),
      );
      setDrafts((current) => ({ ...current, [candidateId]: "" }));
      setPictures((current) => ({ ...current, [candidateId]: [] }));
      if (payload.delivery) {
        const delivery = payload.delivery;
        setDelivered((current) => ({ ...current, [candidateId]: delivery }));
      } else {
        setNotice((current) => ({
          ...current,
          [candidateId]: {
            text: "Reply saved and shown to the employee. The notices could not be confirmed, so check the employee received them.",
            tone: "success",
          },
        }));
      }
    } catch (caught) {
      setNotice((current) => ({
        ...current,
        [candidateId]: { text: caught instanceof Error ? caught.message : "Reply could not be sent.", tone: "error" },
      }));
    } finally {
      setSavingId(null);
    }
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
        <XCircle aria-hidden className="h-4 w-4 shrink-0" />
        {error}
      </div>
    );
  }

  if (!threads) {
    return <p className="px-1 py-6 text-sm font-semibold text-slate-500">Loading disputes</p>;
  }

  if (threads.length === 0) {
    return (
      <div className="border border-slate-200 bg-white px-4 py-10 text-center">
        <MessageSquare aria-hidden className="mx-auto h-8 w-8 text-slate-300" />
        <p className="mt-3 text-sm font-black text-slate-900">No disputes</p>
        <p className="mx-auto mt-1 max-w-md text-sm font-semibold text-slate-500">
          When an employee comments on a deduction that is on their payslip, their message appears here with the
          full reason behind the deduction{canReply ? " and you can reply." : "."}
        </p>
      </div>
    );
  }

  const filterButtons: Array<{ key: Filter; label: string; count: number }> = [
    { count: counts.waiting, key: "waiting", label: "Waiting for reply" },
    { count: counts.answered, key: "answered", label: "Answered" },
    { count: counts.all, key: "all", label: "All" },
  ];

  return (
    <div className="@container space-y-4">
      <div className="@container border border-slate-200 bg-white">
        <dl className="grid grid-cols-2 divide-x divide-y divide-slate-100 @min-[640px]:grid-cols-4 @min-[640px]:divide-y-0">
          <div className="px-4 py-3">
            <dt className="text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">Waiting for reply</dt>
            <dd className={cn("mt-1 text-2xl font-black", counts.waiting > 0 ? "text-orange-600" : "text-slate-900")}>
              {counts.waiting}
            </dd>
          </div>
          <div className="px-4 py-3">
            <dt className="text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">Answered</dt>
            <dd className="mt-1 text-2xl font-black text-slate-900">{counts.answered}</dd>
          </div>
          <div className="px-4 py-3">
            <dt className="text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">Contested now</dt>
            <dd className="mt-1 break-words text-2xl font-black text-slate-900">{formatMoney(counts.contested)}</dd>
          </div>
          <div className="px-4 py-3">
            <dt className="text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">Longest wait</dt>
            <dd className="mt-1 text-2xl font-black text-slate-900">
              {counts.waiting > 0 ? (counts.longestWait === 0 ? "Today" : `${counts.longestWait} ${counts.longestWait === 1 ? "day" : "days"}`) : "None"}
            </dd>
          </div>
        </dl>
      </div>

      <div className="flex flex-col gap-3 @sm:flex-row @sm:items-center @sm:justify-between">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter disputes">
          {filterButtons.map((button) => (
            <button
              aria-pressed={activeFilter === button.key}
              className={cn(
                "inline-flex h-9 items-center gap-2 border px-3 text-phx-xs font-black uppercase tracking-[0.08em] transition",
                activeFilter === button.key
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-300 bg-white text-slate-600 hover:border-orange-500 hover:text-orange-600",
              )}
              key={button.key}
              onClick={() => setFilter(button.key)}
              type="button"
            >
              {button.label}
              <span className={activeFilter === button.key ? "text-orange-300" : "text-slate-400"}>{button.count}</span>
            </button>
          ))}
        </div>
        <label className="relative block w-full @sm:w-64">
          <span className="sr-only">Search by employee name</span>
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className={cn(phxFieldClassName, "pl-9")}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by employee name"
            type="search"
            value={query}
          />
        </label>
      </div>

      {visible.length === 0 ? (
        <div className="border border-slate-200 bg-white px-4 py-8 text-center">
          <p className="text-sm font-black text-slate-900">Nothing here</p>
          <p className="mt-1 text-sm font-semibold text-slate-500">No dispute matches this view.</p>
        </div>
      ) : null}

      {visible.map((thread) => {
        const line = thread.line;
        const isHighlighted = Boolean(highlightCandidateId && thread.candidateId === highlightCandidateId);
        const waiting = isWaiting(thread);
        const detailsHidden = hidden[thread.candidateId] === true;
        const draft = drafts[thread.candidateId] ?? "";
        const saving = savingId === thread.candidateId;
        const message = notice[thread.candidateId];
        const delivery = delivered[thread.candidateId];
        const conversation = [...thread.comments].reverse();
        const firstName = line?.employeeName ?? "the employee";

        return (
          <article
            className={cn(
              "@container border bg-white shadow-sm transition",
              isHighlighted ? "border-orange-400 ring-2 ring-orange-100" : "border-slate-200",
            )}
            key={thread.candidateId}
            ref={isHighlighted ? highlightRef : undefined}
          >
            <header className="flex flex-col gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 @min-[560px]:flex-row @min-[560px]:items-start @min-[560px]:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="break-words text-base font-black text-slate-950">{line?.employeeName ?? "Employee"}</h3>
                  {waiting ? (
                    <Chip tone="amber">
                      <Clock3 aria-hidden className="mr-1 h-3 w-3" />
                      Waiting for reply
                    </Chip>
                  ) : (
                    <Chip tone="emerald">
                      <CheckCircle2 aria-hidden className="mr-1 h-3 w-3" />
                      Answered
                    </Chip>
                  )}
                </div>
                {thread.replyAudience?.to.title ? (
                  <p className="mt-0.5 text-xs font-semibold text-slate-500">{thread.replyAudience.to.title}</p>
                ) : null}
                {line ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Chip tone="slate">{monthLabel(line.monthKey)}</Chip>
                    <Chip tone="slate">{deductionsCategoryLabel(line.deductionType)}</Chip>
                    <Chip tone="slate">Paid through {payrollColumnLabel(line.payrollColumn)}</Chip>
                  </div>
                ) : null}
              </div>
              <div className="flex items-end justify-between gap-3 @min-[560px]:flex-col @min-[560px]:items-end @min-[560px]:justify-start">
                <div className="text-left @min-[560px]:text-right">
                  <p className="text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">On the payslip</p>
                  <p className="text-xl font-black text-orange-600">
                    {thread.pending
                      ? "Not decided yet"
                      : line && !withdrawn[thread.candidateId]
                        ? formatMoney(line.appliedAmount)
                        : "Not charged"}
                  </p>
                  {thread.pending ? (
                    <p className="text-phx-xs font-semibold text-slate-500">Rejecting the dispute deducts it</p>
                  ) : null}
                </div>
                <button
                  aria-expanded={!detailsHidden}
                  className="inline-flex h-8 items-center gap-1.5 border border-slate-300 bg-white px-2.5 text-phx-xs font-black uppercase tracking-[0.08em] text-slate-600 transition hover:border-orange-500 hover:text-orange-600"
                  onClick={() => setHidden((current) => ({ ...current, [thread.candidateId]: !detailsHidden }))}
                  type="button"
                >
                  {detailsHidden ? <ChevronDown aria-hidden className="h-3.5 w-3.5" /> : <ChevronUp aria-hidden className="h-3.5 w-3.5" />}
                  {detailsHidden ? "Show the case" : "Hide the case"}
                </button>
              </div>
            </header>

            <div
              className={cn(
                "grid grid-cols-1 gap-4 p-4",
                detailsHidden ? "" : "@min-[900px]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]",
              )}
            >
              {detailsHidden ? null : (
                <div className="min-w-0">
                  <CaseFile basis={thread.basis} thread={thread} />
                </div>
              )}

              <div className="min-w-0">
                <SectionLabel>The conversation</SectionLabel>
                <ol className="mt-2 space-y-2">
                  {conversation.map((comment) => {
                    const author = commentAuthor(comment, line);
                    return (
                      <li
                        className={cn(
                          "border p-3",
                          author.isEmployee ? "border-slate-200 bg-slate-50" : "border-orange-200 bg-orange-50",
                        )}
                        key={comment.id}
                      >
                        <p className="flex flex-wrap items-baseline justify-between gap-x-3 text-phx-xs font-black uppercase tracking-[0.08em] text-slate-500">
                          <span className="break-words">
                            {author.name}
                            {author.isEmployee ? "" : " · HR"}
                          </span>
                          <span className="font-semibold normal-case tracking-normal text-slate-400">
                            {cairoDateTime(comment.createdAt)}
                          </span>
                        </p>
                        <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800" dir="auto">
                          {comment.body}
                        </p>
                        <PictureStrip attachments={comment.attachments} />
                      </li>
                    );
                  })}
                </ol>

                {canReply ? (
                  <div className="mt-4 border-t border-slate-200 pt-4">
                    <label className="block" htmlFor={`reply-${thread.candidateId}`}>
                      <span className={phxLabelClassName}>Your reply to {firstName}</span>
                    </label>
                    <textarea
                      className={phxTextareaClassName}
                      dir="auto"
                      id={`reply-${thread.candidateId}`}
                      maxLength={REPLY_LIMIT}
                      onChange={(event) => setDrafts((current) => ({ ...current, [thread.candidateId]: event.target.value }))}
                      onKeyDown={(event) => {
                        if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !saving) {
                          event.preventDefault();
                          void submitReply(thread.candidateId);
                        }
                      }}
                      placeholder="Write the answer the employee should read"
                      rows={4}
                      value={draft}
                    />
                    <div className="mt-1 flex items-center justify-between gap-3">
                      <span className="text-xs font-semibold text-slate-400">Ctrl + Enter sends</span>
                      <span className="text-xs font-semibold text-slate-400">
                        {draft.length} / {REPLY_LIMIT}
                      </span>
                    </div>
                    <PicturePicker
                      disabled={saving}
                      files={pictures[thread.candidateId] ?? []}
                      idBase={`reply-${thread.candidateId}`}
                      onChange={(next) => setPictures((current) => ({ ...current, [thread.candidateId]: next }))}
                    />
                    <AudienceLine thread={thread} />
                    <div className="mt-3 flex justify-end">
                      <button
                        className={phxButtonAccentClassName}
                        disabled={saving || (draft.trim().length === 0 && (pictures[thread.candidateId] ?? []).length === 0)}
                        onClick={() => {
                          void submitReply(thread.candidateId);
                        }}
                        type="button"
                      >
                        <Send aria-hidden className="h-4 w-4" />
                        {saving ? "Sending" : "Send reply"}
                      </button>
                    </div>
                    {message ? (
                      <p
                        className={cn(
                          "mt-2 text-xs font-semibold",
                          message.tone === "success" ? "text-emerald-700" : "text-rose-700",
                        )}
                        role={message.tone === "error" ? "alert" : "status"}
                      >
                        {message.text}
                      </p>
                    ) : null}
                    {delivery ? <ChannelRecap delivery={delivery} /> : null}
                    <CaseDecision
                      candidateId={thread.candidateId}
                      onDecided={() => {
                        void refreshAfterDecision(thread.candidateId);
                      }}
                    />
                  </div>
                ) : (
                  <p className="mt-4 border-t border-slate-200 pt-3 text-xs font-semibold text-slate-500">
                    You can read this dispute here. Only a Super Admin can reply.
                  </p>
                )}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
