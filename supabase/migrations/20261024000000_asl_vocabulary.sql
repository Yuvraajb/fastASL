-- fastASL vocabulary: words, their ASL description, recorded sign templates, custom gestures.
--
-- Three layers per word:
--   words            what it means in English (label) - the text the app shows
--   asl_sign_specs   how it is signed, in the five ASL parameters (human-readable reference / teaching)
--   sign_templates   the machine mapping: recorded hand-landmark feature sequences the recognizer matches
--                    (32 frames x 134 numbers for words, 1+ vectors x 63 numbers for letters).
-- owner_id NULL = shared catalog row, readable by everyone; otherwise it belongs to one user.

create table public.words (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid references auth.users (id) on delete cascade,
  label       text not null check (label = upper(label) and char_length(label) between 1 and 64),
  kind        text not null default 'word' check (kind in ('word', 'letter')),
  category    text not null default 'basic',
  meaning     text,                       -- plain-English gloss, e.g. 'a greeting'
  created_at  timestamptz not null default now()
);
-- A label is unique within the catalog and within each user's own words.
create unique index words_catalog_label on public.words (label) where owner_id is null;
create unique index words_owner_label on public.words (owner_id, label) where owner_id is not null;

create table public.asl_sign_specs (
  word_id            uuid primary key references public.words (id) on delete cascade,
  handshape          text not null,       -- e.g. 'B (flat hand, fingers together, thumb tucked)'
  palm_orientation   text,
  location           text not null,       -- where the sign starts / happens
  movement           text not null,
  hands              smallint not null default 1 check (hands in (1, 2)),
  non_manual         text,                -- facial expression, head/body
  instructions       text not null        -- step-by-step "how to make it"
);

create table public.sign_templates (
  id           text primary key,          -- the app's template id
  word_id      uuid not null references public.words (id) on delete cascade,
  owner_id     uuid references auth.users (id) on delete cascade,
  frames       jsonb not null,            -- number[][]
  frame_count  integer generated always as (jsonb_array_length(frames)) stored,
  feature_dim  integer generated always as (jsonb_array_length(frames -> 0)) stored,
  source       text not null default 'recorded' check (source in ('recorded', 'imported', 'seed')),
  created_at   timestamptz not null default now(),
  check (jsonb_typeof(frames) = 'array' and jsonb_array_length(frames) >= 1)
);
create index sign_templates_word on public.sign_templates (word_id);
create index sign_templates_owner on public.sign_templates (owner_id);

create table public.custom_gestures (
  id          text primary key,
  owner_id    uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  task        text not null,              -- plain-English task the gesture runs
  shape       jsonb not null default '[]', -- static handshape samples: number[][]
  compiled    jsonb,                       -- recorded tool-call sequence
  created_at  timestamptz not null default now()
);
create index custom_gestures_owner on public.custom_gestures (owner_id);

-- Row level security: the catalog is public to read; a user reads and writes only their own rows.
alter table public.words enable row level security;
alter table public.asl_sign_specs enable row level security;
alter table public.sign_templates enable row level security;
alter table public.custom_gestures enable row level security;

create policy words_read on public.words for select using (owner_id is null or owner_id = auth.uid());
create policy words_write on public.words for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy specs_read on public.asl_sign_specs for select using (
  exists (select 1 from public.words w where w.id = word_id and (w.owner_id is null or w.owner_id = auth.uid())));
create policy specs_write on public.asl_sign_specs for all
  using (exists (select 1 from public.words w where w.id = word_id and w.owner_id = auth.uid()))
  with check (exists (select 1 from public.words w where w.id = word_id and w.owner_id = auth.uid()));

create policy templates_read on public.sign_templates for select using (owner_id is null or owner_id = auth.uid());
create policy templates_write on public.sign_templates for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy gestures_own on public.custom_gestures for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

grant select on public.words, public.asl_sign_specs, public.sign_templates to anon, authenticated;
grant insert, update, delete on public.words, public.asl_sign_specs, public.sign_templates to authenticated;
grant select, insert, update, delete on public.custom_gestures to authenticated;

-- One query the app uses to load everything a user's recognizer needs.
create view public.recognizer_templates with (security_invoker = true) as
  select t.id, w.label, w.kind, t.frames, extract(epoch from t.created_at)::bigint * 1000 as created_at
  from public.sign_templates t join public.words w on w.id = t.word_id;
grant select on public.recognizer_templates to anon, authenticated;
