"use client";

import { Loader2, X } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { phxButtonGhostClassName, phxButtonPrimaryClassName, phxFieldClassName, phxFormErrorClassName, phxLabelClassName, phxSelectClassName, phxTextareaClassName } from "@/components/ui/form-tokens";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import {
  familyLabel,
  incidentEmployeeName,
  incidentHrId,
  incidentMessage,
  incidentShortRef,
  moduleLabelSourceLabel,
} from "@/lib/system-audit/incidents-display";
import type { OccurrenceDetail, OccurrenceScreenshot } from "@/lib/system-audit/occurrence-detail";
import {
  ROOT_CAUSE_LEVEL_LABELS,
  SYSTEM_AUDIT_HUMAN_STATUSES,
  SYSTEM_AUDIT_STATUS_LABELS,
} from "@/lib/system-audit/types";
import { cn } from "@/lib/utils";

/**
 * One occurrence, in full: what the person saw (and, labelled "System message", what the system
 * logged), its issue and root cause with the evidence, the whole status trail, the fixes, the
 * attempts and page loads, and — for an error a person saw — their last five page views before it.
 *
 * Two actions, each refused in words by the server when a rule is not met, and the database
 * function's own sentence shown verbatim when it refuses ("commit … is not a released build"):
 *   · change the ISSUE's status (human statuses only — FIXED — VERIFIED is the verifier's);
 *   · mark THIS occurrence no defect / unknown, with a reason, or clear that mark.
 */

type Loaded = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; detail: OccurrenceDetail };

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-t border-slate-200 pt-4">
      <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The screen the employee was looking at, fetched only when it is asked for.
 *
 * The bucket is private and these images are unmasked — a payslip that errored is photographed with
 * the pay on it — so the URL is minted per view, lives five minutes, and is never rendered into the
 * page until someone here clicks to see it.
 */
