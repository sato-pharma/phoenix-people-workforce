-- The stored designs hand the role paragraph over to {{roleSummary}}.
--
-- 🔴 APPLY THIS ONLY ONCE THE CODE IS LIVE — AFTER `/api/healthz` `revision` CONTAINS THE MERGE, not
-- before. It is split from 20261007143000 for exactly that reason, and the split is the whole point:
-- the previous migration is only new COLUMNS, which the running code ignores safely, while THIS one
-- rewrites what the four letter designs say. Code that does not yet produce a `roleSummary` token
-- leaves `{{roleSummary}}` standing VISIBLY — `fillOfferTokens` deliberately never blanks an unknown
-- token — so applying this one early prints those literal characters on an offer preview, and on a
-- PDF if anybody composes in the window. Applied in the wrong order it is cosmetic and brief; it is
-- still a document a candidate might read, so order it properly.
--
-- The four template rows hold their own copy of the blocks, so changing the code that GENERATES them
-- would have changed nothing until somebody pressed Restore on each design. Verified byte-identical
-- to the shipped code before this ran, which is what makes a surgical replace safe here.
--
-- Non-greedy on purpose: it stops at the first </p> after the sentence, so a design whose author has
-- since added paragraphs below it keeps them. A design whose paragraph has been reworded does not
-- match at all and is left completely alone — it keeps its own words, which is the right answer for
-- somebody who deliberately typed them.
update public.offer_templates t
set blocks = (
      select jsonb_agg(
               case
                 when e.block->>'type' = 'text'
                  and (e.block->'props'->>'html') like '%<p>Throughout our selection process%'
                 then jsonb_set(
                        e.block,
                        '{props,html}',
                        to_jsonb(regexp_replace(
                          e.block->'props'->>'html',
                          '<p>Throughout our selection process.*?</p>',
                          '<p>{{roleSummary}}</p>'
                        ))
                      )
                 else e.block
               end
               order by e.ord
             )
      from jsonb_array_elements(t.blocks) with ordinality as e(block, ord)
    ),
    updated_at = now()
where t.blocks::text like '%<p>Throughout our selection process%';
