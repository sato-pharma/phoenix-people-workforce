# Job Offers page — the list search, the form sections and the pinned Save and Send

**Owner, 10 Nov 2026:** "premium polish the page godmode design and ease and perfection".

Measured on production before the change: the page was about 25,000px tall, because all 86 offers stacked
as cards with no way to find a name except scrolling. The form was one unbroken run of eighteen fields,
"Email address" sat alone with an empty space beside it, and Save draft / Send offer were only in the
form's header, about 2,700px above the last field. The active tab was an orange gradient pill with a glow
shadow; the sibling hiring screen, Hiring Documents, uses a flat underline.

## What changed

- **The Offers list** has a search box (candidate name, email, job title or reference; every word typed
  must appear; case, accents and extra spaces do not matter) and a status filter with the count of each
  status. Statuses with no offers are hidden. It shows 20 offers, then **Show 20 more**, with a "Showing X
  of Y" line. A search with no result says so instead of "No offers yet". The table and the phone cards
  both draw the same page. Pure logic: `src/lib/offers/list-filter.ts`.
- **The form** is split by five numbered headings: 1 Candidate, 2 The email, 3 The job, 4 Reference and
  dates, 5 Pay and letter design. A heading is type and a hairline only. No field moved or changed.
- **Save and Send** are also in a bar pinned to the bottom of the screen while the form is on screen. It
  sits inside a wrapper that ends with the form, so once the form has scrolled past, the bar settles
  under it and never covers the preview or the list. It is the same buttons (`composerActions`), so the
  approval wording ("Send for approval", "Approve and send", "Send updated offer") is identical in both.
- **Restraint:** the tabs are the Hiring Documents underline; the letter preview, the pay boxes and the
  phone cards lost their drop shadows.
- **The seat line tells the truth.** Every accepted offer read "Seat: no longer open — choose it again on
  Add Employee", although its own hire had filled the seat. Now: "filled by this hire" when the offer
  produced an employee; "no longer open" for a declined or withdrawn one; the "choose it again" advice only
  on a sent offer, where it is still something to do.
- **The phone card reads in order:** name and status, then the job, then email, CC and seat; under a
  hairline, Package, Sent and Sent by as one labelled strip (they were three loose lines, and the date had
  no label).
- **An empty form's pay boxes show a dash**, not four boxes of "EGP 0".
- **The letter designer's sample lines wrap** — they were cut mid-word in the field and block lists.

Pinned by `tests/offers-page-polish.test.ts`.
