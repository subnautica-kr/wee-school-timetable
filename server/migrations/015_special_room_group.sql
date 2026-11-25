-- 015(T-1311) 특별실 묶음 · 시수표 줄의 방 사용 시수 — 「과학실1, 과학실2 중 비는 방」과 「주 3시간 중 2시간만 방 사용」의 바닥.
-- 몇 번 돌려도 같은 결과(서버가 뜰 때마다 다시 돈다): 표·칸·색인은 IF NOT EXISTS.
-- 정원은 special_room.capacity(한 번에 들어가는 반 수 · 비면 1반으로 센다)가 이미 있어 칸을 더하지 않는다.
-- 묶음 구성원(room_ids)은 FK 없이 둔다 — 특별실을 지워도 묶음 줄은 남고, 읽을 때 살아 있는 방만 거른다.

CREATE TABLE IF NOT EXISTS special_room_group (
  id         BIGSERIAL PRIMARY KEY,
  org_id     BIGINT NOT NULL REFERENCES org(id),
  name       TEXT NOT NULL,
  room_ids   BIGINT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS special_room_group_uq ON special_room_group (org_id, name) WHERE deleted_at IS NULL;

-- 시수표 줄: 방 하나(special_room_id) 대신 묶음(room_group_id) · 방을 쓰는 시수(NULL = 전부)
ALTER TABLE teaching_load ADD COLUMN IF NOT EXISTS room_group_id BIGINT REFERENCES special_room_group(id);
ALTER TABLE teaching_load ADD COLUMN IF NOT EXISTS room_hours INTEGER;
