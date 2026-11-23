-- 6번(T-1206) 한 수업에 교사 둘 — 열 추가만(선택 칸 · 기존 자료 안 바꿈 · 다시 돌려도 안전)
-- 시수표 줄: 둘째 교사 · 함께 들어가는 시수(NULL = 그 줄 시수 전부)
ALTER TABLE teaching_load ADD COLUMN IF NOT EXISTS second_membership_id BIGINT REFERENCES membership(id);
ALTER TABLE teaching_load ADD COLUMN IF NOT EXISTS second_hours INTEGER;
-- 시간표 칸: 둘째 교사
ALTER TABLE cell ADD COLUMN IF NOT EXISTS second_membership_id BIGINT REFERENCES membership(id);
