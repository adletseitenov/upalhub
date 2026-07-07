-- D2/Task5: study_hqs.config хранит выбор ученика из онбординг-визарда
-- (variantKey + selectedSectionNames) — jsonb, аддитивно, старые штабы
-- получают дефолт '{}' (resolveActiveSections трактует {} как "все секции").

alter table public.study_hqs add column config jsonb not null default '{}'::jsonb;
alter table public.study_hqs add constraint study_hqs_config_is_object check (jsonb_typeof(config) = 'object');
