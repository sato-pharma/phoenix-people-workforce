-- WHAT:     one new table, public.ats_whatsapp_auto_replies — owner-editable wording for the SIX
--           automatic WhatsApp replies the recruitment bot sends by itself (as opposed to the six
--           screening questions, whose wording already lives in ats_whatsapp_question_prompts).
--
-- WHY:      asked on 2026-10-03 which of the WhatsApp messages he wanted reworded, the owner
--           answered: "i want to be in control to freely edit them through phoenix anytime". Until
--           now those messages lived in three source files —
--           whatsapp-text-only-applicant.ts, whatsapp-unreadable-cv.ts and
--           whatsapp-classify-menus.ts — so changing one sentence a member of the public reads cost
--           a pull request, a CI round and a production deploy. They are now one row each, edited on
--           the Screening Questions screen beside the questions, and live on the next applicant.
--
-- ROLLBACK: drop table public.ats_whatsapp_auto_replies;
--           Every message then returns to its code default with no other change — the defaults are
--           never copied in here, so dropping the table is a complete, lossless revert of the
--           wording. The only loss is whatever the owner had typed.
--
-- Purely additive: no existing row is read, rewritten or moved, and nothing outside this table
-- changes. Safe to apply before or after the code deploy — with the table absent the app's read
-- fails best-effort and every message keeps its code default, which is the behaviour before this
-- feature existed.

begin;

create table if not exists public.ats_whatsapp_auto_replies (
  reply_key text primary key,

  -- The words an applicant reads. NOT NULL here, unlike ats_whatsapp_question_prompts.body_text:
  -- that table's row also carries answer labels and an audience, so it has a reason to exist with a
  -- null body. A row here carries nothing but wording, so a null body would be a row that overrides
  -- nothing — "reset to default" is a DELETE, and the app's store does exactly that.
  body_text text not null,

  updated_by_hr_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The six automatic replies, and nothing else. Same vocabulary as AUTO_REPLY_KEYS in
  -- src/lib/recruitment/inbound/whatsapp-auto-replies.ts — one spelling, two places. A typo'd key
  -- would otherwise sit here overriding nothing at all, which on screen reads exactly like a saved
  -- edit that does not work.
  constraint ats_whatsapp_auto_replies_key_check
    check (
      reply_key in (
        'text_only_plain',
        'text_only_job_enquiry',
        'unreadable_photo',
        'unreadable_too_large',
        'closing_intro',
        'closing_outro'
      )
    ),

  -- WhatsApp refuses a text message over 4,096 characters outright — it is not truncated, the send
  -- simply fails — and the closing summary is assembled from TWO of these rows plus up to six
  -- generated answer lines. 1,500 each leaves room for both plus the summary with every block at its
  -- maximum. Mirrored in TypeScript at save time AND at read time (AUTO_REPLY_BODY_MAX), kept here
  -- too so no path can write a longer one. An empty string is refused separately: there is no
  -- "silence" state, because an applicant who sent a photo and heard nothing back is the exact
  -- failure these messages exist to prevent.
  constraint ats_whatsapp_auto_replies_body_check
    check (char_length(body_text) between 1 and 1500)
);

comment on table public.ats_whatsapp_auto_replies is
  'Owner-editable wording for the automatic WhatsApp replies the recruitment bot sends by itself: the two ask-for-a-CV replies, the two unreadable-CV replies, and the first and last lines of the closing summary. One row per message; an ABSENT row means the code default in the sender module, which is why reset is a delete and no default text is ever stored here.';

comment on column public.ats_whatsapp_auto_replies.body_text is
  'The words an applicant reads, Arabic block then English. The too-large reply must contain the token {maxMb}, which the app replaces with the file-size limit actually in force (RECRUITMENT_INBOUND_CV_MAX_BYTES) - a fixed number would send applicants away to shrink a file Phoenix would have accepted.';

alter table public.ats_whatsapp_auto_replies enable row level security;

-- Matches ats_whatsapp_question_prompts and every other ats_ table: application-scoped visibility,
-- service_role only at the database.
--
-- Guarded by a catalog read rather than the usual `drop policy if exists` first: the table is born
-- in this file, so no policy of this name can pre-exist, and the whole migration then contains not
-- one destructive statement — which is the honest shape for a purely additive change, and keeps
-- re-running it idempotent all the same.
do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'ats_whatsapp_auto_replies'
      and policyname = 'phx_ats_whatsapp_auto_replies_service_role'
  ) then
    create policy phx_ats_whatsapp_auto_replies_service_role
      on public.ats_whatsapp_auto_replies
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end $$;

grant select, insert, update, delete on public.ats_whatsapp_auto_replies to service_role;

commit;
