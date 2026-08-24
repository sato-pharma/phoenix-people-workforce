-- Recruitment / ATS — the advertising channel directory the owner supplied on 2026-08-24.
--
-- Two changes, both additive:
--
--   1. Widen the `kind` check. The table shipped covering Facebook only, because that is what the
--      original request was about. The real list is three platforms, and the split that matters is
--      GROUP vs CHANNEL: a group is somewhere you can post, a channel is a broadcast feed only its
--      admins can write to. Encoding that in `kind` keeps it out of a new column and lets the panel
--      say plainly which rows are "post here" and which are "ask the admin".
--
--   2. Seed the 43 channels themselves. They are reference data, not user data: the same rows must
--      exist in staging and production, and a re-run must not duplicate them — hence
--      `on conflict (code) do nothing`. The recruiter renames, deactivates, or adds to them from
--      the Advertise tab afterwards; nothing here is meant to be the last word.
--
-- Codes are hand-assigned rather than derived. `deriveChannelCode` would give the twelve
-- "All Medical Reps. Groups – <governorate>" rows the same initials and then number them
-- PX-AMRG2..PX-AMRG12, which is exactly the kind of code a recruiter cannot read at a glance and an
-- applicant retypes wrong. Platform letter + a three-letter mnemonic stays inside the same
-- `^PX-[A-Z0-9]{2,10}$` pattern the extractor already enforces.

alter table public.ats_job_post_channels
  drop constraint if exists ats_job_post_channels_kind_check;

alter table public.ats_job_post_channels
  add constraint ats_job_post_channels_kind_check
  check (kind in (
    'facebook_group',
    'facebook_page',
    'whatsapp_group',
    'whatsapp_channel',
    'telegram_group',
    'telegram_channel',
    'job_board',
    'referral',
    'other'
  ));

