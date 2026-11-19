"use client";

// Approvals WhatsApp — the Lists tab: named groups of people to send to again (employees and pasted numbers).
//
// A list stores each member's number at the time it is saved, and the employee it belongs to when there is one, so a
// bulk send from it fills each person's fields from their CURRENT record. Deleting a list never touches a send made
// from it: each send keeps its own recipients and report.

import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { Action } from "@/components/recruitment/workstation/workstation-look";
import { deleteRequest, getJson, postJson, putJson } from "@/components/recruitment/recruitment-fetch";
import { phxFieldClassName, phxLabelClassName } from "@/components/ui/form-tokens";
import { formatListTime } from "@/components/whatsapp-inbox/inbox-format";

import { APPROVALS_API, Notice, Panel, RecipientPicker, type ApprovalsEmployeeOption, type RecipientChoice } from "./approvals-shared";

export type ApprovalsListSummaryView = { id: string; name: string; description: string | null; memberCount: number; updatedAt: string };

type Editing = { id: string | null; name: string; description: string; choice: RecipientChoice };

export function ApprovalsLists({
  employees,
  lists,
  onChanged,
}: {
  employees: ApprovalsEmployeeOption[];
  lists: ApprovalsListSummaryView[];
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "good" | "warn"; text: string } | null>(null);

  async function edit(list: ApprovalsListSummaryView) {
    setBusy(true);
    setMessage(null);
    try {
      const data = await getJson(`${APPROVALS_API}/lists/${list.id}`);
      const members = Array.isArray(data.members) ? (data.members as Array<{ waId: string; employeeHrId: string | null }>) : [];
      setEditing({
        choice: {
          employeeHrIds: members.flatMap((member) => (member.employeeHrId ? [member.employeeHrId] : [])),
          pasted: members.flatMap((member) => (member.employeeHrId ? [] : [member.waId])).join("\n"),
        },
        description: list.description ?? "",
        id: list.id,
        name: list.name,
      });
    } catch (caught) {
      setMessage({ text: caught instanceof Error ? caught.message : "The list could not be opened.", tone: "warn" });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    setMessage(null);
    try {
      const body = { description: editing.description, employeeHrIds: editing.choice.employeeHrIds, name: editing.name, pasted: editing.choice.pasted };
      const data = editing.id ? await putJson(`${APPROVALS_API}/lists/${editing.id}`, body) : await postJson(`${APPROVALS_API}/lists`, body);
      const raw = (data.skipped ?? {}) as { noNumber?: unknown[]; invalid?: unknown[]; duplicates?: number };
      const skipped = (raw.noNumber?.length ?? 0) + (raw.invalid?.length ?? 0) + (typeof raw.duplicates === "number" ? raw.duplicates : 0);
      setMessage({ text: `Saved ${editing.name}.${skipped > 0 ? ` ${skipped} entries were skipped (no number, not a usable number, or chosen twice).` : ""}`, tone: "good" });
      setEditing(null);
      await onChanged();
    } catch (caught) {
      setMessage({ text: caught instanceof Error ? caught.message : "The list was not saved.", tone: "warn" });
    } finally {
      setBusy(false);
    }
  }

  async function remove(list: ApprovalsListSummaryView) {
    setBusy(true);
    setMessage(null);
    try {
      await deleteRequest(`${APPROVALS_API}/lists/${list.id}`);
      setConfirmDelete(null);
      setMessage({ text: `Deleted ${list.name}. Sends made from it keep their reports.`, tone: "good" });
      await onChanged();
    } catch (caught) {
      setMessage({ text: caught instanceof Error ? caught.message : "The list was not deleted.", tone: "warn" });
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <Panel title={editing.id ? "Change the list" : "New list"}>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="flex flex-col">
              <span className={phxLabelClassName}>Name</span>
              <input className={phxFieldClassName} dir="auto" maxLength={120} onChange={(event) => setEditing({ ...editing, name: event.target.value })} value={editing.name} />
            </label>
            <label className="flex flex-col">
              <span className={phxLabelClassName}>What it is for (optional)</span>
              <input className={phxFieldClassName} dir="auto" maxLength={300} onChange={(event) => setEditing({ ...editing, description: event.target.value })} value={editing.description} />
            </label>
          </div>
          <RecipientPicker choice={editing.choice} employees={employees} onChange={(choice) => setEditing({ ...editing, choice })} />
          {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
          <div className="flex flex-wrap gap-2">
            <Action disabled={busy || !editing.name.trim()} onClick={() => void save()} size="md" tone="primary">
              {busy ? "Saving" : "Save the list"}
            </Action>
            <Action disabled={busy} onClick={() => setEditing(null)} size="md" tone="ghost">
              Cancel
            </Action>
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      aside={
        <Action disabled={busy} onClick={() => setEditing({ choice: { employeeHrIds: [], pasted: "" }, description: "", id: null, name: "" })} tone="primary">
          <Plus aria-hidden className="h-3.5 w-3.5" />
          New list
        </Action>
      }
      title="Saved lists"
    >
      <div className="flex flex-col gap-3">
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
        {lists.length === 0 ? <p className="text-[12px] text-phx-ink-soft">No saved lists yet. A list keeps a group of people to send to again.</p> : null}
        <ul className="flex flex-col">
          {lists.map((list) => (
            <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-phx-line py-2.5 last:border-b-0" key={list.id}>
              <span className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
                <span className="break-words text-[13px] font-bold text-phx-ink" dir="auto">
                  {list.name}
                </span>
                <span className="break-words text-[11px] text-phx-ink-soft" dir="auto">
                  {list.memberCount} {list.memberCount === 1 ? "person" : "people"} · changed {formatListTime(list.updatedAt)}
                  {list.description ? ` · ${list.description}` : ""}
                </span>
              </span>
              <span className="flex flex-wrap gap-1.5">
                <Action disabled={busy} onClick={() => void edit(list)} tone="quiet">
                  <Pencil aria-hidden className="h-3.5 w-3.5" />
                  Change
                </Action>
                {confirmDelete === list.id ? (
                  <>
                    <Action disabled={busy} onClick={() => void remove(list)} tone="quiet">
                      <Trash2 aria-hidden className="h-3.5 w-3.5" />
                      Delete {list.name}
                    </Action>
                    <Action disabled={busy} onClick={() => setConfirmDelete(null)} tone="ghost">
                      Keep it
                    </Action>
                  </>
                ) : (
                  <Action disabled={busy} onClick={() => setConfirmDelete(list.id)} tone="ghost">
                    <Trash2 aria-hidden className="h-3.5 w-3.5" />
                    Delete
                  </Action>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}
