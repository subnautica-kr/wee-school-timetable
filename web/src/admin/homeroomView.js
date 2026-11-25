// 순수: 명단 줄(rows: {id,name,duty}) + 반 목록(classes: {grade,class_no,homeroom_membership_id}) → 화면용.
// byMember: 교사 id → 「1-1·2-1」 글자 / noClass: 담임인데 맡은 반이 없는 교사 / noTeacher: 담임이 안 붙은 반 글자.
// 반 열 재대조: 담임이 빠졌는지는 재직·휴직 줄만 본다(전출·퇴직 줄은 반을 못 맡는 게 당연하다)
const GONE = ['전출', '숨김']; // 문구-예외: 저장 값(화면 낱말 아님)
const label = (c) => `${c.grade}-${c.class_no}`;
export function homeroomView(rows, classes) {
  const mine = new Map();
  const noTeacher = [];
  for (const c of classes || []) {
    const id = c.homeroom_membership_id == null ? null : Number(c.homeroom_membership_id);
    if (id === null) { noTeacher.push(label(c)); continue; }
    if (!mine.has(id)) mine.set(id, []);
    mine.get(id).push(label(c));
  }
  const byMember = {};
  for (const [id, ls] of mine) byMember[id] = ls.join('·');
  const noClass = (rows || []).filter((m) => m.duty === '담임' && !GONE.includes(m.listStatus) && !mine.has(Number(m.id))).map((m) => m.name);
  return { byMember, noClass, noTeacher };
}

// 순수: 재직 상태 바꾸기 응답 → 「담당이 빈」 건수. 바뀐 게 없거나 0 이면 null.
export function vacatedCounts(r) {
  const x = r?.status && typeof r.status === 'object' ? r.status : r;
  if (!x || x.same) return null;
  const 담임 = Number(x.homeroom) || 0, 수업 = Number(x.classes) || 0;
  return 담임 + 수업 > 0 ? { 담임, 수업 } : null;
}
// 순수: 고른 줄 집합 토글(새 Set 을 돌려준다)
export function toggleId(set, id) {
  const n = new Set(set);
  if (n.has(id)) n.delete(id); else n.add(id);
  return n;
}
