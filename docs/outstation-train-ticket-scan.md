# The train ticket is read when it is attached

Owner, 2026-11-07: "if someone choose that travel is train, when he capture or upload the ticket the ticket
is scanned and date is checked in arrival or departure photo; if cannot read, not accept the ticket and tell
them why", then "tell him zoom in or out, centre the ticket; the system tells them what he really needs to
be able to read the ticket".

## The rule

- **Train only.** A bus ticket, an extra ticket and a journey-stop ticket are not read.
- **What must be read:** the travel date printed on the ticket. The stations and the train number are kept
  when readable.
- **Accepted dates:**
  - The arrival photo's Cairo day, or the day before it (a night train arrives the next morning). With no
    arrival photo (a waived role), the trip's first day stands in.
  - The departure photo's day, for the return ticket. Until the departure photo exists, the trip's last day
    stands in.
- **A refused ticket says why, then what to change, then what the system needs**, one instruction per photo
  problem: zoom in, zoom out, centre the ticket, hold still and focus, more light, tilt against glare, hold
  it straight, show the date, or "this is not a train ticket".
- **A refused ticket never blocks the claim.** The claim still submits without it and is held for its
  missing ticket (`.claude/rules/expenses.md`, the missing-ticket rule of 2026-10-22 / 2026-10-27).
- **A reader outage never refuses anyone.** No key, a failed call or an answer that is not JSON keeps the
  ticket, marked "not read", for the approver to check by eye.
- **The screen never says a model read it** — "scanned" or "read" only.

## How it works

- `src/lib/outstation/ticket-scan-rules.ts` — pure and client-safe: the problems, the guidance, the date
  judge (`judgeTrainTicket`), the refusal sentence.
- `src/lib/outstation/ticket-scan.ts` — server: `readTrainTicket` through the one AI door, the signed note,
  and `checkTrainTicketsOnServer`.
- `POST /api/outstation/ticket-scan` — reads one ticket the moment it is picked and returns the read, the
  verdict and a signed note (`ts1.<body>.<sig>`, HMAC keyed from `PHOENIX_AUTH_SECRET`). The note is bound
  to the file's SHA-256, the employee's HR id and one day. The route stores nothing. With `requestId` it
  judges against the caller's own claim (arrival and departure photos); otherwise against the wizard's
  arrival photo time and trip days.
- The phone prepares the file ONCE and sends those exact bytes with the note, because a second canvas
  re-encode could differ by a byte and void the note.
- **The server judges again** on the submit, the offline replay and the late upload, before the claim moves
  or any file is stored. A missing, expired, edited or mismatched note means the server reads the file
  itself.
- **The offline replay drops a refused ticket** (`dropRefusedTrainTickets` on `syncOfflineOutstationRequest`)
  instead of failing the claim: it has no screen to say why on, so the claim lands, is held for its ticket,
  and the "Ticket missing" card asks again with the reason.
- What was read is kept on the ticket's metadata row (`scan`: date, stations, train number, what it matched,
  the line shown).

Pinned by `tests/outstation-train-ticket-scan.test.ts`.
