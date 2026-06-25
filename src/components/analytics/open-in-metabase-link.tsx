// Admin-only "Open in Metabase" link — renders nothing when Metabase embedding
// isn't configured (the default state until Phase 6 embedding is wired up to
// a live Metabase instance). Gated to CEO/Super Admin by the caller, since the
// Postgres analytics_readonly role has no row-level scoping, unlike Phoenix's
// own RBAC.

import { buildMetabaseOpenLink, getMetabaseEmbedConfig } from "@/lib/analytics/metabase-embed";

export function OpenInMetabaseLink() {
  const config = getMetabaseEmbedConfig();
  const href = buildMetabaseOpenLink(config);
  if (!href) return null;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-xs font-semibold text-orange-600 underline underline-offset-2 hover:text-orange-700"
    >
      Open in Metabase →
    </a>
  );
}
