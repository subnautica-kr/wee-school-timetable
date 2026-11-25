-- 017(T-1322b②) 겸임은 앱이 직접 정한다 — 013 쓰기 전 트리거의 「저절로 겸임」 갈래를 걷는다.
-- 몇 번 돌려도 같은 결과(서버가 뜰 때마다 다시 돈다 · 013 이 먼저 돌며 옛 함수를 다시 만들어도 이 파일이 뒤에서 덮는다).
-- 겸임 판정은 server/link.js 의 hasPrimaryLine 하나 — 연결·겸임 데려오기·재직으로 되돌리기·보관함 되살리기가 부른다.
-- 판정을 빠뜨린 쓰기는 이제 조용히 겸임이 되지 않고 013 ⑨ 색인(membership_primary_uq)이 23505 로 막는다.

-- ① 트리거 함수: 이름 채우기만 남긴다(트리거 자체는 013 ③ 것을 그대로 쓴다)
CREATE OR REPLACE FUNCTION membership_fill_before_write() RETURNS trigger AS $$
BEGIN
  IF NEW.name IS NULL AND NEW.user_id IS NOT NULL THEN
    SELECT u.name INTO NEW.name FROM app_user u WHERE u.id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ② 겸임 끝 30일 전 소식을 낸 표시(이 날짜까지 다시 안 낸다 · 겸임 기간 정리 작업이 쓴다)
ALTER TABLE membership ADD COLUMN IF NOT EXISTS concurrent_warned_until DATE;
