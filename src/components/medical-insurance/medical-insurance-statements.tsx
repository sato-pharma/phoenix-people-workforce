"use client";

import { FileDown, Mail } from "lucide-react";
import * as React from "react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
import { costLetterRows, LIFE_INSURANCE_PER_PERSON_MONTHLY, type MonthlySplitRow } from "@/lib/medical-insurance/monthly-split";
import { egpWords, MEMBER_TYPE_WORDS, type MedicalInsuranceMoneyView } from "@/lib/medical-insurance/view";

import { cellClassName, downloadGot, headerClassName, SaveError, textLinkClassName } from "./medical-insurance-parts";

/** The route takes this many a press (COST_LETTER_EMAIL_BATCH, cost-letter-email.ts); a longer selection goes in turns. */
const EMAIL_BATCH = 20;
const SEND_URL = "/api/medical-insurance/cost-letter/send";

type Outcome = { memberId: string; name: string; email: string | null; status: "sent" | "not_sent"; reason: string | null };

/** What each person on the row costs the employee a month, exactly as the statement prints it. */
function monthlyLines(row: MonthlySplitRow): Array<{ key: string; name: string; as: string; plan: string; monthly: number | null }> {
  const lines: Array<{ key: string; name: string; as: string; plan: string; monthly: number | null }> = [];
  if (row.employee) {
    lines.push({ as: "Employee", key: row.employee.memberId, monthly: row.employee.monthly === null ? null : row.employeeOwnShare + LIFE_INSURANCE_PER_PERSON_MONTHLY, name: row.employee.name, plan: row.employee.category });
  }
  for (const relative of row.family) {
    lines.push({ as: MEMBER_TYPE_WORDS[relative.memberType], key: relative.memberId, monthly: relative.monthly === null ? null : relative.monthly + LIFE_INSURANCE_PER_PERSON_MONTHLY, name: relative.name, plan: relative.category });
  }
  return lines;
}

const isShort = (row: MonthlySplitRow) => monthlyLines(row).some((line) => line.monthly === null);
const memberOf = (row: MonthlySplitRow) => row.employee?.memberId ?? "";

/**
 * THE MEDICAL COVER STATEMENT, FOR EVERY EMPLOYEE (owner, 2026-11-21). Each employee on the policy is listed
 * with their grade and what they pay a month, and beside each one an Export PDF and an Email button; ticks
 * choose several to email at once. The email IS the statement, in the body of the house letter, with no
 * attachment, and goes to that employee's own work email alone. Nothing is sent until the list is confirmed.
 * Amounts only, never the split's percentages. Super Admin only: the tab rides in the money view and both
 * routes assert the same permission.
 */
