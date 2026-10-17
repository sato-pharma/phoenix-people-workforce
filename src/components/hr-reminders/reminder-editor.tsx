"use client";

import { Eye } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import { Overlay } from "@/components/hr-reminders/overlay";
import { remindersApi } from "@/components/hr-reminders/reminders-api";
import { COLOR_STYLES } from "@/components/hr-reminders/reminder-style";
import { CheckTile, FormActions, FormError, FormField } from "@/components/ui/form-kit";
import {
  phxButtonAccentClassName,
  phxButtonGhostClassName,
  phxFieldClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { parseReminderDraft } from "@/lib/hr-reminders/logic";
import {
  REMINDER_BODY_MAX,
  REMINDER_COLORS,
  REMINDER_TITLE_MAX,
  type ReminderColor,
  type ReminderView,
  type SharingKind,
  type TeamMember,
} from "@/lib/hr-reminders/types";
import { cn } from "@/lib/utils";

type Props = {
  /** The item being edited, or null for a new one. */
  initial: ReminderView | null;
  /** The day a new item starts on (the day whose "+" was pressed). */
  defaultDay: string | null;
  onClose: () => void;
  onSaved: (reminder: ReminderView) => void;
  team: TeamMember[];
  viewer: { hrId: string; isOverseer: boolean };
};

function initialSharing(initial: ReminderView | null): SharingKind {
  if (!initial) return "private";
  if (initial.shareWithTeam) return "team";
  return initial.sharedWithHrIds.length > 0 ? "people" : "private";
}

export function ReminderEditor({ defaultDay, initial, onClose, onSaved, team, viewer }: Props) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [remindOn, setRemindOn] = useState(initial ? initial.remindOn ?? "" : defaultDay ?? "");
  const [startsAt, setStartsAt] = useState(initial?.startsAt ?? "");
  const [endsAt, setEndsAt] = useState(initial?.endsAt ?? "");
  const [color, setColor] = useState<ReminderColor>(initial?.color ?? "orange");
  const [sharing, setSharing] = useState<SharingKind>(initialSharing(initial));
  const [people, setPeople] = useState<string[]>(initial?.sharedWithHrIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const teammates = useMemo(
    () => team.filter((member) => canonicalHrIdKey(member.hrId) !== canonicalHrIdKey(viewer.hrId)),
    [team, viewer.hrId],
  );
  const overseer = team.find((member) => member.isOverseer) ?? null;

  function togglePerson(hrId: string, on: boolean) {
    setPeople((current) => {
      const key = canonicalHrIdKey(hrId);
      const without = current.filter((entry) => canonicalHrIdKey(entry) !== key);
      return on ? [...without, hrId] : without;
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const payload = {
      body,
      color,
      endsAt: endsAt || null,
      remindOn: remindOn || null,
      shareWithTeam: sharing === "team",
      sharedWithHrIds: sharing === "people" ? people : [],
      startsAt: startsAt || null,
      title,
    };
    // The server says the same sentences; saying them here first saves the round trip.
    const check = parseReminderDraft(payload);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    if (sharing === "people" && people.length === 0) {
      setError("Pick at least one teammate, or choose Only me.");
      return;
    }

    setSaving(true);
    try {
      const result = initial
        ? await remindersApi<{ reminder: ReminderView }>("PATCH", `/api/hr-reminders/${initial.id}`, payload)
        : await remindersApi<{ reminder: ReminderView }>("POST", "/api/hr-reminders", payload);
      onSaved(result.reminder);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The reminder could not be saved.");
      setSaving(false);
    }
  }

  return (
    <Overlay eyebrow="HR Reminders" onClose={onClose} title={initial ? "Edit reminder" : "New reminder"}>
      <form className="space-y-5 p-5" onSubmit={submit}>
        <FormField htmlFor="reminder-title" label="Title" required>
          <input
            autoFocus
            className={phxFieldClassName}
            id="reminder-title"
            maxLength={REMINDER_TITLE_MAX}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What needs remembering?"
            value={title}
          />
        </FormField>

        <FormField
          hint={`${body.length} of ${REMINDER_BODY_MAX} characters`}
          htmlFor="reminder-body"
          label="Details"
        >
          <textarea
            className={phxTextareaClassName}
            id="reminder-body"
            maxLength={REMINDER_BODY_MAX}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Anything the team should know. Optional."
            rows={4}
            value={body}
          />
        </FormField>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FormField htmlFor="reminder-day" label="Day" hint="Leave empty for a plain note.">
            <input
              className={phxFieldClassName}
              id="reminder-day"
              onChange={(event) => {
                setRemindOn(event.target.value);
                if (!event.target.value) {
                  setStartsAt("");
                  setEndsAt("");
                }
              }}
              type="date"
              value={remindOn}
            />
          </FormField>
          <FormField htmlFor="reminder-start" label="From">
            <input
              className={phxFieldClassName}
              disabled={!remindOn}
              id="reminder-start"
              onChange={(event) => {
                setStartsAt(event.target.value);
                if (!event.target.value) setEndsAt("");
              }}
              type="time"
              value={startsAt}
            />
          </FormField>
          <FormField htmlFor="reminder-end" label="Until">
            <input
              className={phxFieldClassName}
              disabled={!remindOn || !startsAt}
              id="reminder-end"
              onChange={(event) => setEndsAt(event.target.value)}
              type="time"
              value={endsAt}
            />
          </FormField>
        </div>

        <FormField label="Colour">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Colour">
            {REMINDER_COLORS.map((option) => {
              const style = COLOR_STYLES[option];
              const selected = color === option;
              return (
                <button
                  aria-checked={selected}
                  className={cn(
                    "inline-flex items-center gap-2 border px-3 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500",
                    selected ? "border-orange-500 bg-orange-50 text-slate-900" : "border-slate-200 bg-white text-slate-600 hover:border-slate-400",
                  )}
                  key={option}
                  onClick={() => setColor(option)}
                  role="radio"
                  type="button"
                >
                  <span aria-hidden className={cn("h-3 w-3", style.dot)} />
                  {style.label}
                </button>
              );
            })}
          </div>
        </FormField>

        <FormField label="Who can see it">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <CheckTile checked={sharing === "private"} name="sharing" onChange={() => setSharing("private")} type="radio">
              Only me
            </CheckTile>
            <CheckTile checked={sharing === "people"} name="sharing" onChange={() => setSharing("people")} type="radio">
              Chosen teammates
            </CheckTile>
            <CheckTile checked={sharing === "team"} name="sharing" onChange={() => setSharing("team")} type="radio">
              The whole team
            </CheckTile>
          </div>

          {sharing === "people" ? (
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {teammates.length === 0 ? (
                <p className="text-sm text-slate-500">There is no one else on the team yet.</p>
              ) : (
                teammates.map((member) => (
                  <CheckTile
                    checked={people.some((entry) => canonicalHrIdKey(entry) === canonicalHrIdKey(member.hrId))}
                    key={member.hrId}
                    onChange={(on) => togglePerson(member.hrId, on)}
                  >
                    <span className="min-w-0 break-words">{member.name}</span>
                  </CheckTile>
                ))
              )}
            </div>
          ) : null}

          <p className="mt-2 flex items-start gap-2 border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
            <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
            {viewer.isOverseer
              ? "As HR Manager you see every reminder on the team. This choice decides what your teammates see."
              : `${overseer ? overseer.name : "The HR Manager"} can see every reminder, whoever it is shared with.`}
          </p>
        </FormField>

        <FormError>{error}</FormError>

        <FormActions
          left={
            <button className={phxButtonGhostClassName} onClick={onClose} type="button">
              Cancel
            </button>
          }
          right={
            <button className={phxButtonAccentClassName} disabled={saving} type="submit">
              {saving ? "Saving" : initial ? "Save changes" : "Add reminder"}
            </button>
          }
        />
      </form>
    </Overlay>
  );
}
