-- ============================================================================
-- Lock phx_marketing_roi_fast execute to service_role only.
--
-- phx_marketing_roi_fast is a SECURITY DEFINER analytical RPC that returns the
-- Marketing ROI dashboard payload. It performs NO internal row-level
-- authorization — it trusts its caller (the Next.js server, using the service
-- role) to inject the line scope via p_lines. It must therefore be callable
-- ONLY by service_role, exactly like its sibling phx_refresh_marketing_roi_facts
-- and exactly as the original migration (20260625120000) intended
-- ("revoke all ... from public; grant execute ... to service_role").
--
-- On production the function carried a stray explicit `authenticated=X` grant
-- (surfaced by the 2026-07-05 line-scoping rollout's advisor check; staging did
-- not have it). That let any signed-in `authenticated` PostgREST caller invoke
-- /rest/v1/rpc/phx_marketing_roi_fast directly and receive UNSCOPED,
-- company-wide ROI data — bypassing the app-layer line scoping. The grant was
-- revoked on production during that rollout; this migration records the revoke
-- so the intended state (service_role only) is explicit, idempotent, and cannot
-- silently drift back. `revoke ... from public` does not remove an explicit
-- `authenticated` grant, so the revoke must name `authenticated` directly.
--
-- Idempotent: revoking a privilege that is not held is a no-op.
-- ============================================================================

revoke execute on function public.phx_marketing_roi_fast(
  text[], text[], text[], text[], text, text, text, text[], text[], integer, text[]
) from authenticated;

revoke execute on function public.phx_marketing_roi_fast(
  text[], text[], text[], text[], text, text, text, text[], text[], integer, text[]
) from public;

grant execute on function public.phx_marketing_roi_fast(
  text[], text[], text[], text[], text, text, text, text[], text[], integer, text[]
) to service_role;

notify pgrst, 'reload schema';