export function MedicalInsuranceStatementsTab({ money }: { money: MedicalInsuranceMoneyView }) {
  const rows = React.useMemo(() => costLetterRows(money.monthlySplit.rows), [money.monthlySplit.rows]);
  const [query, setQuery] = React.useState("");
  const [ticked, setTicked] = React.useState<Set<string>>(() => new Set());
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<MonthlySplitRow[] | null>(null);
  const [progress, setProgress] = React.useState<string | null>(null);
  const [outcomes, setOutcomes] = React.useState<Outcome[] | null>(null);
  const [pdfBusy, setPdfBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const needle = query.trim().toLowerCase();
  const shown = needle ? rows.filter((row) => (row.employee?.name ?? "").toLowerCase().includes(needle)) : rows;
  const tickable = shown.filter((row) => !isShort(row));
  const allShownTicked = tickable.length > 0 && tickable.every((row) => ticked.has(memberOf(row)));
  const chosen = rows.filter((row) => ticked.has(memberOf(row)));
  const sending = progress !== null;

  function toggle(memberId: string) {
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
  }

  function toggleAllShown() {
    setTicked((current) => {
      const next = new Set(current);
      for (const row of tickable) {
        if (allShownTicked) next.delete(memberOf(row));
        else next.add(memberOf(row));
      }
      return next;
    });
  }

  async function exportPdf(row: MonthlySplitRow) {
    if (!row.employee) return;
    setPdfBusy(row.employee.memberId);
    setError(null);
    try {
      await downloadGot(`/api/medical-insurance/cost-letter?member=${encodeURIComponent(row.employee.memberId)}`, "Medical-Cover-Statement.pdf");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The statement could not be made. Try again.");
    } finally {
      setPdfBusy(null);
    }
  }

  async function sendConfirmed() {
    if (!pending) return;
    const ids = pending.map(memberOf);
    setPending(null);
    setError(null);
    setOutcomes(null);
    const all: Outcome[] = [];
    try {
      for (let start = 0; start < ids.length; start += EMAIL_BATCH) {
        const batch = ids.slice(start, start + EMAIL_BATCH);
        setProgress(`Sending ${Math.min(start + batch.length, ids.length)} of ${ids.length}`);
        const response = await fetch(SEND_URL, { body: JSON.stringify({ members: batch }), headers: { "content-type": "application/json" }, method: "POST" });
        const body = (await response.json().catch(() => null)) as { message?: string; outcomes?: Outcome[] } | null;
        if (!response.ok) throw new Error(body?.message ?? "The statements could not be sent. Try again.");
        all.push(...(body?.outcomes ?? []));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The statements could not be sent. Try again.");
    } finally {
      setProgress(null);
      setOutcomes(all);
      const sent = new Set(all.filter((outcome) => outcome.status === "sent").map((outcome) => outcome.memberId));
      setTicked((current) => new Set([...current].filter((id) => !sent.has(id))));
    }
  }

  function actions(row: MonthlySplitRow, short: boolean) {
    const memberId = memberOf(row);
    return (
      <div className="flex flex-wrap gap-2">
        <Button className="h-9 gap-1.5" disabled={short || pdfBusy !== null || sending} onClick={() => void exportPdf(row)} type="button" variant="outline">
          <FileDown className="h-4 w-4" />
          {pdfBusy === memberId ? "Preparing" : "PDF"}
        </Button>
        <Button className="h-9 gap-1.5" disabled={short || sending} onClick={() => { setOutcomes(null); setPending([row]); }} type="button">
          <Mail className="h-4 w-4" />
          Email
        </Button>
      </div>
    );
  }

  function tick(row: MonthlySplitRow, short: boolean) {
    return (
      <input
        aria-label={`Choose ${row.employee?.name ?? "this employee"} to email`}
        checked={ticked.has(memberOf(row))}
        className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-phx-accent disabled:cursor-not-allowed"
        disabled={short || sending}
        onChange={() => toggle(memberOf(row))}
        type="checkbox"
      />
    );
  }

  function person(row: MonthlySplitRow) {
    const memberId = memberOf(row);
    return (
      <>
        <p className="break-words text-sm font-black text-phx-ink" dir="auto">{row.employee?.name}</p>
        <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">
          {row.family.length === 0 ? "On their own" : row.family.length === 1 ? "With 1 family member" : `With ${row.family.length} family members`}
        </p>
        <button className={textLinkClassName} onClick={() => setOpenId(openId === memberId ? null : memberId)} type="button">
          {openId === memberId ? "Hide the amounts" : "Show the amounts"}
        </button>
      </>
    );
  }

  function total(row: MonthlySplitRow, short: boolean) {
    return short ? <span className="text-phx-xs font-bold text-phx-warn">Cannot be priced yet</span> : <span className="font-black tabular-nums text-phx-ink">{egpWords(row.employeePays)}</span>;
  }

  function detail(row: MonthlySplitRow) {
    return (
      <ul className="divide-y divide-phx-line border border-phx-line bg-white">
        {monthlyLines(row).map((line) => (
          <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2" key={line.key}>
            <span className="min-w-0">
              <span className="block break-words text-sm font-bold text-phx-ink">{line.name}</span>
              <span className="block break-words text-phx-xs font-semibold text-phx-ink-soft">{line.as} · Grade {line.plan}</span>
            </span>
            <span className="text-right text-sm font-black tabular-nums text-phx-ink">{line.monthly === null ? "Cannot be priced" : egpWords(line.monthly)}</span>
          </li>
        ))}
      </ul>
    );
  }

  const sentCount = outcomes?.filter((outcome) => outcome.status === "sent").length ?? 0;
  const notSent = outcomes?.filter((outcome) => outcome.status === "not_sent") ?? [];

  return (
    <AdminTableShell
      description="Every employee on the policy, with their grade and what they pay each month. Export a PDF to hand on, or email the statement to the employee: the email carries the whole statement in its body (no attachment) and goes to that employee's own work email, nobody else. Tick several to email them together. It shows amounts only, never how the cost is shared."
      title="Medical Cover Statement"
    >
      <div className="space-y-4 p-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <input
            aria-label="Search a name"
            className={phxFieldClassName}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search a name"
            type="search"
            value={query}
          />
          <Button className="h-10 gap-2" disabled={chosen.length === 0 || sending} onClick={() => { setOutcomes(null); setPending(chosen); }} type="button">
            <Mail className="h-4 w-4" />
            {chosen.length === 0 ? "Email the ticked" : `Email the ${chosen.length} ticked`}
          </Button>
        </div>

        {pending ? (
          <div className="space-y-3 border border-phx-accent bg-phx-accent-soft p-4">
            <p className="break-words text-sm font-black text-phx-ink">
              {pending.length === 1 ? `Email ${pending[0].employee?.name} their Medical Cover Statement?` : `Email ${pending.length} employees their Medical Cover Statements?`}
            </p>
            <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">
              Each statement goes to that employee&apos;s own work email on the Employee Master, one email each, with no copy to anyone else. Someone with no work email is listed afterwards and not sent.
            </p>
            {pending.length > 1 ? (
              <p className="break-words text-phx-xs font-semibold text-phx-ink">{pending.map((row) => row.employee?.name).join(" · ")}</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button className="h-10 gap-2" onClick={() => void sendConfirmed()} type="button">
                <Mail className="h-4 w-4" />
                {pending.length === 1 ? "Send the email" : `Send ${pending.length} emails`}
              </Button>
              <Button className="h-10" onClick={() => setPending(null)} type="button" variant="outline">
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {progress ? <p className="text-sm font-bold text-phx-ink">{progress}</p> : null}
        <SaveError error={error} />

        {outcomes && outcomes.length > 0 ? (
          <div className="space-y-2 border border-phx-line p-4">
            <p className="break-words text-sm font-black text-phx-ink">
              {sentCount === 1 ? "1 statement sent." : `${sentCount} statements sent.`}
              {notSent.length > 0 ? ` ${notSent.length} not sent.` : ""}
            </p>
            {outcomes
              .filter((outcome) => outcome.status === "sent")
              .map((outcome) => (
                <p className="break-words text-phx-xs font-semibold text-phx-ink-soft" key={outcome.memberId}>Sent to {outcome.name} at {outcome.email}</p>
              ))}
            {notSent.map((outcome) => (
              <p className="break-words text-phx-xs font-bold text-phx-warn" key={outcome.memberId}>Not sent to {outcome.name}: {outcome.reason}</p>
            ))}
          </div>
        ) : null}

        <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">
          {rows.length} employees are covered today{needle ? `, ${shown.length} match the search` : ""}.
        </p>

        {/* Desktop: the full table. */}
        <div className="hidden md:block">
          <table className="w-full table-fixed border-collapse">
            <colgroup>
              <col style={{ width: "3rem" }} />
              <col />
              <col style={{ width: "6rem" }} />
              <col style={{ width: "10rem" }} />
              <col style={{ width: "12.5rem" }} />
            </colgroup>
            <thead>
              <tr>
                <th className={headerClassName}>
                  <input aria-label="Tick everyone shown" checked={allShownTicked} className="h-5 w-5 cursor-pointer accent-phx-accent" disabled={tickable.length === 0 || sending} onChange={toggleAllShown} type="checkbox" />
                </th>
                <th className={headerClassName}>Employee</th>
                <th className={headerClassName}>Grade</th>
                <th className={cn(headerClassName, "text-right")}>A month</th>
                <th className={headerClassName}>Statement</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const short = isShort(row);
                return (
                  <React.Fragment key={row.key}>
                    <tr>
                      <td className={cellClassName}>{tick(row, short)}</td>
                      <td className={cellClassName}>{person(row)}</td>
                      <td className={cn(cellClassName, "text-sm font-bold text-phx-ink")}>{row.employee?.category}</td>
                      <td className={cn(cellClassName, "text-right text-sm")}>{total(row, short)}</td>
                      <td className={cellClassName}>{actions(row, short)}</td>
                    </tr>
                    {openId === memberOf(row) ? (
                      <tr>
                        <td className={cellClassName} />
                        <td className={cellClassName} colSpan={4}>{detail(row)}</td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Phone: one card a person. */}
        <div className="space-y-3 md:hidden">
          {tickable.length > 0 ? (
            <label className="flex items-center gap-3 text-phx-xs font-bold text-phx-ink">
              <input checked={allShownTicked} className="h-5 w-5 cursor-pointer accent-phx-accent" disabled={sending} onChange={toggleAllShown} type="checkbox" />
              Tick everyone shown
            </label>
          ) : null}
          {shown.map((row) => {
            const short = isShort(row);
            return (
              <div className="space-y-3 border border-phx-line p-3" key={row.key}>
                <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
                  {tick(row, short)}
                  <div className="min-w-0">
                    {person(row)}
                    <p className="mt-1 break-words text-sm">
                      <span className="font-bold text-phx-ink-soft">Grade {row.employee?.category} · </span>
                      {total(row, short)}
                    </p>
                  </div>
                </div>
                {openId === memberOf(row) ? detail(row) : null}
                {actions(row, short)}
              </div>
            );
          })}
        </div>
      </div>
    </AdminTableShell>
  );
}
