-- The Monthly Closing publish's fixed Cc roles, moved out of code and into a distribution list.
--
-- SEEDED ENABLED, unlike the three lists in 20260911120000. Those replace nothing yet, so shipping
-- them off changes nothing. This one is load-bearing from the moment it exists: the closing sender
-- reads it, and a disabled row would make it fall back to the hardcoded default — correct, but it
-- would mean the screen showed a list that was not actually in charge, which is worse than either
-- honest state.
--
-- The three roles are byte-identical to FIXED_CC_ROLES in closing-publish-recipients.ts, so the
-- resolved Cc on the first publish after this lands is the same set of people as the last publish
-- before it. This migration changes WHERE the answer is stored, never what it is.
--
-- What deliberately did NOT move: the District Managers (To), the line's NSM and the line's
-- PM/GPM. Those are resolved per published line from the organogram, and a stored list cannot
-- express "the DMs on THIS line" — one list per line would need re-editing every time a seat
-- changed, which is the exact maintenance burden reading the org tree live removes.
begin;

insert into public.distribution_lists (list_key, label, description, roles, enabled) values
  ('closing_fixed_cc', 'Monthly Closing — fixed Cc',
   'The company-wide roles Cc''d on every line''s Monthly Closing publish. The published line''s own District Managers, NSM and Product Manager are resolved from the organogram per line and are NOT set here. Named individuals on the closing (Ahmed Sharaf on Cc, Omar Anwar on Bcc) are also not set here. This list is read for its ROLES only — adding a person or an address to it does nothing, and the send will say so.',
   array['CEO', 'Marketing Manager', 'SFE Manager']::text[], true)
on conflict (list_key) do nothing;

commit;
