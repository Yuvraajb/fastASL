-- The ASL sign dictionary the recognizer reads. A word is a short list of phases; each phase names a
-- handshape (how the fingers are), a location (where) and/or a movement (how it travels). The
-- recognizer is one generic matcher over these rows, so adding a word needs no code.

create table public.handshapes (
  name        text primary key,
  -- Per finger: extended | folded | any. Same states handShape.ts measures from the 21 landmarks.
  fingers     jsonb not null check (jsonb_typeof(fingers) = 'object'),
  thumb       text not null default 'any' check (thumb in ('extended', 'folded', 'any')),
  spread_max  numeric,        -- max index/middle angle in degrees ("fingers together")
  description text
);

create table public.locations (
  name      text primary key,
  anchor    text not null check (anchor in ('face', 'frame')),
  -- face: box relative to the face center, in face widths (x) and heights (y, down is positive).
  -- frame: box in fractions of the camera frame (0 = top/left).
  region    jsonb not null check (region ?& array['xMin', 'xMax', 'yMin', 'yMax']),
  fallback  text references public.locations (name),  -- used when no face is visible
  description text
);

create table public.movements (
  name    text primary key,
  kind    text not null check (kind in ('outward', 'together')),
  params  jsonb not null,
  description text
);

create table public.signs (
  id        uuid primary key default gen_random_uuid(),
  word_id   uuid not null references public.words (id) on delete cascade,
  hands     smallint not null default 1 check (hands in (1, 2)),
  -- [{handshape, location}, {handshape, movement}]: hold the first phase, then do the second.
  phases    jsonb not null check (jsonb_typeof(phases) = 'array' and jsonb_array_length(phases) >= 1),
  unique (word_id)
);

alter table public.handshapes enable row level security;
alter table public.locations enable row level security;
alter table public.movements enable row level security;
alter table public.signs enable row level security;
create policy handshapes_read on public.handshapes for select using (true);
create policy locations_read on public.locations for select using (true);
create policy movements_read on public.movements for select using (true);
create policy signs_read on public.signs for select using (
  exists (select 1 from public.words w where w.id = word_id and (w.owner_id is null or w.owner_id = auth.uid())));
grant select on public.handshapes, public.locations, public.movements, public.signs to anon, authenticated;

-- One document for the app: everything the matcher needs, in the shape shared/dictionary.ts expects.
create view public.dictionary_signs with (security_invoker = true) as
  select w.label as gloss, s.hands, s.phases
  from public.signs s join public.words w on w.id = s.word_id;
grant select on public.dictionary_signs to anon, authenticated;
