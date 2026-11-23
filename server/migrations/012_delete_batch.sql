-- 지우기 묶음(T-1211) — 반·교사·교과 등을 지울 때 딸린 것까지 한 번호로 묶어 적고, 그 번호로 되살린다. 멱등.
-- 지우기는 여전히 deleted_at 표시 삭제다. 이 표는 「무엇을 같이 지웠고 어느 칸을 비웠나」만 적는다.
CREATE TABLE IF NOT EXISTS delete_batch (
  id          BIGSERIAL PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES org(id),
  kind        TEXT NOT NULL,                          -- classroom · membership · subject · special_room · timetable · term
  target_id   BIGINT NOT NULL,
  label       TEXT NOT NULL,                          -- 지운 것의 이름(「1학년 2반」 등) — 휴지통 목록에 그대로 보인다
  summary     JSONB NOT NULL DEFAULT '[]'::jsonb,     -- [{table,label,count,action}] 지울 때 센 것
  created_by  BIGINT REFERENCES app_user(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  restored_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS delete_batch_org_idx ON delete_batch (org_id, created_at DESC);

-- 묶음 한 줄 = 행 하나를 지움(column_name NULL) 또는 칸 하나를 비움(column_name = 그 칸, old_value = 원래 값, new_value = 바꾼 값)
CREATE TABLE IF NOT EXISTS delete_batch_item (
  id          BIGSERIAL PRIMARY KEY,
  batch_id    BIGINT NOT NULL REFERENCES delete_batch(id) ON DELETE CASCADE,
  table_name  TEXT NOT NULL,
  row_id      BIGINT NOT NULL,
  column_name TEXT,
  old_value   TEXT,
  new_value   TEXT
);
CREATE INDEX IF NOT EXISTS delete_batch_item_batch_idx ON delete_batch_item (batch_id);
