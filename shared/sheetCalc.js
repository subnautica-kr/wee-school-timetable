// 시간표 → 표(시트) 순수 계산. 서버 출력(PDF·엑셀·HWPX)과 자동 생성 결과 화면이 같은 함수를 부른다.
// d: { cells, classrooms, subjects, teachers, rooms, weekdays?, periodConfig? } — 서버든 브라우저 메모리든 같은 꼴.
// 시트: { title, header: [칸...], rows: [[칸...]] } · 칸: { text, kind: null|'changche'|'specialist', shade: bool }
import { periodsMax, periodsOn } from './periods.js';
import { teachersOf, hasTeacher } from './cellTeachers.js';
import { t } from './text/index.js';

export const DEFAULT_WEEKDAYS = ['월', '화', '수', '목', '금']; // 문구-예외: 출력 표 기존 글자 그대로(서버 출력과 같은 계산)
export const SHEET_DEFAULTS = { changcheNames: ['창의적체험활동', '창체'], shadeRoomKeywords: ['과학'] }; // 문구-예외: 출력 표 기존 글자 그대로(서버 출력과 같은 계산)

const daysOf = (d) => d.weekdays ?? DEFAULT_WEEKDAYS;
const FALLBACK_PERIODS = 6; // 학교 기본에 교시 수가 하나도 없을 때만

// 그 학년의 가장 긴 날 교시 수 — 없으면 다른 학년 가운데 가장 큰 값 — 그래도 없으면 fallback
function periodsOf(cfg, grade, fallback) {
  const g = cfg?.grades ?? {};
  const own = periodsMax(cfg, grade, 0);
  if (own > 0) return own;
  const all = Object.keys(g).map((k) => periodsMax(cfg, k, 0)).filter((n) => n > 0);
  return all.length ? Math.max(...all) : fallback;
}
const maxPeriods = (cfg, grades) => Math.max(1, ...grades.map((g) => periodsOf(cfg, g, FALLBACK_PERIODS)));
const className = (c) => `${c.grade}학년 ${c.class_no}반`; // 문구-예외: 출력 표 기존 글자 그대로(서버 출력과 같은 계산)

// 칸 하나의 글자·종류. opt: { teacher: 교사 이름 줄 · cls: 반 이름 줄(문자열) · room: 특별실 이름 줄 }
function cellView(c, ix, st, { teacher = true, cls = null, room = true } = {}) {
  const sub = ix.subject.get(Number(c.subject_id));
  const t1 = ix.teacher.get(Number(c.membership_id));
  const rm = ix.room.get(Number(c.special_room_id));
  const lines = [sub ? sub.short_name || sub.name : ''];
  if (cls) lines.push(cls);
  // 교사 이름: 「이 칸의 교사들」 — 둘째 교사가 있으면 「첫째·둘째」, 없으면 이름 하나
  const names = teachersOf(c).map((x) => ix.teacher.get(Number(x))?.name).filter(Boolean);
  if (teacher && names.length) lines.push(names.join('·'));
  if (room && rm) lines.push(rm.name);
  const isChangche = !!sub && [sub.name, sub.short_name].some((n) => n && st.changcheNames.includes(n));
  const kind = isChangche ? 'changche' : t1?.duty && t1.duty !== '담임' ? 'specialist' : null; // 문구-예외: 기존 판정 그대로
  const shade = !!rm && st.shadeRoomKeywords.some((k) => rm.name.includes(k));
  return { text: lines.filter(Boolean).join('\n'), kind, shade };
}

function index(d) {
  const by = (a) => new Map((a || []).map((x) => [Number(x.id), x])); // pg bigint 는 문자열 — 숫자로 맞춘다
  return { subject: by(d.subjects), teacher: by(d.teachers), room: by(d.rooms), classroom: by(d.classrooms) };
}

const head = (d) => [{ text: '' }, ...daysOf(d).map((x) => ({ text: x }))];

// 반 하나의 시트
export function classSheet(d, st, classroom) {
  const ix = index(d);
  const n = maxPeriods(d.periodConfig, [classroom.grade]);
  const own = d.cells.filter((c) => Number(c.classroom_id) === Number(classroom.id));
  const rows = [];
  for (let p = 1; p <= n; p++) {
    rows.push([{ text: `${p}교시` }, ...daysOf(d).map((_, i) => { // 문구-예외: 출력 표 기존 글자 그대로(서버 출력과 같은 계산)
      const c = own.find((x) => x.weekday === i + 1 && x.period === p);
      if (c) return cellView(c, ix, st); // 교시 수 밖이어도 있는 칸은 그대로 찍는다(지우지 않음)
      return { text: p > periodsOn(d.periodConfig, classroom.grade, i + 1, n) ? '—' : '' }; // 그날 수업 없는 교시(요일별 교시 수) // 문구-예외: 출력 표 기존 글자 그대로(서버 출력과 같은 계산)
    })]);
  }
  return { title: className(classroom), header: head(d), rows };
}

// 교사·특별실 시트의 공통 몸통: 고른 칸들을 요일×교시 표로
function ownerSheet(d, st, own, title, cellOf) {
  const ix = index(d);
  const n = maxPeriods(d.periodConfig, d.classrooms.map((c) => c.grade).concat(1));
  const rows = [];
  for (let p = 1; p <= n; p++) {
    rows.push([{ text: `${p}교시` }, ...daysOf(d).map((_, i) => { // 문구-예외: 출력 표 기존 글자 그대로(서버 출력과 같은 계산)
      const c = own.find((x) => x.weekday === i + 1 && x.period === p);
      return c ? cellOf(c, ix) : { text: '' };
    })]);
  }
  return { title, header: head(d), rows };
}

// 교사 하나의 시트 — 칸에 반 이름
export function teacherSheet(d, st, teacher) {
  const own = d.cells.filter((c) => hasTeacher(c, teacher.id));
  return ownerSheet(d, st, own, `${teacher.name} 선생님`, (c, ix) => { // 문구-예외: 출력 표 기존 글자 그대로(서버 출력과 같은 계산)
    const cl = ix.classroom.get(Number(c.classroom_id));
    return cellView(c, ix, st, { teacher: false, cls: cl ? className(cl) : null });
  });
}

// 특별실 하나의 시트 — 칸에 반 이름 + 교사
export function roomSheet(d, st, room) {
  const own = d.cells.filter((c) => Number(c.special_room_id) === Number(room.id));
  return ownerSheet(d, st, own, t('output.sheet.room_title', { 이름: room.name }), (c, ix) => {
    const cl = ix.classroom.get(Number(c.classroom_id));
    return cellView(c, ix, st, { teacher: true, cls: cl ? className(cl) : null, room: false });
  });
}

// view: 'class'(기본) | 'teacher' | 'room'. id 로 하나만 고를 수 있다.
export function buildSheets(d, st, { view = 'class', id = null } = {}) {
  const one = (x) => !id || Number(x.id) === Number(id);
  if (view === 'teacher') {
    return d.teachers.filter((x) => d.cells.some((c) => hasTeacher(c, x.id)) && one(x))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko')).map((x) => teacherSheet(d, st, x));
  }
  if (view === 'room') {
    return (d.rooms || []).filter((x) => d.cells.some((c) => Number(c.special_room_id) === Number(x.id)) && one(x))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko')).map((x) => roomSheet(d, st, x));
  }
  return d.classrooms.filter(one).map((c) => classSheet(d, st, c));
}