function ScreenshotView({ screenshot }: { screenshot: OccurrenceScreenshot }) {
  const [state, setState] = useState<
    { status: "closed" } | { status: "loading" } | { status: "error"; message: string } | { status: "open"; url: string }
  >({ status: "closed" });

  async function open() {
    setState({ status: "loading" });
    try {
      const response = await fetch(`/api/admin/system-audit/screenshot/${screenshot.eventId}`, { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { url?: string; message?: string } | null;
      if (!response.ok || !body?.url) {
        setState({ status: "error", message: body?.message ?? "The screenshot could not be opened." });
        return;
      }
      setState({ status: "open", url: body.url });
    } catch {
      setState({ status: "error", message: "The screenshot could not be opened." });
    }
  }

  return (
    <li className="border border-slate-200 p-2">
      <p className="text-xs text-slate-700">
        {cairoDateTime(screenshot.capturedAt)} Cairo
        {screenshot.route ? (
          <span className="block font-mono text-phx-2xs text-slate-500 [overflow-wrap:anywhere]">{screenshot.route}</span>
        ) : null}
      </p>
      {state.status === "open" ? (
        <img
          alt={`The screen as the employee saw it at ${cairoDateTime(screenshot.capturedAt)} Cairo`}
          className="mt-2 w-full border border-slate-200"
          src={state.url}
        />
      ) : (
        <button className={cn(phxButtonGhostClassName, "mt-2")} disabled={state.status === "loading"} onClick={open} type="button">
          {state.status === "loading" ? <Loader2 className="size-4 animate-spin" /> : null}
          {state.status === "loading" ? "Opening" : "Show the screen"}
        </button>
      )}
      {state.status === "error" ? <p className="mt-2 break-words text-xs font-semibold text-rose-700">{state.message}</p> : null}
    </li>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-phx-2xs font-bold uppercase text-slate-400">{label}</dt>
      <dd className="break-words text-sm text-slate-800">{children}</dd>
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  const text = JSON.stringify(value ?? {}, null, 2);
  if (!text || text === "{}" || text === "[]") return <p className="text-xs text-slate-500">None recorded.</p>;
  return (
    <pre className="whitespace-pre-wrap border border-slate-200 bg-slate-50 p-2 font-mono text-phx-2xs leading-relaxed text-slate-700 [overflow-wrap:anywhere]">
      {text}
    </pre>
  );
}

async function postJson(url: string, body: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(url, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    if (!response.ok) return { ok: false, message: payload?.message ?? `The server answered ${response.status}.` };
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "The request did not reach the server." };
  }
}

const NEEDS_REASON = new Set(["no_defect", "unknown"]);

function StatusForm({ detail, onDone }: { detail: OccurrenceDetail; onDone: () => void }) {
  const [to, setTo] = useState<string>(detail.issue.status === "fixed_verified" ? "investigating" : detail.issue.status);
  const [reason, setReason] = useState("");
  const [fixSha, setFixSha] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const result = await postJson(`/api/admin/system-audit/issues/${detail.issue.id}/status`, {
      fixSha: to === "fix_implemented" ? fixSha.trim() : null,
      occurrenceId: detail.occurrence.id,
      reason: reason.trim() || null,
      to,
    });
    setBusy(false);
    if (!result.ok) {
      setMessage({ tone: "error", text: result.message });
      return;
    }
    setMessage({ tone: "ok", text: `Status set to ${SYSTEM_AUDIT_STATUS_LABELS[to as keyof typeof SYSTEM_AUDIT_STATUS_LABELS] ?? to}.` });
    setReason("");
    setFixSha("");
    onDone();
  }

  return (
    <form className="space-y-3" onSubmit={submit}>
      <label className="block">
        <span className={phxLabelClassName}>Issue status</span>
        <select className={phxSelectClassName} disabled={busy} onChange={(event) => setTo(event.target.value)} value={to}>
          {SYSTEM_AUDIT_HUMAN_STATUSES.map((status) => (
            <option key={status} value={status}>
              {SYSTEM_AUDIT_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </label>
      {to === "fix_implemented" ? (
        <label className="block">
          <span className={phxLabelClassName}>Fix commit (all 40 characters)</span>
          <input
            autoComplete="off"
            className={cn(phxFieldClassName, "font-mono")}
            disabled={busy}
            maxLength={40}
            onChange={(event) => setFixSha(event.target.value)}
            pattern="[0-9a-fA-F]{40}"
            required
            spellCheck={false}
            value={fixSha}
          />
        </label>
      ) : null}
      <label className="block">
        <span className={phxLabelClassName}>
          Reason{NEEDS_REASON.has(to) ? " (required)" : " (optional)"}
        </span>
        <textarea
          className={phxTextareaClassName}
          disabled={busy}
          maxLength={2000}
          onChange={(event) => setReason(event.target.value)}
          required={NEEDS_REASON.has(to)}
          rows={3}
          value={reason}
        />
      </label>
      {message ? (
        <p className={message.tone === "error" ? phxFormErrorClassName : "text-sm font-bold text-emerald-700"} role={message.tone === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}
      <button className={phxButtonPrimaryClassName} disabled={busy} type="submit">
        {busy ? "Saving" : "Save the issue status"}
      </button>
      <p className="text-xs leading-relaxed text-slate-500">
        FIXED — VERIFIED is never set by hand: the verifier sets it after it re-measures a released fix.
      </p>
    </form>
  );
}

function TriageForm({ detail, onDone }: { detail: OccurrenceDetail; onDone: () => void }) {
  const current = detail.occurrence.triageOverride;
  const [override, setOverride] = useState<"no_defect" | "unknown" | "clear">(current ?? "no_defect");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const result = await postJson(`/api/admin/system-audit/occurrences/${detail.occurrence.id}`, {
      override: override === "clear" ? null : override,
      reason: reason.trim() || null,
    });
    setBusy(false);
    if (!result.ok) {
      setMessage({ tone: "error", text: result.message });
      return;
    }
    setMessage({ tone: "ok", text: override === "clear" ? "The mark on this occurrence was cleared." : "This occurrence was marked." });
    setReason("");
    onDone();
  }

  return (
    <form className="space-y-3" onSubmit={submit}>
      <label className="block">
        <span className={phxLabelClassName}>This occurrence only</span>
        <select
          className={phxSelectClassName}
          disabled={busy}
          onChange={(event) => setOverride(event.target.value as "no_defect" | "unknown" | "clear")}
          value={override}
        >
          <option value="no_defect">{SYSTEM_AUDIT_STATUS_LABELS.no_defect}</option>
          <option value="unknown">{SYSTEM_AUDIT_STATUS_LABELS.unknown}</option>
          {current ? <option value="clear">Clear the mark — follow the issue&apos;s status</option> : null}
        </select>
      </label>
      {override !== "clear" ? (
        <label className="block">
          <span className={phxLabelClassName}>Reason (required)</span>
          <textarea
            className={phxTextareaClassName}
            disabled={busy}
            maxLength={2000}
            onChange={(event) => setReason(event.target.value)}
            required
            rows={3}
            value={reason}
          />
        </label>
      ) : null}
      {message ? (
        <p className={message.tone === "error" ? phxFormErrorClassName : "text-sm font-bold text-emerald-700"} role={message.tone === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}
      <button className={phxButtonGhostClassName} disabled={busy} type="submit">
        {busy ? "Saving" : "Save for this occurrence"}
      </button>
    </form>
  );
}

const SCREEN_KIND_LABELS: Record<string, string> = {
  error_screen: "Error screen shown",
  refused_request: "Request refused",
  failed_request: "Request failed",
};

/**
 * The screenshots of exactly what the person saw (owner, 23 Oct 2026: as-is, Super Admin only, kept
 * 90 days). Each picture is served by the Super-Admin-only screens route; it never runs wider than
 * the drawer, and a tap opens it full size in a new tab.
 */
function ScreenshotList({ screens }: { screens: OccurrenceDetail["screens"] }) {
  if (screens.status === "unavailable") {
    return <p className="break-words text-xs font-semibold text-rose-700">Unavailable — {screens.reason}</p>;
  }
  if (screens.status === "not_applicable") return <p className="text-xs text-slate-500">{screens.reason}</p>;
  return (
    <div className="space-y-3">
      {screens.screens.length === 0 && screens.pruned === 0 ? (
        <p className="text-xs text-slate-500">No screenshot was recorded for this occurrence.</p>
      ) : null}
      {screens.screens.map((screen) => (
        <figure className="space-y-1" key={screen.id}>
          <a className="block border border-slate-300" href={screen.src} rel="noreferrer" target="_blank">
            {/* eslint-disable-next-line @next/next/no-img-element -- a private, Super-Admin-only stream; next/image would cache it */}
            <img
              alt={`Screenshot taken ${cairoDateTime(screen.capturedAt)} Cairo`}
              className="block h-auto w-full max-w-full"
              height={screen.height ?? undefined}
              loading="lazy"
              src={screen.src}
              width={screen.width ?? undefined}
            />
          </a>
          <figcaption className="break-words text-phx-2xs text-slate-500">
            {SCREEN_KIND_LABELS[screen.kind] ?? screen.kind}
            {screen.httpStatus ? ` · HTTP ${screen.httpStatus}` : ""} · {cairoDateTime(screen.capturedAt)} Cairo
          </figcaption>
        </figure>
      ))}
      {screens.pruned > 0 ? (
        <p className="text-xs text-slate-500">
          {screens.pruned === 1 ? "One screenshot has" : `${screens.pruned.toLocaleString("en-US")} screenshots have`} passed the
          90 days they are kept and been removed.
        </p>
      ) : null}
    </div>
  );
}

function DetailBody({ detail, onChanged }: { detail: OccurrenceDetail; onChanged: () => void }) {
  const { occurrence, issue, history, fixes, reproTrail, screenshots } = detail;
  const pageRow = {
    employeeName: occurrence.employeeName,
    family: occurrence.family,
    hrId: occurrence.hrId,
    hrKey: occurrence.hrKey,
    isSilent: occurrence.isSilent,
    userMessage: occurrence.userMessage,
  };
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Fact label="Employee">
          {incidentEmployeeName(pageRow)}
          {occurrence.hrKey ? <span className="ml-1 font-mono text-xs text-slate-500">{incidentHrId(pageRow)}</span> : null}
        </Fact>
        <Fact label="Role at the time">{occurrence.roleAtEvent ?? "Not recorded"}</Fact>
        <Fact label="Module">
          {occurrence.moduleLabel}
          <span className="block text-xs text-slate-500">{moduleLabelSourceLabel(occurrence.moduleLabelSource)}</span>
        </Fact>
        <Fact label="When (Cairo)">{cairoDateTime(occurrence.occurredAt)}</Fact>
        <Fact label="Source">{familyLabel(occurrence.family)}</Fact>
        <Fact label="Error code / incident ref">
          <span className="font-mono">
            {occurrence.errorCode} / {incidentShortRef(occurrence.id)}
          </span>
        </Fact>
        <Fact label="Attempts">{occurrence.attemptCount.toLocaleString("en-US")}</Fact>
        <Fact label="Page loads">{occurrence.pageLoads.toLocaleString("en-US")}</Fact>
        <Fact label="First event (Cairo)">{cairoDateTime(occurrence.firstEventAt)}</Fact>
        <Fact label="Last event (Cairo)">{cairoDateTime(occurrence.lastEventAt)}</Fact>
        {occurrence.route ? (
          <Fact label="Address">
            <span className="font-mono text-xs [overflow-wrap:anywhere]">{occurrence.route}</span>
          </Fact>
        ) : null}
        {occurrence.release ? (
          <Fact label="Build">
            <span className="font-mono text-xs [overflow-wrap:anywhere]">{occurrence.release}</span>
            {occurrence.preFixBuild ? <span className="block text-xs text-amber-800">Built before the fix went live.</span> : null}
          </Fact>
        ) : null}
        {occurrence.triageOverride ? (
          <Fact label="This occurrence is marked">
            {SYSTEM_AUDIT_STATUS_LABELS[occurrence.triageOverride]}
            {occurrence.triageReason ? <span className="block text-xs text-slate-600">{occurrence.triageReason}</span> : null}
          </Fact>
        ) : null}
      </dl>

      <Section title="Error encountered">
        <p className={cn("break-words text-sm", occurrence.userMessage?.trim() ? "text-slate-900" : "italic text-slate-500")}>
          {incidentMessage(pageRow)}
        </p>
      </Section>

      {detail.screens.status !== "not_applicable" ? (
        <Section title="What the person saw when blocked">
          <ScreenshotList screens={detail.screens} />
        </Section>
      ) : null}

      <Section title="System message">
        {occurrence.technicalMessage ? (
          <pre className="whitespace-pre-wrap border border-slate-200 bg-slate-50 p-2 font-mono text-phx-2xs leading-relaxed text-slate-700 [overflow-wrap:anywhere]">
            {occurrence.technicalMessage}
          </pre>
        ) : (
          <p className="text-xs text-slate-500">No system message was recorded.</p>
        )}
      </Section>

      <Section title="Issue">
        <p className="break-words text-sm font-bold text-slate-900">{issue.title}</p>
        <p className="text-sm text-slate-700">
          Status: <span className="font-bold">{issue.statusLabel}</span>
        </p>
        <p className="break-words text-sm text-slate-700">
          <span className="font-bold">{ROOT_CAUSE_LEVEL_LABELS[issue.rootCauseLevel]}</span> —{" "}
          {issue.rootCause?.trim() || "No root cause recorded yet."}
        </p>
        <p className="text-xs text-slate-500">
          First seen {cairoDateTime(issue.firstSeenAt)} · last seen {cairoDateTime(issue.lastSeenAt)} (Cairo)
        </p>
        <p className="text-phx-2xs font-bold uppercase text-slate-400">Root-cause evidence</p>
        <JsonBlock value={issue.rootCauseEvidence} />
        <p className="text-phx-2xs font-bold uppercase text-slate-400">This occurrence&apos;s evidence</p>
        <JsonBlock value={occurrence.evidence} />
      </Section>

      <Section title="Status trail">
        {history.length === 0 ? (
          <p className="text-xs text-slate-500">No status change has been recorded for this issue.</p>
        ) : (
          <ol className="space-y-2">
            {history.map((entry) => (
              <li className="border-l-2 border-slate-300 pl-3 text-xs text-slate-700" key={entry.id}>
                <p className="break-words">
                  <span className="font-bold text-slate-900">{entry.toLabel}</span>
                  {entry.fromLabel ? <span className="text-slate-500"> (was {entry.fromLabel})</span> : null}
                  {entry.occurrenceScope === "this" ? <span className="text-orange-700"> · this occurrence</span> : null}
                  {entry.occurrenceScope === "other" ? (
                    <span className="text-slate-500"> · another occurrence ({entry.otherOccurrenceRef})</span>
                  ) : null}
                </p>
                <p className="text-slate-500">
                  {cairoDateTime(entry.at)} Cairo · {entry.actorName}
                </p>
                {entry.reason ? <p className="mt-0.5 break-words">{entry.reason}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section title="Fixes">
        {fixes.length === 0 ? (
          <p className="text-xs text-slate-500">No fix has been recorded for this issue.</p>
        ) : (
          <ol className="space-y-2">
            {fixes.map((fix) => (
              <li className="border border-slate-200 p-2 text-xs text-slate-700" key={fix.id}>
                <p className="font-mono [overflow-wrap:anywhere]">{fix.commitSha}</p>
                <p>
                  Fix {fix.generation} · live {cairoDateTime(fix.liveAt)} Cairo · recorded by {fix.createdByName}
                </p>
                <p className={fix.invalidatedAt ? "font-bold text-rose-700" : fix.verifiedAt ? "font-bold text-emerald-700" : "text-slate-600"}>
                  {fix.invalidatedAt
                    ? `Reopened ${cairoDateTime(fix.invalidatedAt)} Cairo — the error came back after this fix.`
                    : fix.verifiedAt
                      ? `Verified ${cairoDateTime(fix.verifiedAt)} Cairo.`
                      : "Not verified yet."}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section title="What the employee saw">
        {screenshots.length === 0 ? (
          <p className="text-xs text-slate-500">
            No screen was captured for this one. A picture is taken only for an error the browser itself reported, and
            only from a build that carries the capture.
          </p>
        ) : (
          <ul className="space-y-2">
            {screenshots.map((screenshot) => (
              <ScreenshotView key={screenshot.eventId} screenshot={screenshot} />
            ))}
          </ul>
        )}
      </Section>

      <Section title="What the person did just before">
        {reproTrail.status === "ok" ? (
          reproTrail.entries.length === 0 ? (
            <p className="text-xs text-slate-500">{reproTrail.note}</p>
          ) : (
            <ol className="space-y-1">
              {reproTrail.entries.map((entry, index) => (
                <li className="text-xs text-slate-700" key={`${entry.at}-${index}`}>
                  <span className="font-semibold text-slate-900">{entry.moduleLabel}</span> · {cairoDateTime(entry.at)} Cairo
                  {entry.path ? <span className="block font-mono text-phx-2xs text-slate-500 [overflow-wrap:anywhere]">{entry.path}</span> : null}
                </li>
              ))}
            </ol>
          )
        ) : reproTrail.status === "unavailable" ? (
          <p className="break-words text-xs font-semibold text-rose-700">Unavailable — {reproTrail.reason}</p>
        ) : (
          <p className="text-xs text-slate-500">{reproTrail.reason}</p>
        )}
      </Section>

      <Section title="Change the issue status">
        <StatusForm detail={detail} key={`status-${issue.status}`} onDone={onChanged} />
      </Section>

      <Section title="Mark this occurrence">
        <TriageForm detail={detail} key={`triage-${occurrence.triageOverride ?? "none"}`} onDone={onChanged} />
      </Section>
    </div>
  );
}

export function IncidentDrawer({
  occurrenceId,
  onClose,
  onChanged,
}: {
  occurrenceId: string | null;
  onClose: () => void;
  /** Called after a saved change, so the list re-reads its status column. */
  onChanged: () => void;
}) {
  const open = occurrenceId !== null;
  const dialogRef = useDialogA11y<HTMLDivElement>({ open, onClose });
  const [reloadKey, setReloadKey] = useState(0);
  // The answer is stored with the incident and the reload it answers, so a different incident (or a
  // re-read after a saved change) shows "Reading the record" until its own answer arrives — derived
  // here, never set synchronously inside the effect.
  const [result, setResult] = useState<{ id: string; reload: number; loaded: Loaded } | null>(null);
  const loaded: Loaded =
    result && result.id === occurrenceId && result.reload === reloadKey ? result.loaded : { status: "loading" };

  useEffect(() => {
    if (!occurrenceId) return;
    const controller = new AbortController();
    const settle = (value: Loaded) => {
      if (!controller.signal.aborted) setResult({ id: occurrenceId, reload: reloadKey, loaded: value });
    };
    fetch(`/api/admin/system-audit/occurrences/${occurrenceId}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as { detail?: OccurrenceDetail; message?: string } | null;
        if (!response.ok || !payload?.detail) {
          settle({ status: "error", message: payload?.message ?? `Unavailable — the server answered ${response.status}.` });
          return;
        }
        settle({ status: "ready", detail: payload.detail });
      })
      .catch((error: unknown) => {
        settle({ status: "error", message: `Unavailable — ${error instanceof Error ? error.message : "the request failed"}` });
      });
    return () => controller.abort();
  }, [occurrenceId, reloadKey]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button aria-label="Close the incident" className="absolute inset-0 bg-slate-950/40" onClick={onClose} type="button" />
      <div
        aria-labelledby="system-audit-drawer-title"
        aria-modal="true"
        className="relative flex h-full w-full max-w-2xl flex-col border-l border-slate-300 bg-white"
        ref={dialogRef}
        role="dialog"
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <p className="text-phx-2xs font-black uppercase tracking-[0.2em] text-orange-600">Incident</p>
            <h2 className="break-words text-base font-black text-slate-900" id="system-audit-drawer-title">
              {loaded.status === "ready" ? loaded.detail.issue.title : "Loading the incident"}
            </h2>
          </div>
          <button aria-label="Close" className="shrink-0 border border-slate-300 p-1.5 text-slate-600 hover:bg-slate-100" onClick={onClose} type="button">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-w-0 flex-1 overflow-y-auto px-4 py-4">
          {loaded.status === "loading" ? (
            <p className="flex items-center gap-2 text-sm font-semibold text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading the record
            </p>
          ) : loaded.status === "error" ? (
            <p className={phxFormErrorClassName} role="alert">
              {loaded.message}
            </p>
          ) : (
            <DetailBody
              detail={loaded.detail}
              onChanged={() => {
                setReloadKey((value) => value + 1);
                onChanged();
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
