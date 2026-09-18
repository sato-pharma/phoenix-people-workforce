"use client";

// The Schedule interview button, for any screen that shows a CV — screening, the recruitment
// profile, WhatsApp Applicants, the candidate record, the CV preview itself. The owner's words: "on
// the CV without any steps from screening or from recruitment or from WhatsApp application screening
// tab from any screen, any CV. And I have the option to schedule an interview."
//
// It draws only for someone who can book (the calendar's owner, or a person he made an editor), and
// draws nothing at all otherwise — a button that answers "Forbidden" is worse than no button. The
// question "can this person book?" is asked once per page however many buttons there are
// (`useInterviewCalendarMe`).
//
// A SCREEN WITH ITS OWN BUTTON KIT passes `renderTrigger` and draws the press in that kit — the
// screening strip's decision buttons are one shape, and a stray workstation button in the middle of
// them would read as a different kind of control. The gate and the dialog stay here either way, so
// no screen can draw the press for someone who cannot book.

import { CalendarPlus } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Action, type ActionTone } from "@/components/recruitment/workstation/workstation-look";
import { canBookInterviews, type InterviewBooking } from "@/lib/recruitment/interview-calendar-types";
import { cn } from "@/lib/utils";

import { ScheduleInterviewDialog, type ScheduleCandidate } from "./schedule-interview-dialog";
import { useInterviewCalendarMe } from "./use-interview-calendar-me";

export function ScheduleInterviewButton({
  candidate,
  className,
  label = "Schedule interview",
  onSaved,
  renderTrigger,
  size = "sm",
  tone = "quiet",
}: {
  candidate: ScheduleCandidate;
  className?: string;
  label?: string;
  onSaved?: (booking: InterviewBooking) => void;
  /** Draw the press yourself; the gate and the dialog stay here. */
  renderTrigger?: (trigger: { open: () => void; pressed: boolean; title: string }) => ReactNode;
  size?: "sm" | "md";
  tone?: ActionTone;
}) {
  const me = useInterviewCalendarMe();
  const [open, setOpen] = useState(false);
  if (!canBookInterviews(me.role)) return null;

  const title = `Schedule an interview with ${candidate.name}`;
  return (
    <>
      {renderTrigger ? (
        renderTrigger({ open: () => setOpen(true), pressed: open, title })
      ) : (
        <Action className={cn(className)} onClick={() => setOpen(true)} size={size} title={title} tone={tone}>
          <CalendarPlus className="h-3.5 w-3.5" />
          {label}
        </Action>
      )}
      {open ? (
        <ScheduleInterviewDialog
          candidate={candidate}
          onClose={() => setOpen(false)}
          onSaved={onSaved}
          zoomConnected={me.zoomConnected}
        />
      ) : null}
    </>
  );
}
