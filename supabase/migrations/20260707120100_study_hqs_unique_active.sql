-- Защита от дублей штаба (double-click/два таба): один активный hq на экзамен.

-- Сначала дедуп уже существующих строк (оставляем самую раннюю; tie-break по id).
delete from public.study_hqs a
using public.study_hqs b
where a.user_id = b.user_id
  and a.exam_profile_id = b.exam_profile_id
  and a.status = 'active'
  and b.status = 'active'
  and (a.created_at > b.created_at or (a.created_at = b.created_at and a.id > b.id));

create unique index study_hqs_user_exam_active_unique
  on public.study_hqs (user_id, exam_profile_id)
  where status = 'active';
