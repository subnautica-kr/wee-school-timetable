import { t } from '../../../shared/text/index.js';
// 순수: 「담당 비었음」 이름 찾기(T-1327b). 재직 선생님 목록(teachers)에 없으면 재직 아닌 목록(inactive_teachers)에서 찾는다.
const same = (a, b) => String(a) === String(b);

// → { name, vacant } | null. vacant=true 면 재직이 아닌 선생님(전출·휴직·퇴직)이라 담당이 빈 것이다.
export function findPerson(id, teachers, inactive) {
  if (id == null || id === '') return null;
  const a = (teachers || []).find((x) => same(x.id ?? x.membership_id, id));
  if (a) return { name: a.name, vacant: false };
  const b = (inactive || []).find((x) => same(x.id, id));
  return b ? { name: b.name, status: b.status, vacant: true } : null;
}


// 현재 고른 값이 재직 아닌 선생님이면 드롭다운이 이름을 보이게 비활성 항목 하나를 덧붙인다. 고를 수는 없다.
export function withCurrent(options, value, inactive, label) {
  if (value == null || value === '' || options.some((o) => same(o.value, value))) return options;
  const b = (inactive || []).find((x) => same(x.id, value));
  return b ? [...options, { value: String(b.id), label: label(b), disabled: true }] : options;
}

// 화면 글자 — 문구 변수를 여기서 채워 화면 파일에는 한국어 글자가 새지 않게 한다.
export const markedName = (name) => t('grid.vacant.name_mark', { 이름: name, 표시: t('grid.vacant.mark') });
export const vacantText = {
  title: (n) => t('school.vacant.title', { 개수: n }),
  who: (x) => t('school.vacant.who', { 이름: x.name, 상태: x.status }),
  homeroom: (h) => t('school.vacant.homeroom', { 학년: h.grade, 반: h.class_no }),
  load: (l) => (l.classroom_id
    ? t('school.vacant.load_line', { 학년: l.grade, 반: l.class_no, 과목: l.subject_name ?? '', 시수: l.weekly_hours })
    : t('school.vacant.load_line_all', { 과목: l.subject_name ?? '', 시수: l.weekly_hours })),
  genLine: (n) => t('generate.vacant.line', { 개수: n }),
};
