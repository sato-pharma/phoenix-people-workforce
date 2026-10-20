"use client";

import * as React from "react";
import { AlertCircle, CheckCircle2, Loader2, RotateCcw } from "lucide-react";

import { AdminCallout, AdminSectionHeader } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CheckTile } from "@/components/ui/form-kit";
import { phxTextareaClassName } from "@/components/ui/form-tokens";
import {
  DEFAULT_REJECTION_MESSAGE_TEXT,
  type RecruitmentSettingsView,
} from "@/lib/recruitment/recruitment-settings-shared";

/**
 * Two recruitment settings that sit with the WhatsApp conversation they change (owner, 2026-10-20):
 *
 *   * the half-hourly re-ask — an applicant who stopped answering mid-way is asked the question they
 *     stopped on ONCE more, while WhatsApp still lets us write to them. It starts OFF and stays off
 *     until it is switched on here;
 *   * the words of the "sorry" message HR may send a rejected applicant, by its own button, never
 *     automatically.
 *
 * Each saves on its own: the switch the moment it is ticked (it is one decision), the message by its
 * own Save, like every other wording on this screen.
 */

const REJECTION_MESSAGE_MAX = 1000;

type Props = { initialSettings: RecruitmentSettingsView };

export function RecruitmentSettingsPanel({ initialSettings }: Props) {
  const [settings, setSettings] = React.useState<RecruitmentSettingsView>(initialSettings);
  const [draft, setDraft] = React.useState<string>(initialSettings.rejectionMessageText);
  const [busy, setBusy] = React.useState<"reask" | "message" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  async function post(body: Record<string, unknown>, which: "reask" | "message", successMessage: string) {
    setBusy(which);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/screening-questions/settings", {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const json = (await response.json().catch(() => ({}))) as {
        settings?: RecruitmentSettingsView;
        error?: string;
        message?: string;
      };
      if (!response.ok || !json.settings) throw new Error(json.message ?? json.error ?? `HTTP ${response.status}`);
      setSettings(json.settings);
      setDraft(json.settings.rejectionMessageText);
      setNotice(successMessage);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  const trimmed = draft.trim();
  const dirty = trimmed !== settings.rejectionMessageText.trim();
  const tooLong = trimmed.length > REJECTION_MESSAGE_MAX;

  return (
    <div className="space-y-4">
      <AdminSectionHeader
        description="Two things the bot and the recruitment team do on WhatsApp beyond the questions above: asking an applicant who stopped half-way to carry on, and the message a rejected applicant can be sent."
        title="Follow-ups on WhatsApp"
      />

      {error ? (
        <AdminCallout tone="danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </AdminCallout>
      ) : null}

      {notice ? (
        <AdminCallout tone="success">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </AdminCallout>
      ) : null}

      <Card className="p-4">
        <p className="text-sm font-semibold text-slate-800">Ask a quiet applicant again</p>
        <p className="mt-0.5 text-phx-xs text-slate-500">
          When someone stops answering half-way, the bot waits two hours, then sends the question they
          stopped on once more. Only once per conversation, and only while WhatsApp still allows a
          message (within 24 hours of their last one). Checked every half hour.
        </p>
        <CheckTile
          checked={settings.whatsAppReaskEnabled}
          className="mt-3"
          onChange={(next) =>
            void post(
              { whatsAppReaskEnabled: next },
              "reask",
              next ? "Switched on. The next half-hourly check asks the quiet applicants." : "Switched off. Nobody is asked again.",
            )
          }
        >
          <span className="flex items-center gap-2 text-sm text-slate-700">
            {busy === "reask" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {settings.whatsAppReaskEnabled ? "On: quiet applicants are asked once more" : "Off: nobody is asked again"}
          </span>
        </CheckTile>
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-800">The message to a rejected applicant</p>
            <p className="mt-0.5 text-phx-xs text-slate-500">
              Sent only when someone in the team presses &quot;Send the message&quot; on a rejected
              applicant who wrote to us on WhatsApp in the last 24 hours. Never sent by itself.
            </p>
          </div>
          <span
            className={
              settings.rejectionMessageIsDefault
                ? "bg-slate-100 px-2 py-0.5 text-phx-xs font-semibold text-slate-500"
                : "bg-orange-50 px-2 py-0.5 text-phx-xs font-semibold text-orange-700"
            }
          >
            {settings.rejectionMessageIsDefault ? "Default" : "Your wording"}
          </span>
        </div>

        <label className="mt-3 block text-phx-xs font-medium text-slate-600" htmlFor="rejection-message-text">
          What the applicant reads
        </label>
        <textarea
          className={`${phxTextareaClassName} mt-1`}
          dir="auto"
          disabled={busy === "message"}
          id="rejection-message-text"
          onChange={(event) => setDraft(event.target.value)}
          rows={5}
          value={draft}
        />
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <span className="text-phx-xs text-slate-500">
            Empty means back to the default wording. Say only what is true: no reason, no promise.
          </span>
          <span className={`text-phx-xs ${tooLong ? "text-red-600" : "text-slate-400"}`}>
            {trimmed.length} / {REJECTION_MESSAGE_MAX}
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            disabled={busy !== null || !dirty || tooLong}
            onClick={() =>
              void post(
                // Typing the default back word for word is stored as blank, so it follows the default.
                { rejectionMessageText: trimmed === DEFAULT_REJECTION_MESSAGE_TEXT ? "" : trimmed },
                "message",
                "Saved. The next message sent uses these words.",
              )
            }
            size="sm"
          >
            {busy === "message" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
            Save this message
          </Button>
          {!settings.rejectionMessageIsDefault ? (
            <Button
              disabled={busy !== null}
              onClick={() => void post({ rejectionMessageText: "" }, "message", "Back to the default wording.")}
              size="sm"
              variant="outline"
            >
              <RotateCcw className="mr-1 h-3.5 w-3.5" />
              Reset to default
            </Button>
          ) : null}
          {dirty ? <span className="text-phx-xs text-amber-600">Not saved yet</span> : null}
        </div>
      </Card>
    </div>
  );
}
