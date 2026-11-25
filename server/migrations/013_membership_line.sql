-- 013(T-1320a①) 명단 줄 독립 — 명단 줄(membership)이 계정 없이도 서게 한다. 몇 번 돌려도 같은 결과(서버가 뜰 때마다 다시 돈다).
-- 차례가 틀리면 기존 DB 에서 서버가 안 뜬다 — 설계 「013 안의 차례」 아홉 단계를 그대로 따른다.
-- 재직 상태 저장 값은 옛 값('사용' = 재직 · '숨김' = 퇴직) 그대로 두고 '휴직'·'전출' 둘만 더한다(자료 고침 0행).

-- ① 줄 이름 칸(처음엔 NULL 허용)
ALTER TABLE membership ADD COLUMN IF NOT EXISTS name TEXT;

-- ② 이름이 빈 줄에 연결된 계정 이름을 베낀다(이미 찬 줄은 안 건드린다)
UPDATE membership m SET name = u.name FROM app_user u WHERE m.user_id = u.id AND m.name IS NULL;

-- ③ 쓰기 전 트리거: 이름을 안 주면 연결된 계정 이름으로 채운다(줄을 넣는 옛 코드는 이름을 안 준다).
--    같은 계정에 본 소속 줄이 이미 있는데 이 줄이 본 소속이 되려 하면(넣기 · 숨김→사용 · 지운 줄 되살리기) 겸임으로 표시한다 —
--    옛 길(겸임 데려오기·숨김 풀기·보관함 되살리기)은 is_concurrent 를 모른다. 동시에 둘이 들어오는 경합은 ⑨ 색인이 막는다.
--    is_concurrent 를 직접 FALSE 로 바꾸는 쓰기는 이 트리거가 안 건드린다(색인이 막는다).
--    is_concurrent 칸은 ⑦ 에서 생긴다 — plpgsql 은 돌 때 칸을 찾으니 함수를 먼저 만들어도 된다(③~⑦ 사이엔 쓰기가 없다).
CREATE OR REPLACE FUNCTION membership_fill_before_write() RETURNS trigger AS $$
BEGIN
  IF NEW.name IS NULL AND NEW.user_id IS NOT NULL THEN
    SELECT u.name INTO NEW.name FROM app_user u WHERE u.id = NEW.user_id;
  END IF;
  IF NEW.user_id IS NOT NULL AND NOT NEW.is_concurrent AND NEW.deleted_at IS NULL
     AND NEW.status IN ('사용','휴직') AND NEW.role <> '시스템관리자'
     AND EXISTS (SELECT 1 FROM membership o
                  WHERE o.user_id = NEW.user_id AND o.id <> NEW.id AND o.deleted_at IS NULL AND NOT o.is_concurrent
                    AND o.status IN ('사용','휴직') AND o.role <> '시스템관리자') THEN
    NEW.is_concurrent := TRUE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS membership_fill_before_write ON membership;
CREATE TRIGGER membership_fill_before_write BEFORE INSERT OR UPDATE OF user_id, status, deleted_at, role ON membership
  FOR EACH ROW EXECUTE FUNCTION membership_fill_before_write();

-- ④ 이름은 꼭 있다
ALTER TABLE membership ALTER COLUMN name SET NOT NULL;

-- ⑤ 계정 없는 줄을 허용
ALTER TABLE membership ALTER COLUMN user_id DROP NOT NULL;

-- ⑥ 재직 상태 넷 — 사용(재직)·휴직·전출·숨김(퇴직). 값은 옮기지 않고 CHECK 만 넓힌다
ALTER TABLE membership DROP CONSTRAINT IF EXISTS membership_status_check;
ALTER TABLE membership ADD CONSTRAINT membership_status_check CHECK (status IN ('사용','휴직','전출','숨김'));

-- ⑦ 새 칸(전부 선택)
ALTER TABLE membership ADD COLUMN IF NOT EXISTS birth_date DATE;
ALTER TABLE membership ADD COLUMN IF NOT EXISTS is_concurrent BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE membership ADD COLUMN IF NOT EXISTS linked_at TIMESTAMPTZ;
ALTER TABLE membership ADD COLUMN IF NOT EXISTS linked_by BIGINT;           -- 연결한 계정 번호(외래키 안 검 — 계정 지우기는 표시 삭제라 번호는 남는다)
ALTER TABLE membership ADD COLUMN IF NOT EXISTS concurrent_until DATE;      -- 겸임 기간(선택)

-- ⑧ 한 계정에 본 소속 줄이 둘 이상이면 가장 오래된 줄만 본 소속으로 두고 나머지를 겸임(기간 없음)으로 표시한다.
--    ⑨ 본 소속 색인과 같은 조건만 본다 — 걸릴 줄이 없으면 아무것도 안 바꾼다(다시 돌려도 같은 결과).
UPDATE membership SET is_concurrent = TRUE
 WHERE id IN (
   SELECT id FROM (
     SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY created_at, id) AS rn
       FROM membership
      WHERE user_id IS NOT NULL AND deleted_at IS NULL AND NOT is_concurrent
        AND status IN ('사용','휴직') AND role <> '시스템관리자'
   ) x WHERE rn > 1
 );

-- ⑨ 옛 유일 제약(지운 줄도 자리를 차지했다)을 떼고 부분 유일 색인 둘
ALTER TABLE membership DROP CONSTRAINT IF EXISTS membership_user_id_org_id_key;
-- 같은 학교에 같은 계정 줄은 하나(지운 줄·계정 없는 줄은 안 센다)
CREATE UNIQUE INDEX IF NOT EXISTS membership_user_org_uq ON membership (user_id, org_id)
  WHERE deleted_at IS NULL AND user_id IS NOT NULL;
-- 계정 하나에 본 소속(겸임 아님 · 재직/휴직) 줄은 하나 — 총괄관리자 줄은 뺀다
CREATE UNIQUE INDEX IF NOT EXISTS membership_primary_uq ON membership (user_id)
  WHERE user_id IS NOT NULL AND deleted_at IS NULL AND NOT is_concurrent
    AND status IN ('사용','휴직') AND role <> '시스템관리자';
