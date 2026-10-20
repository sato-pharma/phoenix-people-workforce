# The HR Section Head flow — WhatsApp and the careers form

Owner's decisions, 2026-10-06. The rule bullet in `.claude/rules/recruitment.md` is the cue; this is the account.

## What the applicant is asked

1. What are you applying for? (taps **HR Section Head** — it took the row Finance held on the full 10-row list; Finance stays addable on the Screening Questions screen.)
2. What did you graduate in? (the built-in background question; the seat was added to its audience.)
3. **Are you based in Cairo?** `oc_cairo` (shared with Office Coordinator since 20 Oct 2026; it was `hrsh_cairo`) — **No ends the conversation.** Yes asks `hrsh_residence` (current area of residence).
4. `field_age_band` — how old are you (shared; it was `hrsh_age_band`, the same five bands).
5. `hr_ats_experience` and `hr_medrep_hiring` — the recruitment-system and medical-rep hiring questions, shared with Talent Acquisition and asked to every applicant since 20 Oct 2026 (they were the `hrsh_*` twins, asked only after a Yes to `hrsh_pharma`).
6. `hrsh_pharma` — experience in pharmaceutical companies (no longer gates anything).
7. `hrsh_current_salary` — current monthly net salary, typed.
8. `oc_start_date` — when could you start (shared; it was `hrsh_start_date`).

**One question, one name (owner, 2026-10-20; migration `20261020020000_ats_recruitment_one_question_one_name`).** The five twins were retired (`is_active = false`, never deleted) and their key rewritten in every stored answer, chat and `show_if`. The order follows `sort_order`, so the shared questions sit where their rows sit; `hrsh_residence` moved to sort 1 so it still follows Cairo.

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

## The stored rule's key spelling — a defect found 2026-10-06

The `show_if` column holds `{"question_key": "...", "values": [...]}` (its CHECK requires `question_key`), but the code's rule is `{questionKey, values}`. The loaders passed the raw column through, so `rule.questionKey` was `undefined`, the rule never matched, and **the three follow-ups (residence, medical-rep hiring, recruitment system) were never asked on WhatsApp or the careers form** — and the Screening Questions screen's save would have refused, because validation read the same missing key. Every unit test had been written in the camelCase shape, so all stayed green; the live form schema (`showIf.fieldKey` read `extra:undefined`) is what showed it.

Every reader now goes through `showIfFromRow` (`whatsapp-screening-questions.ts`), which reads either spelling and treats a malformed rule as no rule. `tests/whatsapp-screening-conditional-flow.test.ts` runs the migration's own `show_if` literals through it and checks both loaders call it. A new reader of the column must do the same.
