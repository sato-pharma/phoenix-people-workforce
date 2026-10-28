"use client";

// The job-title catalogue.
//
// Cost of living is flat PER TITLE, never per person — that is the rule the owner's signed offers
// establish, and it is the whole reason one typed number produces the entire compensation table.
// This screen is where a new title and its allowance are added, which was the owner's own ask:
// "make everything editable to add, for example, job title and add its cost of living."

import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { useState } from "react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import {
  offerHintClassName,
  offerInputClassName,
  offerLabelClassName,
  offerMoney,
  offerTextareaClassName,
} from "@/components/offers/offer-ui";
import { offerCostOfLivingDrift } from "@/lib/offers/cost-of-living-agreement";
import type { OfferJobTitle, OfferTemplate } from "@/lib/offers/types";

type Draft = {
  contractTerm: string;
  costOfLiving: string;
  reportsTo: string;
  roleSummary: string;
  templateId: string;
  title: string;
};

const BLANK: Draft = {
  contractTerm: "",
  costOfLiving: "",
  reportsTo: "",
  roleSummary: "",
  templateId: "",
  title: "",
};

/**
 * What has been typed into a row and not yet saved.
 *
 * A partial rather than a full copy of the row: an absent key means "not touched", and the PATCH
 * sends only the keys that are present. Sending the whole row would make saving a cost-of-living
 * figure also rewrite the letter binding to whatever the select happened to be showing, which is
 * the silent-erase shape this codebase has been bitten by before.
 */
type RowEdit = { costOfLiving?: string; roleSummary?: string; templateId?: string };

/** The picker's "no preference" option. Empty string, normalised to null by the route. */
const NO_TEMPLATE = "";

/**
 * The one sentence that explains the whole mechanism, written for whoever is hiring rather than for
 * an engineer — this box is the answer to "the letter talks about sales and I am hiring a recruiter".
 */
const ROLE_SUMMARY_HINT =
  "The paragraph after the greeting, in this position's own words. This is where a letter stops "
  + "talking about districts and sales to somebody who will not be doing either — one design serves "
  + "every position, and the position supplies its words. Write {{territory}} where the candidate's "
  + "own area should appear. Leave it empty for the standard sentence.";

const ROLE_SUMMARY_PLACEHOLDER =
  "Throughout our selection process you demonstrated… and we would like you to bring both to {{territory}}.";

