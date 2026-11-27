"use client";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE HR FORMS CONTROL TAB (owner, 2026-11-27): "a tab in HR Forms where I can rearrange the forms
// that appear, remove a form, add a form I want to appear — move it from another paper to new hire,
// or from new hire to another paper. Make a page of control in HR Forms."
//
// Three columns: New hire and Leaver are ordered lists (up, down, move across, remove); Another paper
// is every paper on neither list, each one a click away from either package. Nothing is stored until
// Save; "Put back the standard order" returns both lists to the order HR Forms shipped with. The rules
// of what may sit where are `forms-layout.ts`; the server cleans every list again before keeping it.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { ArrowDown, ArrowLeftRight, ArrowUp, CheckCircle2, AlertTriangle, Plus, RotateCcw, Save, X } from "lucide-react";
import { useState } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { phxLabelClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { documentLabel } from "@/lib/hiring-pack/document-registry";
import { buildFormsDrive } from "@/lib/hiring-pack/forms-drive";
import {
  ARRANGED_PACKAGES,
  DEFAULT_FORMS_LAYOUT,
  mayArrange,
  sameFormsLayout,
  stepOfDocument,
  stepsOutsidePackages,
  type ArrangedPackage,
  type FormsLayout,
} from "@/lib/hiring-pack/forms-layout";
import type { StoredFormsLayout } from "@/lib/hiring-pack/forms-layout-store";
import { EXIT_FORM_STEP, type LeaverStep } from "@/lib/hiring-pack/hr-forms-wizard";

const PACKAGE_TITLES: Record<ArrangedPackage, string> = { leaver: "Leaver", newHire: "New hire" };

/** The step's name on this tab: the exit form is the one step that asks which of the two. */
export function arrangedStepLabel(step: LeaverStep): string {
  return step === EXIT_FORM_STEP ? "Exit form — resignation or mutual termination" : documentLabel(step);
}

/** The drive's folders, so "Another paper" and the add list read in the cabinet's own groups. */
function folderOfStep(): Map<string, string> {
  const folders = new Map<string, string>();
  for (const folder of buildFormsDrive([])) {
    for (const entry of folder.entries) {
      const step = stepOfDocument(entry.document);
      if (!folders.has(step)) folders.set(step, folder.labelEn);
    }
  }
  return folders;
}

/** Built once: the drive's folders are compiled, not read. */
const folders = folderOfStep();

export function HrFormsControl({
  initial,
  onSaved,
}: {
  initial: StoredFormsLayout;
  onSaved: (stored: StoredFormsLayout) => void;
}) {
  const [saved, setSaved] = useState<FormsLayout>(initial.layout);
  const [draft, setDraft] = useState<FormsLayout>(initial.layout);
  const [adding, setAdding] = useState<Record<ArrangedPackage, string>>({ leaver: "", newHire: "" });
  const [busy, setBusy] = useState(false);
  const [arranged, setArranged] = useState(initial.arranged.newHire || initial.arranged.leaver);
  const [message, setMessage] = useState<{ tone: "danger" | "success"; text: string } | null>(
    initial.ready ? null : { text: "Saving is not ready yet — the arrangement table has not been created.", tone: "danger" },
  );

  const outside = stepsOutsidePackages(draft);
  const dirty = !sameFormsLayout(draft, saved);
  const isStandard = sameFormsLayout(draft, DEFAULT_FORMS_LAYOUT);

  const change = (next: FormsLayout) => {
    setDraft(next);
    setMessage(null);
  };
  const move = (pack: ArrangedPackage, index: number, by: -1 | 1) => {
    const list = [...draft[pack]];
    const target = index + by;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    change({ ...draft, [pack]: list });
  };
  const remove = (pack: ArrangedPackage, step: LeaverStep) =>
    change({ ...draft, [pack]: draft[pack].filter((value) => value !== step) });
  const add = (pack: ArrangedPackage, step: LeaverStep) => {
    if (!mayArrange(step, pack) || draft[pack].includes(step)) return;
    change({ ...draft, [pack]: [...draft[pack], step] });
  };
  const moveAcross = (from: ArrangedPackage, step: LeaverStep) => {
    const to: ArrangedPackage = from === "newHire" ? "leaver" : "newHire";
    if (!mayArrange(step, to)) return;
    change({
      ...draft,
      [from]: draft[from].filter((value) => value !== step),
      [to]: draft[to].includes(step) ? draft[to] : [...draft[to], step],
    });
  };

  const save = async (body: Record<ArrangedPackage, LeaverStep[] | null>) => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/hiring-pack/forms-layout", {
        body: JSON.stringify({ layout: body }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      });
      const payload = (await response.json().catch(() => null)) as (StoredFormsLayout & { message?: string }) | null;
      if (!response.ok || !payload?.layout) {
        setMessage({ text: payload?.message ?? "The arrangement could not be saved.", tone: "danger" });
        return;
      }
      setSaved(payload.layout);
      setArranged(payload.arranged.newHire || payload.arranged.leaver);
      setDraft(payload.layout);
      onSaved(payload);
      setMessage({ text: "Saved. HR Forms now walks through the papers in this order.", tone: "success" });
    } catch {
      setMessage({ text: "The arrangement could not be saved — check the connection and try again.", tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const groupedOutside = (steps: readonly LeaverStep[]) => {
    const groups = new Map<string, LeaverStep[]>();
    for (const step of steps) {
      const folder = folders.get(step) ?? "Other papers";
      groups.set(folder, [...(groups.get(folder) ?? []), step]);
    }
    return [...groups.entries()];
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm font-semibold text-phx-ink-soft">
        New hire and Leaver walk through their papers in this order, one step each. Another paper offers
        everything on neither list. Nothing changes until you press Save.
      </p>

      {message ? (
        <AdminCallout tone={message.tone}>
          {message.tone === "success" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <span>{message.text}</span>
        </AdminCallout>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {ARRANGED_PACKAGES.map((pack) => {
          const list = draft[pack];
          const other: ArrangedPackage = pack === "newHire" ? "leaver" : "newHire";
          const addable = groupedOutside(
            stepsOutsidePackages({ ...draft, [other]: [] }).filter((step) => mayArrange(step, pack) && !list.includes(step)),
          );
          return (
            <section className="flex min-w-0 flex-col border border-phx-line bg-white" key={pack}>
              <header className="flex items-baseline justify-between gap-2 border-b border-phx-line px-4 py-3">
                <h3 className="text-sm font-black text-phx-ink">{PACKAGE_TITLES[pack]}</h3>
                <span className="text-phx-xs font-bold text-phx-ink-soft">
                  {list.length} {list.length === 1 ? "paper" : "papers"}
                </span>
              </header>
              {list.length === 0 ? (
                <p className="px-4 py-3 text-sm font-semibold text-phx-ink-soft">No papers — add one below.</p>
              ) : (
                <ol className="flex flex-col">
                  {list.map((step, index) => (
                    <li className="flex flex-col gap-2 border-b border-phx-line px-4 py-2.5" key={step}>
                      <div className="flex items-start gap-2">
                        <span className="w-5 shrink-0 text-sm font-black text-phx-accent">{index + 1}</span>
                        <span className="min-w-0 flex-1 break-words text-sm font-bold text-phx-ink">
                          {arrangedStepLabel(step)}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5 pl-7">
                        <Button
                          aria-label={`Move ${arrangedStepLabel(step)} up`}
                          className="h-8"
                          disabled={busy || index === 0}
                          onClick={() => move(pack, index, -1)}
                          size="xs"
                          type="button"
                          variant="outline"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          aria-label={`Move ${arrangedStepLabel(step)} down`}
                          className="h-8"
                          disabled={busy || index === list.length - 1}
                          onClick={() => move(pack, index, 1)}
                          size="xs"
                          type="button"
                          variant="outline"
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </Button>
                        {mayArrange(step, other) ? (
                          <Button
                            className="h-8 gap-1"
                            disabled={busy}
                            onClick={() => moveAcross(pack, step)}
                            size="xs"
                            type="button"
                            variant="outline"
                          >
                            <ArrowLeftRight className="h-3.5 w-3.5" />
                            To {PACKAGE_TITLES[other]}
                          </Button>
                        ) : null}
                        <Button
                          className="h-8 gap-1"
                          disabled={busy}
                          onClick={() => remove(pack, step)}
                          size="xs"
                          type="button"
                          variant="ghost"
                        >
                          <X className="h-3.5 w-3.5" />
                          Remove
                        </Button>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              <div className="mt-auto flex flex-col gap-2 px-4 py-3">
                <label className={phxLabelClassName} htmlFor={`hr-forms-add-${pack}`}>
                  Add a paper to {PACKAGE_TITLES[pack]}
                </label>
                <select
                  className={phxSelectClassName}
                  disabled={busy || addable.length === 0}
                  id={`hr-forms-add-${pack}`}
                  onChange={(event) => setAdding((current) => ({ ...current, [pack]: event.target.value }))}
                  value={adding[pack]}
                >
                  <option value="">— choose a paper —</option>
                  {addable.map(([folder, steps]) => (
                    <optgroup key={folder} label={folder}>
                      {steps.map((step) => (
                        <option key={step} value={step}>
                          {arrangedStepLabel(step)}
                          {draft[other].includes(step) ? ` (also on ${PACKAGE_TITLES[other]})` : ""}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <Button
                  className="h-9 gap-1.5 self-start"
                  disabled={busy || !adding[pack]}
                  onClick={() => {
                    add(pack, adding[pack] as LeaverStep);
                    setAdding((current) => ({ ...current, [pack]: "" }));
                  }}
                  type="button"
                  variant="secondary"
                >
                  <Plus className="h-4 w-4" />
                  Add
                </Button>
              </div>
            </section>
          );
        })}

        <section className="flex min-w-0 flex-col border border-phx-line bg-white">
          <header className="flex items-baseline justify-between gap-2 border-b border-phx-line px-4 py-3">
            <h3 className="text-sm font-black text-phx-ink">Another paper</h3>
            <span className="text-phx-xs font-bold text-phx-ink-soft">
              {outside.length} {outside.length === 1 ? "paper" : "papers"}
            </span>
          </header>
          {outside.length === 0 ? (
            <p className="px-4 py-3 text-sm font-semibold text-phx-ink-soft">Every paper is on a package.</p>
          ) : (
            groupedOutside(outside).map(([folder, steps]) => (
              <div className="border-b border-phx-line" key={folder}>
                <p className="bg-phx-paper px-4 py-1.5 text-phx-xs font-black uppercase tracking-wide text-phx-ink-soft">
                  {folder}
                </p>
                <ul className="flex flex-col">
                  {steps.map((step) => (
                    <li className="flex flex-col gap-1.5 border-t border-phx-line px-4 py-2" key={step}>
                      <span className="min-w-0 break-words text-sm font-bold text-phx-ink">{arrangedStepLabel(step)}</span>
                      <div className="flex flex-wrap gap-1.5">
                        {ARRANGED_PACKAGES.filter((pack) => mayArrange(step, pack)).map((pack) => (
                          <Button
                            className="h-8 gap-1"
                            disabled={busy}
                            key={pack}
                            onClick={() => add(pack, step)}
                            size="xs"
                            type="button"
                            variant="outline"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            {PACKAGE_TITLES[pack]}
                          </Button>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button className="h-9 gap-1.5" disabled={busy || !dirty} onClick={() => save(draft)} type="button">
          <Save className="h-4 w-4" />
          {busy ? "Saving" : "Save the arrangement"}
        </Button>
        <Button
          className="h-9 gap-1.5"
          disabled={busy || !dirty}
          onClick={() => change(saved)}
          type="button"
          variant="outline"
        >
          Undo changes
        </Button>
        <Button
          className="h-9 gap-1.5"
          disabled={busy || (isStandard && !arranged)}
          onClick={() => save({ leaver: null, newHire: null })}
          type="button"
          variant="ghost"
        >
          <RotateCcw className="h-4 w-4" />
          Put back the standard order
        </Button>
        {dirty ? <span className="text-phx-xs font-bold text-phx-warn">Not saved yet</span> : null}
      </div>
    </div>
  );
}
