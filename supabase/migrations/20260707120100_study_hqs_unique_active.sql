-- Защита от дублей штаба (double-click/двa таба): один активный hq на экзамен.
create unique index study_hqs_user_exam_active_unique
  on public.study_hqs (user_id, exam_profile_id)
  where status = 'active';
