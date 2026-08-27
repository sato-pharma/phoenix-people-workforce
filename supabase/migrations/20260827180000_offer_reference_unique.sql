-- One reference, one offer.
--
-- WHY NOW. The reference was a free-text box somebody retyped on every letter, and the only thing
-- stopping two offers carrying the same number was whoever was typing remembering the last one.
-- Now that references are generated, the generator reads the highest number already used and adds
-- one — which is correct until two offers are created in the same second, when both read the same
-- highest and both write the same number. This index is what turns that race into a retry instead
-- of into two letters filed under one reference.
--
-- PARTIAL, on purpose. A blank reference is still allowed: an offer can be drafted before anyone
-- has decided what to call it, and the generator only fills a reference that was left empty. A
-- plain unique index would let exactly one such draft exist, which is the opposite of harmless.
-- Restricting the index to references that actually say something leaves blanks unconstrained and
-- still guarantees that any number that IS written is written once.
--
-- SAFE TO APPLY. Verified against production immediately before writing this: `offers` holds 0
-- rows, so no existing pair can collide and the index builds on an empty table. If that is ever
-- not true again, this will fail loudly at migration time rather than silently corrupting
-- anything — which is the correct outcome, and the duplicates would need resolving first.

begin;

create unique index if not exists offers_reference_unique_idx
  on public.offers (reference)
  where reference is not null and reference <> '';

comment on index public.offers_reference_unique_idx is
  'A written reference belongs to exactly one offer. Blank references are excluded so a draft may exist before it is numbered.';

commit;
