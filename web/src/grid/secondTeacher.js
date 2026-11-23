// 순수: 둘째 교사(T-1206) 화면 계산. 서버·생성기와 같은 「이 칸의 교사들」(shared/cellTeachers.js)을 거친다.
import { teachersOf, hasTeacher } from '../../../shared/cellTeachers.js';

const same = (a, b) => String(a) === String(b);

// 칸 쪽 한 줄 표시용 이름들 — 첫째·둘째 순서. list 는 {id,name}.
export function teacherNames(cell, list) {
  return teachersOf(cell).map((id) => (list || []).find((x) => same(x.id, id))?.name).filter(Boolean);
}

// 이 칸(같은 요일·교시)에 고른 교사가 다른 반 칸에 이미 들어 있나 — 막지 않고 알리기 위한 목록.
// pick: {classroom_id, weekday, period, membership_id, second_membership_id}
export function teacherClashes(cells, pick) {
  const ids = teachersOf(pick);
  const out = [];
  for (const c of cells || []) {
    if (c.weekday !== pick.weekday || c.period !== pick.period || same(c.classroom_id, pick.classroom_id)) continue;
    for (const id of ids) if (hasTeacher(c, id)) out.push({ membership_id: id, classroom_id: c.classroom_id });
  }
  return out;
}

// 칸 편집 창의 알림 문구. nameOf(id), classLabel(classroom_id) 는 화면이 준다.
export function clashText(clashes, nameOf, classLabel) {
  return clashes.map((x) => `${nameOf(x.membership_id) || '교사'} 선생님은 같은 시각 ${classLabel(x.classroom_id)}에 이미 들어 있습니다`).join(' · ');
}

// 둘째 교사로만 든 칸인가(내 시간표의 「둘째」 표시)
export const isSecondMark = (c) => c?.second === true;
