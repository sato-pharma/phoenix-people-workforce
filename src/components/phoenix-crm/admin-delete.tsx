"use client";

/**
 * Phoenix CRM — the Super Admin's delete, drawn beside a plan, a visit or a day record (owner, 2026-10-23:
 * "in every weekly plan, every visit, every record, for the admin only, make admin tools — delete this
 * record or this plan as if it did not happen").
 *
 * Two steps, because it takes the record out of every screen and every figure: the button, then a
 * confirmation that says what goes with it. The server decided who may see this (`adminDeletes`, the Super
 * Admin alone) and asserts it again, and the database keeps a copy of what it deletes — so "Deleted" can
 * honestly say a copy is kept. It tells the rep and the managers nothing: the record is simply not there.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

import { crmPost, useCrmAction } from "@/components/phoenix-crm/api";
import { CrmButton, CrmNote, CrmSaveError } from "@/components/phoenix-crm/ui";
import { ADMIN_DELETE_WORDS, type AdminDeleteKind } from "@/lib/phoenix-crm/admin-delete-rules";

export function AdminDelete({
  id,
  isTest,
  kind,
  onDeleted,
  subject,
}: {
  id: string;
  isTest: boolean;
  kind: AdminDeleteKind;
  /** A screen that holds its own copy of the record (the plan board) drops it here; a server page re-reads. */
  onDeleted?: () => void;
  /** What it is, by name — "the visit to Dr Mona", "the week of Sat 10 Oct" — never a code. */
  subject: string;
}) {
  const router = useRouter();
  const action = useCrmAction();
  const [confirming, setConfirming] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const busy = action.busy !== null;
  const words = ADMIN_DELETE_WORDS[kind];

  async function remove() {
    await action.run(
      "delete",
      () => crmPost<{ deleted: boolean }>("/api/phoenix-crm/admin-delete", { id, kind, test: isTest }, "deleted"),
      () => {
        setDeleted(true);
        if (onDeleted) onDeleted();
        // A server page re-reads, so the record leaves the list it was in.
        else router.refresh();
      },
    );
  }

  if (deleted) return <CrmNote tone="good">Deleted. It is as if it never happened; a copy is kept.</CrmNote>;

  if (!confirming) {
    return (
      <CrmButton onClick={() => setConfirming(true)} size="sm" variant="danger">
        {words.button}
      </CrmButton>
    );
  }

  return (
    <div className="grid min-w-0 gap-2">
      <CrmNote title={`Delete ${words.thing}?`} tone="warn">
        <bdi>{subject}</bdi> is removed as if it never happened. {words.takes} Nobody is told. A copy is kept.
      </CrmNote>
      {action.error ? <CrmSaveError message={action.error} onRetry={action.retry} title="Not deleted" /> : null}
      <div className="grid gap-2 sm:flex sm:flex-wrap">
        <CrmButton busy={busy} onClick={() => void remove()} size="sm" variant="danger">
          Yes, delete it
        </CrmButton>
        <CrmButton disabled={busy} onClick={() => setConfirming(false)} size="sm">
          Keep it
        </CrmButton>
      </div>
    </div>
  );
}
