-- 016(T-1326) 앱 설정 칸 — 총괄관리자 화면이 고치는 값(가입 캡차 스위치 · 총괄관리자 연락처). 키 하나에 값 하나.
-- 몇 번 돌려도 같은 결과(서버가 뜰 때마다 다시 돈다).
CREATE TABLE IF NOT EXISTS app_setting (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