export function OfferJobTitleCatalogue({
  canDelete,
  canManage,
  jobTitles,
  onJobTitles,
  onReport,
  templates,
}: {
  /**
   * `offers:delete`, which HR Advisory does not hold — she can add a title and change a
   * figure but not retire a title. Separate from `canManage` so the button matches the route.
   */
  canDelete: boolean;
  canManage: boolean;
  jobTitles: OfferJobTitle[];
  onJobTitles: (titles: OfferJobTitle[]) => void;
  onReport: (message: string | null, kind: "error" | "success") => void;
  templates: OfferTemplate[];
}) {
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});

  /**
   * Whether the figure being typed for a NEW title disagrees with what payroll pays on it.
   * Computed on every keystroke rather than on save, so the sentence appears while the number is
   * still being decided instead of after it has been stored.
   */
  const newTitleCostOfLivingDrift = offerCostOfLivingDrift({
    costOfLiving: draft.costOfLiving,
    jobTitle: draft.title,
  });
  const [busy, setBusy] = useState<string | null>(null);

  const defaultTemplateName = templates.find((template) => template.isDefault)?.name ?? "the default";

  function editRow(id: string, patch: RowEdit) {
    setEdits((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  }

  /** The template a row is currently showing — its unsaved choice if there is one, else what is stored. */
  function rowTemplateId(row: OfferJobTitle): string {
    return edits[row.id]?.templateId ?? row.templateId ?? NO_TEMPLATE;
  }

  /**
   * The role paragraph a row is showing. Blank is a real, meaningful value here — "use the standard
   * sentence" — so the box is left EMPTY rather than prefilled with that sentence's text: filling it
   * in would turn the next Save into a decision nobody made, and then rewording the standard sentence
   * would stop reaching this title for ever.
   */
  function rowRoleSummary(row: OfferJobTitle): string {
    return edits[row.id]?.roleSummary ?? row.roleSummary ?? "";
  }

  async function call(url: string, method: string, body?: unknown) {
    const response = await fetch(url, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method,
    });
    const payload = (await response.json().catch(() => ({}))) as { message?: string; success?: boolean };
    if (!response.ok || payload.success === false) {
      throw new Error(payload.message || "That did not work.");
    }
    return payload as Record<string, unknown>;
  }

  async function addTitle() {
    const title = draft.title.trim();
    if (!title) {
      onReport("Type the job title first.", "error");
      return;
    }
    setBusy("add");
    try {
      const payload = await call("/api/offers/job-titles", "POST", {
        contractTerm: draft.contractTerm.trim() || null,
        costOfLiving: Number(draft.costOfLiving || 0),
        reportsTo: draft.reportsTo.trim() || null,
        roleSummary: draft.roleSummary.trim() || null,
        templateId: draft.templateId || null,
        title,
      });
      onJobTitles([...jobTitles, payload.jobTitle as OfferJobTitle].sort((a, b) => a.title.localeCompare(b.title)));
      setDraft(BLANK);
      onReport(`"${title}" added.`, "success");
    } catch (error) {
      onReport(error instanceof Error ? error.message : "Could not add that job title.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function saveRow(row: OfferJobTitle) {
    const pending = edits[row.id];
    if (!pending) return;

    // Only what was actually touched. An untouched key must not appear in the body at all — the
    // route treats an absent key as "leave it alone" and an explicit null as "clear it", and those
    // have to stay different or saving one field quietly wipes the other.
    const body: Record<string, unknown> = {};
    const said: string[] = [];

    if (pending.costOfLiving !== undefined) {
      const value = Number(pending.costOfLiving);
      if (!Number.isFinite(value) || value < 0) {
        onReport("The cost of living must be a number, zero or more.", "error");
        return;
      }
      body.costOfLiving = value;
      said.push(`cost of living EGP ${offerMoney(value)}`);
    }

    if (pending.templateId !== undefined) {
      body.templateId = pending.templateId || null;
      const chosen = templates.find((template) => template.id === pending.templateId);
      said.push(chosen ? `letter design "${chosen.name}"` : "letter design back to the default");
    }

    if (pending.roleSummary !== undefined) {
      const trimmed = pending.roleSummary.trim();
      body.roleSummary = trimmed === "" ? null : trimmed;
      said.push(trimmed === "" ? "the letter's wording back to the standard paragraph" : "what the letter says this job is");
    }

    setBusy(row.id);
    try {
      const payload = await call(`/api/offers/job-titles/${row.id}`, "PATCH", body);
      onJobTitles(jobTitles.map((t) => (t.id === row.id ? (payload.jobTitle as OfferJobTitle) : t)));
      setEdits((current) => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
      onReport(`${row.title} — ${said.join(" and ")} saved.`, "success");
    } catch (error) {
      onReport(error instanceof Error ? error.message : "Could not save that change.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function removeTitle(row: OfferJobTitle) {
    setBusy(row.id);
    try {
      await call(`/api/offers/job-titles/${row.id}`, "DELETE");
      onJobTitles(jobTitles.filter((t) => t.id !== row.id));
      onReport(`"${row.title}" removed. Offers already issued are unaffected.`, "success");
    } catch (error) {
      onReport(error instanceof Error ? error.message : "Could not remove that job title.", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <AdminTableShell
        description={`Cost of living is flat per title, each title can open its offers on its own letter design, and each one says in its own words what the job is. Change any of them here and every new offer for that title picks it up — offers already issued keep what they were sent with. A title left on "${defaultTemplateName}" follows the default, so moving the default moves it too. The Letter Designer has no filter by position on purpose: it designs the LOOK, and this screen holds the WORDS.`}
        title="Job titles, cost of living, letter design and wording"
      >
        {/* Desktop: the full table. Mobile gets cards below — the admin shell never shows a table
            on a phone. */}
        {/*
          Fits-the-screen golden rule (AGENTS.md §4). This was `overflow-x-auto` over a
          `min-w-[900px]` floor — wider than the content column at 768px (where the sidebar first
          appears) or in a 1024px window, so the cost-of-living input and the Save/Remove buttons
          sat behind a sideways scroll on a laptop.

          Fixed by MERGING columns, which is what the rule asks for — never by shrinking type.
          "Reports to" and "Contract" were two narrow text columns describing the title in the
          first column; they are now a second line inside it, taking six columns down to four.

          The `<select>` keeps its `min-w-[220px]`: the rule names a native select as the one
          control that may NOT be shrunk, so the merge exists to buy it room, not to squeeze it.
          Its column is the widest share here, and the control columns drop to `px-3` so the
          padding does not eat the width the select needs. At 768px of content that is ~237px of
          usable box for a 220px control.
        */}
        <div className="hidden md:block">
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col className="w-[20%]" />
              <col className="w-[44%]" />
              <col className="w-[16%]" />
              <col className="w-[20%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-slate-200/80 bg-slate-50/60 text-left">
                <th className="break-words px-5 py-3 text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Title</th>
                <th className="break-words px-3 py-3 text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Letter design and wording</th>
                <th className="break-words px-3 py-3 text-right text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
                  Cost of living (EGP)
                </th>
                <th className="px-3 py-3" />
              </tr>
            </thead>
            <tbody>
              {jobTitles.map((row) => {
                const pending = edits[row.id];
                return (
                  <tr className="border-b border-slate-100" key={row.id}>
                    <td className="break-words px-5 py-3">
                      <span className="block font-bold text-slate-900">{row.title}</span>
                      <span className="mt-0.5 block text-xs text-slate-500">
                        Reports to {row.reportsTo || "—"} · {row.contractTerm || "—"}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <select
                        aria-label={`Letter design for ${row.title}`}
                        className={`${offerInputClassName} min-w-[220px]`}
                        disabled={!canManage || busy === row.id}
                        onChange={(event) => editRow(row.id, { templateId: event.target.value })}
                        value={rowTemplateId(row)}
                      >
                        <option value={NO_TEMPLATE}>Default — {defaultTemplateName}</option>
                        {templates.map((template) => (
                          <option key={template.id} value={template.id}>{template.name}</option>
                        ))}
                      </select>
                      <label className={`${offerLabelClassName} mt-3`} htmlFor={`role-${row.id}`}>
                        What the letter says this job is
                      </label>
                      <textarea
                        className={offerTextareaClassName}
                        disabled={!canManage || busy === row.id}
                        id={`role-${row.id}`}
                        onChange={(event) => editRow(row.id, { roleSummary: event.target.value })}
                        placeholder={ROLE_SUMMARY_PLACEHOLDER}
                        rows={4}
                        value={rowRoleSummary(row)}
                      />
                      <p className={offerHintClassName}>{ROLE_SUMMARY_HINT}</p>
                    </td>
                    <td className="px-3 py-3 text-right align-top">
                      <input
                        aria-label={`Cost of living for ${row.title}`}
                        className={`${offerInputClassName} max-w-[160px] text-right tabular-nums`}
                        disabled={!canManage || busy === row.id}
                        inputMode="numeric"
                        onChange={(event) => editRow(row.id, { costOfLiving: event.target.value })}
                        value={pending?.costOfLiving ?? String(row.costOfLiving)}
                      />
                    </td>
                    <td className="px-3 py-3 text-right">
                      {/* `flex-wrap`: if the column ever gets tighter the two buttons stack
                          instead of overflowing — wrapping is the rule's permitted answer. */}
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          disabled={!canManage || pending === undefined || busy === row.id}
                          onClick={() => void saveRow(row)}
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          {busy === row.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                          Save
                        </Button>
                        <Button
                          disabled={!canDelete || busy === row.id}
                          onClick={() => void removeTitle(row)}
                          size="sm"
                          type="button"
                          variant="destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Remove
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {jobTitles.length === 0 ? (
                <tr>
                  <td className="px-5 py-8 text-center text-slate-500" colSpan={4}>
                    No job titles yet. Add the first one below.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-3 px-5 py-5 md:hidden">
          {jobTitles.map((row) => (
            <div className="rounded-2xl border border-phx-line bg-white p-4 shadow-sm" key={row.id}>
              <p className="text-sm font-black text-slate-900">{row.title}</p>
              <p className="mt-1 text-xs text-slate-500">
                Reports to {row.reportsTo || "—"} · {row.contractTerm || "—"}
              </p>
              <div className="mt-3">
                <label className={offerLabelClassName} htmlFor={`col-${row.id}`}>
                  Cost of living (EGP)
                </label>
                <input
                  className={`${offerInputClassName} tabular-nums`}
                  disabled={!canManage || busy === row.id}
                  id={`col-${row.id}`}
                  inputMode="numeric"
                  onChange={(event) => editRow(row.id, { costOfLiving: event.target.value })}
                  value={edits[row.id]?.costOfLiving ?? String(row.costOfLiving)}
                />
              </div>
              <div className="mt-3">
                <label className={offerLabelClassName} htmlFor={`tpl-${row.id}`}>
                  Letter design
                </label>
                <select
                  className={offerInputClassName}
                  disabled={!canManage || busy === row.id}
                  id={`tpl-${row.id}`}
                  onChange={(event) => editRow(row.id, { templateId: event.target.value })}
                  value={rowTemplateId(row)}
                >
                  <option value={NO_TEMPLATE}>Default — {defaultTemplateName}</option>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>{template.name}</option>
                  ))}
                </select>
              </div>
              <div className="mt-3">
                <label className={offerLabelClassName} htmlFor={`role-m-${row.id}`}>
                  What the letter says this job is
                </label>
                <textarea
                  className={offerTextareaClassName}
                  disabled={!canManage || busy === row.id}
                  id={`role-m-${row.id}`}
                  onChange={(event) => editRow(row.id, { roleSummary: event.target.value })}
                  placeholder={ROLE_SUMMARY_PLACEHOLDER}
                  rows={4}
                  value={rowRoleSummary(row)}
                />
                <p className={offerHintClassName}>{ROLE_SUMMARY_HINT}</p>
              </div>
              <div className="mt-3 flex gap-2">
                <Button
                  disabled={!canManage || edits[row.id] === undefined || busy === row.id}
                  onClick={() => void saveRow(row)}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  <Save className="h-3.5 w-3.5" /> Save
                </Button>
                <Button
                  disabled={!canDelete || busy === row.id}
                  onClick={() => void removeTitle(row)}
                  size="sm"
                  type="button"
                  variant="destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      </AdminTableShell>

      <AdminTableShell
        description="A new title becomes available to every offer immediately. Reports-to, contract term, the letter design and the wording below are all prefilled into the offer form when the title is chosen."
        title="Add a job title"
      >
        <div className="grid gap-4 px-5 py-5 sm:px-6 md:grid-cols-2 xl:grid-cols-4">
          <div>
            <label className={offerLabelClassName} htmlFor="new-title">Job title</label>
            <input
              className={offerInputClassName}
              disabled={!canManage}
              id="new-title"
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              placeholder="Product Manager"
              value={draft.title}
            />
          </div>
          <div>
            <label className={offerLabelClassName} htmlFor="new-col">Cost of living (EGP)</label>
            <input
              className={`${offerInputClassName} tabular-nums`}
              disabled={!canManage}
              id="new-col"
              inputMode="numeric"
              onChange={(event) => setDraft({ ...draft, costOfLiving: event.target.value })}
              placeholder="2500"
              value={draft.costOfLiving}
            />
            <p className={offerHintClassName}>Carved out of the total package before basic and transport are split.</p>
            {/* The same money payroll holds as `extra_cost_of_living` + `fuel_allowance`, and
                nothing used to hold the two together. The offer side is data typed here; payroll's
                is code. Change one alone and the letter and the employee record describe different
                money on a document somebody signs — with no error anywhere, because each side stays
                internally consistent. It FLAGS and never refuses: a figure the owner means to change
                is legitimate, and only the silent drift is not. */}
            {newTitleCostOfLivingDrift ? (
              <p className="mt-1 whitespace-normal break-words rounded-md bg-amber-50 px-2 py-1 text-xs font-bold text-amber-900">
                {newTitleCostOfLivingDrift}
              </p>
            ) : null}
          </div>
          <div>
            <label className={offerLabelClassName} htmlFor="new-reports">Reports to</label>
            <input
              className={offerInputClassName}
              disabled={!canManage}
              id="new-reports"
              onChange={(event) => setDraft({ ...draft, reportsTo: event.target.value })}
              placeholder="Marketing Manager"
              value={draft.reportsTo}
            />
          </div>
          <div>
            <label className={offerLabelClassName} htmlFor="new-term">Contract term</label>
            <input
              className={offerInputClassName}
              disabled={!canManage}
              id="new-term"
              onChange={(event) => setDraft({ ...draft, contractTerm: event.target.value })}
              placeholder="One year, renewable"
              value={draft.contractTerm}
            />
          </div>
          <div>
            <label className={offerLabelClassName} htmlFor="new-template">Letter design</label>
            <select
              className={offerInputClassName}
              disabled={!canManage}
              id="new-template"
              onChange={(event) => setDraft({ ...draft, templateId: event.target.value })}
              value={draft.templateId}
            >
              <option value={NO_TEMPLATE}>Default — {defaultTemplateName}</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>{template.name}</option>
              ))}
            </select>
            <p className={offerHintClassName}>Left on the default, this title follows whichever design is the default.</p>
          </div>
          <div className="md:col-span-2 xl:col-span-4">
            <label className={offerLabelClassName} htmlFor="new-role">What the letter says this job is</label>
            <textarea
              className={offerTextareaClassName}
              disabled={!canManage}
              id="new-role"
              onChange={(event) => setDraft({ ...draft, roleSummary: event.target.value })}
              placeholder={ROLE_SUMMARY_PLACEHOLDER}
              rows={4}
              value={draft.roleSummary}
            />
            <p className={offerHintClassName}>{ROLE_SUMMARY_HINT}</p>
          </div>
          <div className="md:col-span-2 xl:col-span-4">
            <Button disabled={!canManage || busy === "add"} onClick={() => void addTitle()} size="lg" type="button">
              {busy === "add" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add job title
            </Button>
          </div>
        </div>
      </AdminTableShell>
    </div>
  );
}
