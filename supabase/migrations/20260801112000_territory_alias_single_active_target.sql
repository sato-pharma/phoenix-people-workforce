-- A territory alias may point at exactly one brick at a time.
--
-- upsertTerritoryAlias used onConflict "normalized_alias,target_type,target_code" — a conflict key
-- that INCLUDES the target — so re-pointing an alias at a different brick did not conflict, it
-- inserted a second active row. buildAliasIndex deliberately drops an alias that resolves
-- ambiguously, so the edit silently made the alias resolve to NOTHING: worse than before it was
-- edited, and no error was shown to the admin who made it.
--
-- The application fix (deactivate the other active targets after the upsert) shipped in
-- codex/sos-mapping-integrity. This is the structural half: with this index the broken state cannot
-- exist at all, no matter which code path writes the table — a bulk import, a manual SQL fix, or a
-- future writer nobody has written yet.
--
-- Applies cleanly: 0 duplicate (normalized_alias, target_type) groups among the 913 active aliases
-- in production, verified immediately before authoring this.
--
-- Partial on `active` deliberately. Deactivated rows are the audit trail of what an alias used to
-- point at — many may share a key and must keep doing so. Only the ACTIVE set needs to be unique.

begin;

create unique index if not exists source_of_sales_territory_aliases_one_active_target
  on public.source_of_sales_territory_aliases (normalized_alias, target_type)
  where active;

comment on index public.source_of_sales_territory_aliases_one_active_target is
  'One active target per (normalized_alias, target_type). Two active rows make the alias ambiguous, '
  'and buildAliasIndex then resolves it to nothing — so a second row is not a duplicate, it is an '
  'outage for that alias.';

commit;
