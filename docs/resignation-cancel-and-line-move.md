# Cancelling a resignation, and moving someone to another line

Owner decision, 4 November 2026, Cairo: "Full cancel + line move".

## What happened

Omaima Wael, a medical rep in Dokki - Mohandseen - Bolak, was entered as resigned from the Anti
Infective line. She was not leaving: she was moving to the Pedia line in the same area. The
resignation, filed from the Employees page, ended her on the spot:

- her status was set to resigned;
- payroll and the organogram were switched off;
- her login was turned off;
- her CRM id was cleared;
- her seat was vacated;
- a replacement vacancy was opened.

Cancelling a resignation on the Resignations screen only stamped the resignation row, so none of
that came back. The seat transfer also refused any seat on another line. The only route left was a
resignation followed by a re-hire, which breaks her history, her salary record and her HR ID.

## What changed

**Cancel or Reject on the Resignations screen gives the job back.** Before the row is marked
cancelled, `runResignationWorkflow` calls
`public.phx_restore_employee_after_cancelled_resignation(resignation id, actor)`. In one
transaction it:

- sets the employee to active, on payroll and on the organogram, and clears the exit fields;
- turns the login and the access profile back on;
- deletes the resignation's vacant placeholder on the seat and reopens the person's own span, so
  the seat history reads as if they never left;
- cancels the replacement vacancy;
- restores the CRM id from `employee_resignations.crm_id_before`, which the resignation now stores
  at the moment it clears it.

It refuses, and changes nothing, when:

- the resignation is completed;
- a newer exit exists;
- the employee's last working day is not this resignation's;
- the seat has gone to someone else;
- the replacement vacancy has been filled;
- the same national ID is still employed under another HR ID. The person has been re-hired, and
  giving the old record back would pay them twice (migration
  `20261104184517_restore_refuses_a_rehired_person.sql`).

That last refusal came from Omaima's own case. While this change was being built, HR re-hired
her the same evening through a new offer, as PD-0039 on the Pedia line, starting 7 November at a
new salary. The owner decided to keep PD-0039 and give it her original hire date of 17 August.
AI-0009 stays resigned, and her resignation is not cancelled.

That date lives in `src/lib/employees/continuous-service.ts`, not in `employees.hire_date`
(2026-11-05). Payroll puts a person in a month by `hire_date`, so 17 August on PD-0039 put her in
the open October run as a full employee beside AI-0009 — paid twice. `hire_date` stays 7 November,
and the link gives her portal the August and September payslips, the AI-0009 vacation history, a
"Hire date" of 17 August, and leave counted from 17 August.

A resignation that never ended anyone, for example one filed on the Resignations screen and not yet
completed, is left alone.

**A seat on another line in Transfer Seat is a line move.** The dialog lists every line's vacant
seats, each named by its line, and shows a warning when the chosen seat is on another line.
Choosing one calls `public.phx_move_employee_to_line`, which:

- sets the employee's line;
- moves the seat through `phx_transfer_au_seat`, so area, region and manager follow the seat;
- fills the destination seat's open vacancy;
- opens one vacancy for the seat left.

Salary, HR ID and history stay the same.

The same migration (`20261104174918_resignation_cancel_restores_and_line_move.sql`) took
`area_name` out of `phx_transfer_au_seat`. That column was dropped from `employees`, so every
transfer onto a seat that has an area failed with error 42703.

## Who decides

Putting a person back on pay is a money decision, so it is the Cancel click on the Resignations
screen, made by the HR Manager, and never a chat approval.

Pinned by `tests/resignation-cancel-restore.test.ts` and `tests/seat-transfer-service.test.ts`.
