-- Final follow-up for remaining Supabase performance advisor FK warnings.
-- These are true missing covering indexes and are safe to add.
-- The accompanying unused-index warnings are intentionally not auto-pruned here;
-- they need workload evidence before removal.

create index if not exists positions_area_id_idx
on public.positions (area_id);

create index if not exists positions_line_id_idx
on public.positions (line_id);

create index if not exists user_roles_role_id_idx
on public.user_roles (role_id);
