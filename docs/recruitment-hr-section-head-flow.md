# The HR Section Head flow — WhatsApp and the careers form

Owner's decisions, 2026-10-06. The rule bullet in `.claude/rules/recruitment.md` is the cue; this is the account.

## What the applicant is asked

1. What are you applying for? (taps **HR Section Head** — it took the row Finance held on the full 10-row list; Finance stays addable on the Screening Questions screen.)
2. What did you graduate in? (the built-in background question; the seat was added to its audience.)
3. **Are you based in Cairo?** `hrsh_cairo` — **No ends the conversation.** Yes asks `hrsh_residence` (current area of residence).
4. `hrsh_age_band` — how old are you.
5. `hrsh_pharma` — experience in pharmaceutical companies. **Yes** asks `hrsh_medrep_hiring` and `hrsh_ats_experience`; **No** skips both.
6. `hrsh_current_salary` — current monthly net salary, typed.
7. `hrsh_start_date` — when could you start.

The built-in `experience` and `salary` audiences are explicit lists of every role **except** `hr_section_head` (its pharma and current-salary questions replace them); `region` and `area` were already sales-only. **A role added later must be added to the `experience` and `salary` audience lists to be asked them**, exactly as it has to be for `background`.

## The two generic rules it runs on

Migration `20261006120000_ats_screening_questions_conditional_flow`, columns on `ats_whatsapp_screening_questions`:

- `show_if {question_key, values}` — ask the question only after that answer was one of those option **codes** (never titles, so a retitle cannot break it). An applicant who never answered the controlling question is not asked.
- `end_on {values, message}` — tapping one of those answers **ends the conversation** and sends `message` instead of the closing summary. The answers so far are still recorded and the owner is still told, as for a finished conversation.

The Cairo thank-you is the **only** rejection notice the owner allowed to go out automatically (his words, 2026-10-06: the Cairo thank-you may go automatically). Every other rejection stays manual. The message is editable on the Screening Questions screen.

## The careers form (satopharma.com/careers)

The page renders the schema from `GET /api/public/apply?role=hr_section_head` and posts to `POST /api/public/apply`; both are built in `src/lib/recruitment/inbound/website-apply.ts`. The role key `hr_section_head` is registered there, so the form is whatever the WhatsApp bot would ask this seat — nothing is listed twice.

- A field can carry `showIf {fieldKey, values}` and `endOn {values, message}`. **The server enforces both**, so a page that draws every field still posts a form that is read correctly: an answer to a follow-up that is not shown is dropped, and the first ending answer stops the reading — a forged later answer is never stored.
- The ending question is **required**: left optional, an applicant outside the requirement could skip it.
- An ended application is **recorded** (the CV stays on file) and the response carries `{ ok: true, message }`; **no confirmation e-mail is sent**, because "we received your application" would contradict the message just shown. Only the WhatsApp Cairo thank-you was approved to go out on its own.
- Experience and salary are required only where the role's own form carries them, so every other position is unchanged.
- Counts: `app/api/public/apply/counts/route.ts` recognises the seat by title through its own matcher.
