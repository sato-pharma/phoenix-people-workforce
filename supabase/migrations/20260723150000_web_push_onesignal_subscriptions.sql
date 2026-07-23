-- Web Push (OneSignal) integration.
--
-- Adds "push" as a fourth notification channel alongside in_app/email/telegram, following
-- the exact same shape Telegram already uses in this schema:
--   * notification_deliveries.channel / notification_templates.channel gain a 'push' value
--     (both had a hardcoded 3-value CHECK that would otherwise reject every push delivery
--     row and every admin-authored push template at the database layer).
--   * notification_preferences gains push_enabled (default true), mirroring email_enabled/
--     telegram_enabled, so a recipient can opt out of push per-channel like every other one.
--   * push_subscriptions is the OneSignal analogue of telegram_connections, but there is no
--     bot-link dance to model — the browser subscribes itself once permission is granted, and
--     OneSignal's own "External ID" (set client-side to the Phoenix HR_ID) is what the server
--     targets when sending, not a stored player id. This table exists only so Phoenix knows,
--     without calling OneSignal's API, whether a recipient currently has an active browser
--     subscription (in_app-preference-style pre-check + admin visibility). One row per
--     browser/device (desktop and mobile are both "OneSignal Web Push" — tracked as separate
--     rows keyed by OneSignal's own onesignal_subscription_id so a user can have both).

begin;

alter table public.notification_deliveries
    drop constraint if exists notification_deliveries_channel_check;
alter table public.notification_deliveries
    add constraint notification_deliveries_channel_check
    check ((channel = any (array['in_app'::text, 'email'::text, 'telegram'::text, 'push'::text])));

alter table public.notification_templates
    drop constraint if exists notification_templates_channel_check;
alter table public.notification_templates
    add constraint notification_templates_channel_check
    check ((channel = any (array['in_app'::text, 'email'::text, 'telegram'::text, 'push'::text])));

alter table public.notification_preferences
    add column if not exists push_enabled boolean default true not null;

comment on column public.notification_preferences.push_enabled is
    'Opt-out for the OneSignal web push channel, mirroring email_enabled/telegram_enabled. Sending still requires an active push_subscriptions row.';

create table if not exists public.push_subscriptions (
    id uuid default gen_random_uuid() not null,
    hr_id text not null,
    user_id text,
    onesignal_subscription_id text not null,
    device_type text default 'unknown'::text not null,
    user_agent text,
    status text default 'subscribed'::text not null,
    subscribed_at timestamp with time zone default now() not null,
    unsubscribed_at timestamp with time zone,
    last_seen_at timestamp with time zone default now() not null,
    created_at timestamp with time zone default now() not null,
    updated_at timestamp with time zone default now() not null,
    constraint push_subscriptions_pkey primary key (id),
    constraint push_subscriptions_subscription_id_key unique (onesignal_subscription_id),
    constraint push_subscriptions_status_check check ((status = any (array['subscribed'::text, 'unsubscribed'::text]))),
    constraint push_subscriptions_device_type_check check ((device_type = any (array['desktop'::text, 'mobile'::text, 'unknown'::text])))
);

comment on table public.push_subscriptions is
    'One row per browser/device OneSignal Web Push subscription. Existence of a status=subscribed row for an hr_id is Phoenix''s local "is this recipient reachable by push" check; the actual send targets OneSignal''s External ID (= hr_id), which fans out to every subscribed device on its own.';

create index if not exists push_subscriptions_hr_id_idx on public.push_subscriptions using btree (hr_id);
create index if not exists push_subscriptions_hr_id_status_idx on public.push_subscriptions using btree (hr_id, status);

alter table public.push_subscriptions enable row level security;

create policy phx_push_subscriptions_service_role on public.push_subscriptions
    to service_role using (true) with check (true);

grant all on table public.push_subscriptions to service_role;

notify pgrst, 'reload schema';

commit;
