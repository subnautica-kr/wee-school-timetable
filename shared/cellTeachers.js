// 「이 칸의 교사들」 — 한 칸(또는 시수표 한 줄)에 든 교사 id 목록. 첫째 교사(membership_id) + 둘째 교사(second_membership_id, 6번 T-1206).
// 교사를 묻는 곳(겹침·내 시간표·보결·생성·출력·시수 합)은 이 파일을 거친다. 둘째 교사가 없는 칸은 지금과 같이 [첫째] 하나다.
const blank = (v) => v == null || v === '' || v === 0;

export function teachersOf(c) {
  if (!c) return [];
  const out = [];
  for (const v of [c.membership_id, c.second_membership_id]) {
    if (blank(v)) continue;
    if (!out.some((x) => String(x) === String(v))) out.push(v);
  }
  return out;
}

// 이 칸에 그 교사가 드는가(첫째든 둘째든)
export const hasTeacher = (c, id) => !blank(id) && teachersOf(c).some((x) => String(x) === String(id));

// 둘째 교사로만 드는가(첫째는 아님)
export const isSecondOnly = (c, id) => hasTeacher(c, id) && String(c.membership_id) !== String(id);

// SQL 조각: 칸 별칭 a 의 교사들 중에 파라미터 p 가 있나 — `WHERE ${teacherSql('c', '$3')}`
export const teacherSql = (a, p) => `(${a}.membership_id = ${p} OR ${a}.second_membership_id = ${p})`;
