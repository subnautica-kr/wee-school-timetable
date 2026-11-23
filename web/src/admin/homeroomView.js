// 순수: 명단 줄(rows: {id,name,duty}) + 반 목록(classes: {grade,class_no,homeroom_membership_id}) → 화면용.
// byMember: 교사 id → 「1-1·2-1」 글자 / noClass: 담임인데 맡은 반이 없는 교사 / noTeacher: 담임이 안 붙은 반 글자.
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
  const noClass = (rows || []).filter((m) => m.duty === '담임' && m.listStatus !== '숨김' && !mine.has(Number(m.id))).map((m) => m.name);
  return { byMember, noClass, noTeacher };
}