insert into public.ats_job_post_channels (code, name, url, kind, notes) values
  -- ── WhatsApp groups — you can post once you have joined ────────────────────
  ('PX-WDAK', 'All Medical Reps – Dakahlia', 'https://chat.whatsapp.com/F1GKhZjPuMXDzPR5Pakn01', 'whatsapp_group', 'Dakahlia · medical reps · invite link, membership required'),
  ('PX-WSHR', 'All Medical Reps – Sharkia', 'https://chat.whatsapp.com/DGVApFxKXx05PRbXcGCMJ2', 'whatsapp_group', 'Sharkia · medical reps · invite link, membership required'),
  ('PX-WDPS', 'All Medical Reps – Damietta & Port Said', 'https://chat.whatsapp.com/Dq4I4XwEOpI3zzeCQH9hLa', 'whatsapp_group', 'Damietta / Port Said · medical reps · invite link'),
  ('PX-WCAI', 'All Medical Reps – Cairo', 'https://chat.whatsapp.com/EF1I33PPgEF3b9XJ7k4pDG', 'whatsapp_group', 'Cairo · medical reps · invite link'),
  ('PX-WGIZ', 'All Medical Reps – Giza', 'https://chat.whatsapp.com/DZCq9IKZpT8IofA9KaeCr0', 'whatsapp_group', 'Giza · medical reps · invite link'),
  ('PX-WALX', 'Alexandria Medical Reps', 'https://chat.whatsapp.com/LcOYn8yyAzb4Q3fXRw6XoZ', 'whatsapp_group', 'Alexandria · medical reps and jobs · invite link'),
  ('PX-WBEH', 'All Medical Reps – Beheira', 'https://chat.whatsapp.com/GePTQ9GCFcPDwGJPIFCHlS', 'whatsapp_group', 'Beheira · medical reps · invite link'),
  ('PX-WGHR', 'مندوبين دعاية الغربية — Gharbia Medical Reps', 'https://chat.whatsapp.com/E6yuTslfQpCJGuX1ZzQ3ZP', 'whatsapp_group', 'Gharbia · Arabic-first · post in Arabic'),
  ('PX-WMEN', 'All Medical Reps – Menofia', 'https://chat.whatsapp.com/Ei63vWbyWyuLGtjg9v9fFm', 'whatsapp_group', 'Menofia · medical reps · invite link'),
  ('PX-WQAL', 'All Medical Reps – Qalubia', 'https://chat.whatsapp.com/Hpfzu6FItcZAK5kCX8Y1qR', 'whatsapp_group', 'Qalubia · medical reps · invite link'),
  ('PX-WISM', 'All Medical Reps – Ismailia & Suez', 'https://chat.whatsapp.com/J2UMWu5uk1x9Xl7nryYjC6', 'whatsapp_group', 'Ismailia / Suez · Canal hiring · invite link'),
  ('PX-WUPP', 'All Medical Reps – Upper Egypt', 'https://chat.whatsapp.com/HZUd0l9AZr52BGFYSiL6qG', 'whatsapp_group', 'Upper Egypt · medical reps · invite link'),
  ('PX-WGVQ', 'Green Vision Jobs & Training Inquiries', 'https://chat.whatsapp.com/Lowh2X8G1ZO7UluqxOd20J', 'whatsapp_group', 'Nationwide · vet/pharma feeder · inquiries group'),

  -- ── WhatsApp channels — broadcast, only the owner of the channel can post ──
  ('PX-WGVJ', 'Green Vision — Veterinary Jobs (channel)', 'https://whatsapp.com/channel/0029Vaj5QbuIHphJBYZ8Il0x', 'whatsapp_channel', 'Nationwide · broadcast · ask the admin to carry the ad'),
  ('PX-WGVT', 'Green Vision Training (channel)', 'https://whatsapp.com/channel/0029VaiUPcXIiRp0VEPYJP3i', 'whatsapp_channel', 'Nationwide · broadcast · ask the admin to carry the ad'),
  ('PX-WJWM', 'Job Way Medical Recruitment (channel)', 'https://whatsapp.com/channel/0029Va5fzfRHFxP9uRFc3Y37', 'whatsapp_channel', 'Egypt + Gulf · official Job Way broadcast · ask the admin'),

  -- ── Telegram groups — you can post once you have joined ────────────────────
  ('PX-TTJI', 'Training & Jobs Inquiries', 'https://t.me/trainingsjobsinquiries', 'telegram_group', 'Egypt · Arabic · open group, posting allowed'),

  -- ── Telegram channels — broadcast; placement is a request or a paid ad ─────
  ('PX-TREP', 'Repsology', 'https://t.me/RepsologyOfficial', 'telegram_channel', '~6.9K · medical reps and career development · broadcast'),
  ('PX-TJFE', 'وظايف يوميا بدون مقابل — Jobs for Egyptian', 'https://t.me/jobsforegyptian', 'telegram_channel', '~31.3K · Arabic · broadcast'),
  ('PX-TRCB', 'Recruitmentblogs', 'https://t.me/Recruitmentblogs', 'telegram_channel', '~35.2K · pharma and medical reps · broadcast'),
  ('PX-TVAC', 'Vacanciesblog', 'https://t.me/Vacanciesblog', 'telegram_channel', '~14.4K · Egypt / Middle East · broadcast'),
  ('PX-TPST', 'Pharmacy Students Training & Jobs', 'https://t.me/Pharmacy_Students_Training', 'telegram_channel', '~20.1K · pharmacy jobs and rep training · broadcast'),
  ('PX-THLP', 'Helpawy', 'https://t.me/Helpawy24', 'telegram_channel', '~43.4K · fresh graduates · broadcast'),
  ('PX-TVET', 'Veterinary Jobs', 'https://t.me/veterinaryjobsss', 'telegram_channel', '~10.2K · vet/pharma, carries rep roles · broadcast'),
  ('PX-TVTR', 'Veterinary Training', 'https://t.me/veterinarytrainings', 'telegram_channel', 'Egypt · training feeder · broadcast'),
  ('PX-TSCI', 'علوم Jobs — Sciencejobss', 'https://t.me/Sciencejobss', 'telegram_channel', 'Egypt · science and pharma vacancies · broadcast'),
  ('PX-TJFA', 'علوم · صيدلة · بيطري · زراعة — Job for All', 'https://t.me/jobforallmooo', 'telegram_channel', 'Egypt · graduate jobs incl. medical reps · broadcast'),
  ('PX-TBTS', 'بتاع شغل', 'https://t.me/bta3sho8l', 'telegram_channel', '~142K · very high volume, general jobs · advertising contact in bio'),
  ('PX-TQNL', 'QenaLuxorJobs', 'https://t.me/QenaLuxorJobs', 'telegram_channel', '~63.7K · Qena / Luxor / Upper Egypt · broadcast'),
  ('PX-TJWM', 'Job Way Medical', 'https://t.me/Jobwaymedical', 'telegram_channel', 'Egypt + overseas · official Job Way · broadcast'),
  ('PX-TJWE', 'Job Way Egypt', 'https://t.me/jobwayegypt', 'telegram_channel', 'Egypt + Gulf · official Job Way · broadcast'),
  ('PX-TRUP', 'RecruitedIn Upper Egypt — Medical Reps Hub', 'https://t.me/RecruitedInUE', 'telegram_channel', 'Upper Egypt · confirm posting frequency before paying · broadcast'),

  -- ── Facebook groups — you can post once you are a member; most hold posts ──
  ('PX-FEMR', 'Egypt Medical Rep vacancies', 'https://www.facebook.com/groups/14921391140/', 'facebook_group', '~89.1K · nationwide · largest of the list · posts may need approval'),
  ('PX-FMRD', 'Medical Rep — مندوب الدعاية الطبية', 'https://www.facebook.com/groups/220204801342947/', 'facebook_group', '~1.3K · Egypt · direct rep community'),
  ('PX-FMRV', 'Medical Representatives Vacancies in Egypt', 'https://www.facebook.com/groups/1152752398116794/', 'facebook_group', 'Egypt · very recent activity · verify post-approval rules'),
  ('PX-FMRA', 'Medical Representative for all Egypt', 'https://www.facebook.com/groups/2060933097487818/', 'facebook_group', 'Nationwide · pharma recruiting'),
  ('PX-FMRG', 'Medical Reps all Over Egypt and Gulf', 'https://www.facebook.com/groups/1638950369719104/', 'facebook_group', 'Egypt + Gulf · broader geographic reach'),
  ('PX-FMDM', 'Medical Reps and District Managers All Over Egypt', 'https://www.facebook.com/groups/2162645593768137/', 'facebook_group', 'Egypt · reps AND district managers · good for senior roles'),
  ('PX-FPSD', 'PortSaid Medical Reps', 'https://www.facebook.com/groups/271914912894024/', 'facebook_group', 'Port Said · regional · confirm it is still active'),
  ('PX-FNQB', 'نقابة مندوبى شركات الادوية', 'https://www.facebook.com/groups/1421494178117067/', 'facebook_group', 'Egypt incl. Delta · Arabic-first · post in Arabic'),
  ('PX-FMRC', 'Medical Rep Community', 'https://www.facebook.com/groups/1452982991593132/', 'facebook_group', 'Egypt · community and careers · confirm engagement'),
  ('PX-FRHB', 'Reps Hub', 'https://www.facebook.com/groups/1805975733131439/', 'facebook_group', 'Egypt · use after the higher-confidence groups'),
  ('PX-FRIN', 'RecruitedIn — Medical Reps Hub', 'https://www.facebook.com/groups/633319117770195/', 'facebook_group', 'Egypt / Upper Egypt · also runs the RecruitedInUE Telegram channel')
on conflict (code) do nothing;
