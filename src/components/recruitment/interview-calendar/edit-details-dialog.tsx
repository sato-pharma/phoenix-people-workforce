"use client";

// Edit the details of an interview already on the calendar — the owner, 2026-09-26: "I want to be
// able to edit or add or remove information … I forgot to add a WhatsApp number … now I can't add
// it", and "choose the interviewer for historical interviews".
//
// It changes only WHO, never WHEN or WHERE: the interviewer, and — for someone from outside Phoenix
// kept on the calendar — their name, phone and e-mail. It touches no date, time, platform or Zoom
// meeting, so it works on a PAST interview the Move pop-up would refuse (that one only offers days
// still to come). Moving an interview stays the job of Move.

import { Loader2, Save } from "lucide-react";
import { useState } from "react";

import { Action } from "@/components/recruitment/workstation/workstation-look";
import type { InterviewBooking } from "@/lib/recruitment/interview-calendar-types";

import { type CalendarApi, reasonText } from "./calendar-api";
import { CalendarDialog, PanelHeading } from "./calendar-dialog";
import { InterviewerPicker, type ChosenInterviewer } from "./interviewer-picker";
import { OrgFields } from "./org-fields";
import { PanelPicker } from "./panel-picker";
import { phxFieldClassName, phxLabelClassName, phxLabelTextClassName } from "@/components/ui/form-tokens";

const inputClass = `${phxFieldClassName} mt-1 block`;

export function EditInterviewDetailsDialog({
  api,
  booking,
  onClose,
  onSaved,
}: {
  api: CalendarApi;
  booking: InterviewBooking;
  onClose: () => void;
  onSaved: (booking: InterviewBooking) => void;
}) {
  // Someone from outside Phoenix kept on the calendar: their contact details live on the booking, so
  // they are editable here. A Recruitment candidate's live on their candidate record instead.
  const isExternal = !booking.candidateId;
  const [interviewer, setInterviewer] = useState<ChosenInterviewer | null>(
    booking.interviewerHrId ? { hrId: booking.interviewerHrId, name: booking.interviewerName ?? booking.interviewerHrId } : null,
  );
  const [panel, setPanel] = useState<ChosenInterviewer[]>(booking.panelists.map((member) => ({ hrId: member.hrId, name: member.name })));
  const [area, setArea] = useState(booking.area ?? "");
  const [line, setLine] = useState(booking.line ?? "");
  const [jobTitle, setJobTitle] = useState(booking.jobTitle ?? "");
  const [name, setName] = useState(isExternal ? booking.candidateName : "");
  const [phone, setPhone] = useState(booking.externalPhone ?? "");
  const [email, setEmail] = useState(booking.externalEmail ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Choosing the interviewer auto-fills the area & line from their own seat; both stay editable.
  function chooseInterviewer(person: ChosenInterviewer | null) {
    setInterviewer(person);
    if (person?.area || person?.line) {
      setArea(person.area ?? "");
      setLine(person.line ?? "");
    }
  }

  const problem = isExternal && name.trim().length < 2 ? "Write the person's name." : null;

  async function save() {
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        interviewerHrId: interviewer?.hrId ?? null,
        panelistHrIds: panel.map((member) => member.hrId),
        area: area.trim() || null,
        line: line.trim() || null,
        jobTitle: jobTitle.trim() || null,
      };
      if (isExternal) body.external = { email: email.trim(), name: name.trim(), phone: phone.trim() };
      const data = await api.patch(`/bookings/${encodeURIComponent(booking.id)}`, body);
      onSaved(data.booking as InterviewBooking);
      onClose();
    } catch (reason) {
      setError(reasonText(reason, "The details could not be saved."));
      setBusy(false);
    }
  }

  return (
    <CalendarDialog
      eyebrow="Edit details"
      footer={
        <>
          <p className="min-w-0 break-words text-[12px] text-slate-600">
            {error ? <span className="font-semibold text-red-700">{error}</span> : problem ? problem : "Only who is interviewed and who conducts it — not the time or place."}
          </p>
          <div className="flex shrink-0 justify-end gap-2">
            <Action onClick={onClose} size="md" tone="quiet">
              Cancel
            </Action>
            <Action disabled={busy || problem !== null} onClick={() => void save()} size="md" tone="primary">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save
            </Action>
          </div>
        </>
      }
      onClose={onClose}
      sub={booking.candidateName}
      title="Edit details"
      width="sm"
      z={240}
    >
      <div className="flex flex-col gap-4">
        {isExternal ? (
          <div className="flex flex-col gap-2.5">
            <PanelHeading>Person from outside</PanelHeading>
            <label className="block">
              <span className={phxLabelTextClassName}>Name</span>
              <input autoComplete="off" className={inputClass} maxLength={200} onChange={(event) => setName(event.target.value)} value={name} />
            </label>
            <div className="grid gap-2.5 sm:grid-cols-2">
              <label className="block">
                <span className={phxLabelTextClassName}>Phone / WhatsApp (optional)</span>
                <input
                  autoComplete="off"
                  className={inputClass}
                  dir="ltr"
                  inputMode="tel"
                  maxLength={40}
                  onChange={(event) => setPhone(event.target.value)}
                  placeholder="01xxxxxxxxx"
                  value={phone}
                />
              </label>
              <label className="block">
                <span className={phxLabelTextClassName}>E-mail (optional)</span>
                <input
                  autoComplete="off"
                  className={inputClass}
                  inputMode="email"
                  maxLength={200}
                  onChange={(event) => setEmail(event.target.value)}
                  value={email}
                />
              </label>
            </div>
          </div>
        ) : (
          <p className="border-l-[3px] border-l-slate-300 bg-slate-50 px-3 py-2 text-[12px] leading-5 text-slate-600">
            This person is a Recruitment candidate — their name, phone and e-mail are changed on their candidate record.
          </p>
        )}

        <div>
          <p className={phxLabelClassName}>Interviewer (optional)</p>
          <InterviewerPicker api={api} onChange={chooseInterviewer} value={interviewer} />
          <p className="mt-1 text-[11px] text-slate-500">Choosing the interviewer fills in the area & line below — you can change them.</p>
        </div>

        <OrgFields api={api} area={area} jobTitle={jobTitle} line={line} onArea={setArea} onJobTitle={setJobTitle} onLine={setLine} />

        <div>
          <p className={phxLabelClassName}>Panel (optional)</p>
          <PanelPicker api={api} excludeHrId={interviewer?.hrId ?? null} onChange={setPanel} value={panel} />
          <p className="mt-1 text-[11px] text-slate-500">Anyone added here also sees the interview on their own calendar. The interviewer above records how it went.</p>
        </div>
      </div>
    </CalendarDialog>
  );
}
