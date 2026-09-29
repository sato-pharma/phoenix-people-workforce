-- hr_papers_hr_asked_for
--
-- ANNOUNCED, APPROVED AND APPLIED — 2026-09-30, Cairo. It was held back from the rest of the change
--    because it is a bulk write on a live table that moves a number the owner reads, he was told
--    what it would cost in plain words, and he said apply it.
--
-- WHAT IT ACTUALLY COST, measured on production immediately after:
--    17 definitions → 27, of which active went 16 → 27 ("(6) personal photos" came back too).
--    An ACTIVE employee is measured against 11 papers before and 20 after — NOT 16 → 27, because
--    `hiringDocumentApplies` excludes the seven exit documents from anyone who has not left. So the
--    honest figure is nine more papers per active person, and everybody reads as less complete than
--    the day before.
--    Nothing was un-filed: 0 definitions lost, 0 orphaned status rows, all 418 ticks and 3 files
--    still point at live definitions, because every rename kept its row and its id.
--    Pre-image: public.hiring_document_definitions_pre_20260930 (17 rows, RLS on, service_role only).
--
-- WHAT THIS CHANGES, in three parts:
--
--   1. Seven definitions are renamed to the names HR actually uses on the paper. Renames key on the
--      OLD name, so re-running this is a no-op.
--   2. Ten definitions HR collects today on paper and the system has never tracked.
--   3. The final group and display order for all twenty-seven.
--
-- WHY: the owner asked for the Employee Master to carry Yasmeena Elsafory's layout exactly
--   (2026-09-29). Her sheet names these ten papers and gives every document its band.
--
-- WHY THE RENAMES ARE SAFE NOW. A checklist name used to be a load-bearing string: the hiring pack
--   found the row a signature ticks with `ilike("name", …)`, so renaming "Social insurance form"
--   would have stopped Form 1 ticking its own slot, silently, with the signature still recorded.
--   That lookup now resolves on `hiring_pack_document` — the column that exists for it, carries the
--   same key as the binding, and no screen can edit — and falls back to the name only if no row
--   claims the paper. The rename is therefore safe in either deploy order.
--
-- "Personal photos" was deactivated seven minutes after it was created in May 2026. HR collects six
--   of them at joining and put it first on her sheet, so it comes back under that name.
--
-- ROLLBACK:
--   delete from public.hiring_document_definitions where name in (
--     'Clearance form or S6  From the last employer','Modern insurance printer',
--     'Signed Submitted Documents Checklist','توقيع صحيفة الحالة الإجتماعية',
--     'توقيع صحيفة الإجازات السنوية','صحيفة الإجازات المرضية','صحيفة الجزاءات',
--     'صحيفة تدرج الأجر','Signed receive Employment Documents','Signed Exit Interview Form');
--   update public.hiring_document_definitions set name = '(6) personal photos' is reversed by
--   setting it back to 'Personal photos' with is_active = false; the other six renames reverse the
--   same way. The DELETE removes only definitions this migration created — and with them any tick
--   or file HR recorded against one afterwards, which is why it is a rollback and not an undo.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This
-- migration inserts and renames; it deletes nothing.

begin;

-- 1. The names HR uses.
update public.hiring_document_definitions set name = '(6) personal photos', is_active = true
  where name = 'Personal photos';
update public.hiring_document_definitions set name = 'Kaab Elamaal'
  where name = 'كعب العمل';
update public.hiring_document_definitions set name = 'Medical check S 111'
  where name = 'Medical check';
update public.hiring_document_definitions set name = 'Social insurance form 1'
  where name = 'Social insurance form';
update public.hiring_document_definitions set name = 'Signed New Bank account Form'
  where name = 'Bank account details';
update public.hiring_document_definitions set name = 'Signed Employee Clearance'
  where name = 'Signed employee clearance';
update public.hiring_document_definitions set name = 'Signed Company Clearance'
  where name = 'Signed company clearance';

-- 2. The ten papers HR collects that the checklist has never tracked.
insert into public.hiring_document_definitions (name, description, display_order, is_active, document_group, is_exit_document)
select v.name, v.description, v.display_order, true, v.document_group, v.is_exit_document
from (values
  ('Clearance form or S6  From the last employer',
   'إخلاء طرف أو استمارة 6 من جهة العمل السابقة — proof the previous employer released the new hire and ended their social insurance subscription.',
   80, 'required', false),
  ('Modern insurance printer',
   'مطبوع تأمينات حديث — a recent printout from the Social Insurance Authority showing the employee''s subscription history.',
   90, 'required', false),
  ('Signed Submitted Documents Checklist',
   'The signed list of what the employee handed over, so both sides agree what is in the personnel file.',
   140, 'onboarding', false),
  ('توقيع صحيفة الحالة الإجتماعية',
   'Signed social status sheet, filed with the personnel record.',
   160, 'onboarding', false),
  ('توقيع صحيفة الإجازات السنوية',
   'Signed annual leave sheet.',
   170, 'onboarding', false),
  ('صحيفة الإجازات المرضية',
   'Sick leave sheet.',
   180, 'onboarding', false),
  ('صحيفة الجزاءات',
   'Penalties sheet.',
   190, 'onboarding', false),
  ('صحيفة تدرج الأجر',
   'Salary progression sheet.',
   200, 'onboarding', false),
  ('Signed receive Employment Documents',
   'The leaver''s signature confirming the personnel documents they were handed back on exit.',
   260, 'offboarding', true),
  ('Signed Exit Interview Form',
   'The signed exit interview record.',
   270, 'offboarding', true)
) as v(name, description, display_order, document_group, is_exit_document)
where not exists (
  select 1 from public.hiring_document_definitions d where d.name = v.name
);

-- 3. Every definition in its band, in the order HR reads them.
update public.hiring_document_definitions as d
set document_group = v.document_group, display_order = v.display_order
from (values
  ('(6) personal photos',                          'required',    10),
  ('Graduation certificate',                       'required',    20),
  ('Birth certificate',                            'required',    30),
  ('National ID copy',                             'required',    40),
  ('Military status',                              'required',    50),
  ('Criminal record',                              'required',    60),
  ('Kaab Elamaal',                                 'required',    70),
  ('Clearance form or S6  From the last employer', 'required',    80),
  ('Modern insurance printer',                     'required',    90),
  ('Medical check S 111',                          'required',   100),
  ('Signed employment contract',                   'onboarding', 110),
  ('Social insurance form 1',                      'onboarding', 120),
  ('Signed New Bank account Form',                 'onboarding', 130),
  ('Signed Submitted Documents Checklist',         'onboarding', 140),
  ('Signed confidentiality undertaking',           'onboarding', 150),
  ('توقيع صحيفة الحالة الإجتماعية',                'onboarding', 160),
  ('توقيع صحيفة الإجازات السنوية',                 'onboarding', 170),
  ('صحيفة الإجازات المرضية',                       'onboarding', 180),
  ('صحيفة الجزاءات',                               'onboarding', 190),
  ('صحيفة تدرج الأجر',                             'onboarding', 200),
  ('Signed social insurance Form 6',               'offboarding', 210),
  ('Signed resignation request',                   'offboarding', 220),
  ('Signed mutual termination agreement',          'offboarding', 230),
  ('Signed Employee Clearance',                    'offboarding', 240),
  ('Signed Company Clearance',                     'offboarding', 250),
  ('Signed receive Employment Documents',          'offboarding', 260),
  ('Signed Exit Interview Form',                   'offboarding', 270)
) as v(name, document_group, display_order)
where d.name = v.name;

commit;
