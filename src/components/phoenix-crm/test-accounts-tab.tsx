"use client";

/**
 * Phoenix CRM — the Super Admin's own tab for the test personas' approvals (owner, 2026-10-22: *"add a
 * new tab called Test accounts. It will be responsible for all approvals that I do with test accounts"*).
 *
 * Every item a test login sent for approval waits here at the step it is AT, and he takes that one step:
 * a two-step item comes back at its second step, exactly as a real one moves from the district manager
 * to SFE (his pick the same day: "step by step"). Each decision saves at the press, so nothing typed on
 * this tab waits to be kept. The server decides who may open it, which rows it lists and which decisions
 * they take — this file only draws them.
 *
 * Cards, never a table: each item carries a sentence or two of its own, and the cards wrap on a phone and
 * on a desktop alike (the fits-the-screen rule). Square corners throughout, from the module's own blocks.
 */

import { useId, useState } from "react";

import { crmPost, useCrmAction, useCrmGet } from "@/components/phoenix-crm/api";
import {
  CrmButton,
  CrmCard,
  CrmChoice,
  CrmEmpty,
  CrmField,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmPanel,
  CrmPill,
  CrmSaveError,
  CrmSelect,
  crmTextareaClassName,
} from "@/components/phoenix-crm/ui";
import type { TestApprovalItem, TestApprovalsView } from "@/lib/phoenix-crm/view-types";

const NOTE_MAX = 500;

export function TestApprovalsTab({ onChanged }: { onChanged?: () => void }) {
  const view = useCrmGet<TestApprovalsView>("/api/phoenix-crm/test-approvals", "testApprovals");
  const items = view.data?.items ?? [];
  const unreadable = view.data?.unreadable ?? [];

  return (
    <CrmPanel
      description="What the test logins sent for approval. Take each step yourself, as the manager, SFE or HR would; a two-step item comes back here at its next step."
      eyebrow="Test world"
      title={`Waiting for your decision${items.length > 0 ? ` (${items.length})` : ""}`}
    >
      {view.error ? <CrmLoadError message={view.error} onRetry={view.reload} /> : null}
      {view.loading && !view.data ? <CrmLoading label="Loading the test approvals" /> : null}
      {unreadable.length > 0 ? (
        <div className="px-4 pt-4 sm:px-5">
          <CrmNote title="Some of this could not be read" tone="warn">
            {`${unreadable.join(", ")} could not be read just now, so this list may be missing items. Reload in a minute.`}
          </CrmNote>
        </div>
      ) : null}
      {view.data && items.length === 0 && unreadable.length === 0 ? (
        <CrmEmpty message="When a test login sends something for approval, it waits here for you." title="Nothing from the test personas is waiting." />
      ) : null}
      {items.length > 0 ? (
        <ul className="grid min-w-0 gap-3 px-4 py-4 sm:px-5">
          {items.map((item) => (
            <li className="min-w-0 border border-slate-200" key={item.key}>
              <TestApprovalCard
                item={item}
                onDecided={() => {
                  view.reload();
                  onChanged?.();
                }}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </CrmPanel>
  );
}

function TestApprovalCard({ item, onDecided }: { item: TestApprovalItem; onDecided: () => void }) {
  const fieldId = useId();
  const action = useCrmAction();
  const [note, setNote] = useState("");
  const [grade, setGrade] = useState<"A" | "B" | "C" | null>(item.grading?.proposedGrade ?? null);
  const [potential, setPotential] = useState("");
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  async function decide(decision: string, label: string) {
    setProblem(null);
    const declining = decision === item.decline.decision;
    if (declining && item.decline.reasonRequired && !note.trim()) {
      setProblem("Write why, so the test login reads it.");
      return;
    }
    if (declining && item.refusalReasons && !reason) {
      setProblem("Choose what is wrong with the photo.");
      return;
    }
    if (!declining && item.grading && (!grade || !potential)) {
      setProblem("Choose the grade and the potential before approving.");
      return;
    }
    await action.run(
      label,
      () =>
        crmPost<{ kind: string; id: string }>(
          "/api/phoenix-crm/test-approvals/decide",
          {
            kind: item.kind,
            id: item.id,
            decision,
            note: note.trim() || null,
            version: item.version,
            stage: item.stage,
            requestedAt: item.requestedAt,
            approvedGrade: item.grading ? grade : undefined,
            potentialGrade: item.grading ? potential : undefined,
            refusalReason: item.refusalReasons ? reason || null : undefined,
          },
          "decided",
        ),
      () => onDecided(),
    );
  }

  const busy = action.busy !== null;
  return (
    <CrmCard
      accent="border-l-orange-500"
      actions={
        <>
          <CrmButton busy={action.busy === item.approve.label} disabled={busy} onClick={() => void decide(item.approve.decision, item.approve.label)} variant="primary">
            {item.approve.label}
          </CrmButton>
          <CrmButton busy={action.busy === item.decline.label} disabled={busy} onClick={() => void decide(item.decline.decision, item.decline.label)} variant="danger">
            {item.decline.label}
          </CrmButton>
        </>
      }
      meta={[item.personName, item.territoryName, `Waiting since ${item.waitingSince}`].filter(Boolean).join(" · ")}
      status={
        <>
          <CrmPill tone="orange">{item.stepLabel}</CrmPill>
          <CrmPill tone="info">Test</CrmPill>
        </>
      }
      title={`${item.what}: ${item.subject}`}
    >
      <div className="grid min-w-0 gap-3">
        {item.details.length > 0 ? (
          <ul className="grid min-w-0 gap-1">
            {item.details.map((line) => (
              <li className="break-words text-sm font-medium leading-6 text-slate-700" key={line}>
                {line}
              </li>
            ))}
          </ul>
        ) : null}
        {item.grading ? (
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <CrmField label="Grade">
              <CrmChoice<"A" | "B" | "C">
                label="Grade"
                onChange={setGrade}
                options={[
                  { label: "A", value: "A" },
                  { label: "B", value: "B" },
                  { label: "C", value: "C" },
                ]}
                value={grade}
              />
            </CrmField>
            <CrmField htmlFor={`${fieldId}-potential`} label="Potential">
              <CrmSelect disabled={busy} id={`${fieldId}-potential`} onChange={(event) => setPotential(event.target.value)} value={potential}>
                <option value="">Choose the potential</option>
                {item.grading.potentials.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </CrmSelect>
            </CrmField>
          </div>
        ) : null}
        {item.refusalReasons ? (
          <CrmField hint="Only for a rejection: the test login is told this." htmlFor={`${fieldId}-reason`} label="What is wrong with the photo">
            <CrmSelect disabled={busy} id={`${fieldId}-reason`} onChange={(event) => setReason(event.target.value)} value={reason}>
              <option value="">Choose what is wrong</option>
              {item.refusalReasons.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.label}
                </option>
              ))}
            </CrmSelect>
          </CrmField>
        ) : null}
        <CrmField
          hint={item.decline.reasonRequired ? `Needed to ${item.decline.label.toLowerCase()}; optional to ${item.approve.label.toLowerCase()}.` : "Optional."}
          htmlFor={`${fieldId}-note`}
          label="Note"
        >
          <textarea
            className={crmTextareaClassName}
            disabled={busy}
            id={`${fieldId}-note`}
            maxLength={NOTE_MAX}
            onChange={(event) => {
              setProblem(null);
              setNote(event.target.value);
            }}
            rows={2}
            value={note}
          />
        </CrmField>
        {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
        {!problem && action.error ? <CrmSaveError message={action.error} onRetry={action.retry} title={null} /> : null}
      </div>
    </CrmCard>
  );
}
