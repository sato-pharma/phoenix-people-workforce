"use client";

import { useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";

import { AdminSectionHeader, adminPanelClassName } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { cn } from "@/lib/utils";

/**
 * Approval emails that used every outbox retry (REC-048, durable-email.ts). Each one is an email
 * nobody received; "Send again" puts it back in the queue and the next drain run sends it with the
 * same recipients and content. The list is a stack of rows, never a table, so it fits a phone.
 */

export type ExhaustedApprovalEmailView = {
  attempts: number;
  createdAt: string;
  id: string;
  label: string;
  lastError: string | null;
  lastTriedAt: string;
  recipients: string[];
  subject: string | null;
};

export function ExhaustedApprovalEmails({ initialEmails }: { initialEmails: ExhaustedApprovalEmailView[] | null }) {
  const [emails, setEmails] = useState(initialEmails ?? []);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function sendAgain(email: ExhaustedApprovalEmailView) {
    setBusyId(email.id);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/email-notifications/outbox/${encodeURIComponent(email.id)}/send-again`, {
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) throw new Error(payload?.message ?? "This email could not be sent again.");
      setEmails((current) => current.filter((item) => item.id !== email.id));
      setNotice(`${email.subject ?? "The email"} is back in the queue — it goes out on the next run, within five minutes.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "This email could not be sent again.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
      <AdminSectionHeader
        description="Approval emails the provider refused on every retry. Send again puts one back in the queue with the same recipients and content."
        title="Approval Emails Not Delivered"
      />
      {initialEmails === null ? (
        <p className="bg-white p-4 text-sm font-bold text-phx-ink-soft">This list is unavailable right now — the outbox could not be read.</p>
      ) : emails.length === 0 ? (
        <p className="bg-white p-4 text-sm text-phx-ink-soft">Every approval email has been delivered or is still being retried.</p>
      ) : (
        <ul className="divide-y divide-phx-line">
          {emails.map((email) => (
            <li className="flex flex-col gap-3 bg-white p-4 md:flex-row md:items-start md:justify-between" key={email.id}>
              <div className="min-w-0 space-y-1">
                <p className="break-words text-sm font-black text-phx-ink">{email.subject ?? email.label}</p>
                <p className="break-words text-sm text-phx-ink-soft">To: {email.recipients.length ? email.recipients.join(", ") : "the template's own recipients"}</p>
                <p className="text-sm text-phx-ink-soft">
                  Tried {email.attempts} times · last try {cairoDateTime(email.lastTriedAt)} · first queued {cairoDateTime(email.createdAt)}
                </p>
                {email.lastError ? <p className="break-words text-sm text-phx-ink-soft">Last error: {email.lastError}</p> : null}
              </div>
              <Button
                className="shrink-0"
                disabled={busyId !== null}
                onClick={() => void sendAgain(email)}
                type="button"
              >
                {busyId === email.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
                Send again
              </Button>
            </li>
          ))}
        </ul>
      )}
      {notice ? <p className="border-t border-phx-line bg-white px-4 py-3 text-sm font-bold text-phx-ink">{notice}</p> : null}
    </Card>
  );
}
