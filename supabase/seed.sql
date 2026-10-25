-- Basic vocabulary and how each word is signed. Recorded templates are NOT seeded:
-- the sign is learned from your own hand (Settings > Teach a sign) and stored in sign_templates.
insert into public.words (label, kind, category, meaning) values
  ('HELLO', 'word', 'greeting', 'A greeting'),
  ('YES',   'word', 'basic',    'Affirmative'),
  ('NO',    'word', 'basic',    'Negative'),
  ('MEETING','word','basic',    'A gathering of people'),
  ('TOMORROW','word','time',    'The day after today'),
  ('TIME',  'word', 'time',     'Time, the clock'),
  ('NEXT',  'word', 'time',     'Following, next'),
  ('WHAT',  'word', 'question', 'Question word'),
  ('SEND',  'word', 'action',   'Send something'),
  ('EMAIL', 'word', 'action',   'Electronic mail'),
  ('TEXT',  'word', 'action',   'Text message'),
  ('FRIEND','word', 'basic',    'A friend'),
  ('PLAY',  'word', 'action',   'Play'),
  ('MUSIC', 'word', 'basic',    'Music'),
  ('CALENDAR','word','basic',   'Calendar'),
  ('GOOD',  'word', 'basic',    'Good')
on conflict do nothing;

insert into public.asl_sign_specs (word_id, handshape, palm_orientation, location, movement, hands, non_manual, instructions)
select id, 'B hand: flat, fingers together, thumb tucked against the palm', 'palm faces left/forward',
       'fingertips at the temple or forehead', 'sweeps outward and slightly forward, like a relaxed salute', 1,
       'friendly, open expression; a small nod or smile',
       '1. Hold one flat hand, fingers together, thumb tucked. 2. Touch the fingertips to your forehead near the temple. 3. Move the hand outward and slightly forward, away from your head, in one smooth motion.'
from public.words where label = 'HELLO' and owner_id is null
union all
select id, 'S hand: closed fist, thumb across the fingers', 'palm faces forward',
       'in front of the chest or shoulder', 'fist nods up and down at the wrist, like a head nodding yes', 1,
       'a small nod', '1. Make a fist. 2. Hold it in front of you. 3. Bob the fist up and down at the wrist twice.'
from public.words where label = 'YES' and owner_id is null
union all
select id, 'Index and middle fingers extended, tapping the thumb', 'palm faces forward',
       'in front of the chest', 'index and middle fingers close onto the thumb, once or twice', 1,
       'a small head shake', '1. Hold the index and middle fingers out together with the thumb. 2. Snap the two fingers down onto the thumb. 3. Repeat once.'
from public.words where label = 'NO' and owner_id is null
on conflict do nothing;

-- ---------------------------------------------------------------------------------------------
-- Sign dictionary: handshapes, locations, movements, and HELLO as the first complete sign.
insert into public.handshapes (name, fingers, thumb, spread_max, description) values
  ('B', '{"index":"extended","middle":"extended","ring":"extended","pinky":"extended"}', 'any', 20,
   'Flat hand: four fingers straight and together; the thumb is tucked or alongside.')
on conflict (name) do nothing;

insert into public.locations (name, anchor, region, fallback, description) values
  ('upperFrame', 'frame', '{"xMin":0,"xMax":1,"yMin":0,"yMax":0.38}', null,
   'Upper part of the camera frame. Used when no face is visible.'),
  ('forehead', 'face', '{"xMin":-1.6,"xMax":1.6,"yMin":-1.4,"yMax":-0.1}', 'upperFrame',
   'At the forehead or temple: above the middle of the face box, up to a face-width to either side.')
on conflict (name) do nothing;

insert into public.movements (name, kind, params, description) values
  ('outward', 'outward', '{"minHandLengths":1.0,"sidewaysShare":0}',
   'Travels away from where it started, at least 1 hand length, in any direction (sideways, down or toward the camera).')
on conflict (name) do nothing;

insert into public.signs (word_id, hands, phases)
select id, 1, '[{"handshape":"B","location":"forehead"},{"handshape":"B","movement":"outward"}]'::jsonb
from public.words where label = 'HELLO' and owner_id is null
on conflict (word_id) do nothing;

-- MEETING: both hands gather into a flat-O (fingers and thumb together) and come together.
insert into public.handshapes (name, fingers, thumb, description) values
  ('flatO', '{"index":"curled","middle":"curled","ring":"curled","pinky":"curled"}', 'any',
   'Flat-O: fingers curved to meet the thumb. "curled" means bent or folded, anything not straight.')
on conflict (name) do nothing;

insert into public.handshapes (name, fingers, thumb, description) values
  ('anyHand', '{"index":"any","middle":"any","ring":"any","pinky":"any"}', 'any', 'Any hand shape: flat, curled or open.')
on conflict (name) do nothing;

insert into public.movements (name, kind, params, description) values
  ('together', 'together', '{"closeByHandLengths":1.5,"endGapHandLengths":3.2}',
   'Two hands come together: the gap closes by at least 1.5 hand lengths, to 3.2 or less.')
on conflict (name) do nothing;

insert into public.asl_sign_specs (word_id, handshape, palm_orientation, location, movement, hands, non_manual, instructions)
select id, 'Flat-O on both hands: fingers and thumb gathered together', 'palms face each other',
       'in front of the chest, hands apart', 'both hands move toward each other until they meet, like people coming together', 2,
       'neutral to friendly',
       '1. Gather the fingers and thumb of each hand together. 2. Hold both hands in front of your chest, a little apart, palms facing each other. 3. Bring them together.'
from public.words where label = 'MEETING' and owner_id is null
on conflict (word_id) do nothing;

insert into public.signs (word_id, hands, phases)
select id, 2, '[{"handshape":"anyHand"},{"handshape":"anyHand","movement":"together"}]'::jsonb
from public.words where label = 'MEETING' and owner_id is null
on conflict (word_id) do nothing;
