-- A hiring-document file can say it was ISSUED by Phoenix, not uploaded or scanned by a person.
--
-- WHY A THIRD SOURCE RATHER THAN REUSING ONE. `hiring_document_files.source` today is 'upload' — a
-- file somebody chose off a disk — or 'scan' — pages photographed and assembled into a PDF. A paper
-- this system generated, filled with one employee's values and filed when the owner confirmed the
-- signature, is neither. It matters that the three are distinguishable at a glance, because the
-- slots these land in are named "Signed employment contract" and "Signed social insurance Form 6".
-- Somebody opening one is entitled to know whether they are looking at a photograph of a signature
-- or at the document that was put in front of the employee to sign. Folding the new kind into
-- 'upload' would answer that question wrongly and permanently, on the record an auditor reads.
--
-- STRICTLY A WIDENING. Every existing row keeps its meaning and no row is rewritten: the constraint
-- accepts everything it accepted before, plus one value nothing has yet written. The drop-then-add
-- is the only way Postgres expresses a CHECK change; `if exists` makes it re-runnable.

begin;

alter table public.hiring_document_files
  drop constraint if exists hiring_document_files_source_check;

alter table public.hiring_document_files
  add constraint hiring_document_files_source_check
  check (source in ('upload', 'scan', 'issued'));

comment on column public.hiring_document_files.source is
  'How this file came to be here. upload = a file somebody chose. scan = pages photographed and assembled into a PDF. issued = a paper this system generated for this employee and filed when its signature was confirmed — the document that was signed, never a photograph of the ink. The three are deliberately distinguishable: the slots these land in are named "Signed ...", and whoever opens one is entitled to know which they are looking at.';

commit;

notify pgrst, 'reload schema';
