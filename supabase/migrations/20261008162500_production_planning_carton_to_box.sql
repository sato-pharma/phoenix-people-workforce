-- WHAT:     Production Planner — the English wording "Carton" / "carton" becomes "Box" / "box" in the
--           material master: the CARTON material's name_en, and the lemon-flavour note that says
--           "the carton says lemon". The material CODE stays CARTON (it is a key the engine,
--           the workbook and the tests read) and the Arabic name is untouched.
-- WHY:      Owner, 2026-10-08: "in production planner change any word karton to box".
-- ROLLBACK: update public.prodplan_materials set name_en = 'Carton' where code = 'CARTON';
--           and put 'the carton says lemon' back in LEMON_FLAVOUR's notes.
-- Two rows, display text only; safe to re-run (each statement matches the old wording only).

update public.prodplan_materials
   set name_en = 'Box'
 where code = 'CARTON'
   and name_en = 'Carton';

update public.prodplan_materials
   set notes = replace(notes, 'the carton says lemon', 'the box says lemon')
 where code = 'LEMON_FLAVOUR'
   and notes like '%the carton says lemon%';
