-- 기존 schema.sql을 이미 실행한 프로젝트에 한 번 적용하세요.
-- 앱이 로컬 기록을 사용자 계정별로 중복 없이 동기화할 식별자를 추가합니다.

alter table public.study_sessions
  add column if not exists local_id text,
  add column if not exists course_key text;

alter table public.travel_routes
  add column if not exists local_id text;

alter table public.study_courses
  add column if not exists local_id text;

create unique index if not exists study_sessions_user_local_id_key
  on public.study_sessions (user_id, local_id);

create unique index if not exists travel_routes_user_local_id_key
  on public.travel_routes (user_id, local_id);

create unique index if not exists study_courses_user_local_id_key
  on public.study_courses (user_id, local_id);
