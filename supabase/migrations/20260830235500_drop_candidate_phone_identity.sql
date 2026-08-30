-- Recruitment / ATS — phone stops being a candidate identity key.
--
-- WHY. A WhatsApp message from anyone not on RECRUITMENT_WHATSAPP_IMPORT_SENDERS is treated as a
-- direct application, so buildWhatsAppIntakeInput stamps the candidate with the SENDER's number
-- (identitySource "sender"). A hiring manager forwarding CVs from her own handset therefore created
-- one candidate carrying HER number, and every later forward matched it on phone and was filed
-- inside it. On 2026-08-30 three separate applicants ended up as a single record: the CVs of
-- Mahmoud Mansour and Abdelrahman Mahmoud were sitting in a file named after Mina Hany George.
--
-- Measured on production before this change: match_reason = 'phone' had fired 8 times in the whole
-- history of ats_cv_intake_events, 6 of them wrong merges. Email matched 71 times and is untouched.
--
-- WHY THE INDEX MUST GO IN THE SAME CHANGE. findMatchingCandidate no longer consults phoneNorm.
-- With this unique index still in place a second candidate on the same number would raise 23505,
-- and matchOrInsertCandidate's 23505 recovery re-runs the very matcher that no longer looks at
-- phone — so it would find nothing and rethrow. CV intake would fail outright rather than merge.
-- Removing the matcher and keeping the index is strictly worse than the bug being fixed.
--
-- Phone is still normalized, still stored in phone_norm, and still drives the advisory duplicate
-- flag a human reviews. Only the automatic merge is gone. The email and national-ID unique indexes
-- are deliberately untouched.
--
-- Reversible: recreating the index is the rollback, but do NOT recreate it without also restoring
-- phone to findMatchingCandidate, for the 23505 reason above.

drop index if exists public.recruitment_candidates_phone_norm_uidx;

-- Keep the lookup: phone_norm is still read for the advisory duplicate flag and by the admin
-- duplicate review screen. Non-unique, so it can never merge anyone on its own.
create index if not exists recruitment_candidates_phone_norm_idx
  on public.ats_candidates (phone_norm)
  where phone_norm is not null;

comment on index public.recruitment_candidates_phone_norm_idx is
  'Lookup only. Phone is NOT a candidate identity key (2026-08-30) - it merged three applicants into one record. Never make this unique again without restoring phone to findMatchingCandidate; see 20260830235500_drop_candidate_phone_identity.sql.';
