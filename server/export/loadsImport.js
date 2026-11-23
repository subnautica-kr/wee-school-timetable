import ExcelJS from 'exceljs';
import { CEIL } from '../orgConfig.js';

// 시수표 올리기 — 양식 · 표 읽기. 못 읽은 줄은 버리지 않고 사유와 함께 돌려준다(미리보기가 빨강으로 보인다).
// 열: 교사(이름 또는 로그인 ID) · 교과 · 학년 · 반 · 주당 시수 · 연강. 새 열은 전부 선택 항목 — 연강 열이 없어도 읽힌다.
export const LOAD_TEMPLATE_HEADER = ['교사(이름 또는 ID)', '교과', '학년', '반(비우면 그 학년 전체)', '주당 시수', '연강(○ 또는 비움)'];

// 반 칸 풀이: '' → 전체(null) · '1,3,5' · '1~4' · '1-4'. 읽지 못하면 { bad }.
export function parseClassCell(raw) {
  const t = String(raw ?? '').replace(/반/g, '').replace(/\s+/g, '').replace(/[∼～―–—]/g, '~');
  if (!t) return { all: true, nums: [] };
  const nums = new Set();
  for (const part of t.split(/[,，、·]/)) {
    if (!part) continue;
    const m = /^(\d+)(?:[~-](\d+))?$/.exec(part);
    if (!m) return { bad: `반 칸을 읽지 못함(「${raw}」)` };
    const a = Number(m[1]); const b = m[2] ? Number(m[2]) : a;
    if (b < a || b - a > CEIL.classNo) return { bad: `반 범위가 이상함(「${raw}」)` };
    for (let i = a; i <= b; i++) nums.add(i);
  }
  return nums.size ? { all: false, nums: [...nums].sort((x, y) => x - y) } : { all: true, nums: [] };
}

// 연강 칸: 비움·아니오·0 → 1(낱개) · ○ 예 Y 연강 → 2 · 숫자 → 그 시수
const YES = /^(o|y|yes|true|○|◯|✓|v|예|네|연강|있음)$/i;
const NO = /^(x|n|no|false|×|아니오|아니요|없음|-)$/i;
export function parseBlock(raw) {
  const t = String(raw ?? '').trim();
  if (!t || NO.test(t)) return { block: 1 };
  if (YES.test(t)) return { block: 2 };
  const m = /^(\d+)\s*(시수|시간)?$/.exec(t);
  if (!m) return { bad: `연강 칸을 읽지 못함(「${raw}」)` };
  const n = Number(m[1]);
  if (n > CEIL.block) return { bad: `연강이 한도 ${CEIL.block}을 넘음` };
  return { block: Math.max(1, n) };
}

const norm = (s) => String(s ?? '').trim().toLowerCase();

// table: 문자열 2차원 배열(readTable). people: [{membership_id,name,login_id}] · classrooms · subjects
export function parseLoadRows(table, { people, classrooms, subjects }) {
  const hi = table.findIndex((r) => r.some((c) => /교과|과목/.test(c)) && r.some((c) => /교사|선생|시수/.test(c)));
  const head = hi >= 0 ? table[hi] : null;
  const col = (re, dflt) => { const i = head ? head.findIndex((c) => re.test(c)) : -1; return i >= 0 ? i : (head ? -1 : dflt); };
  const ci = { who: col(/교사|선생/, 0), sub: col(/교과|과목/, 1), grade: col(/^학년/, 2), cls: col(/^반/, 3), hours: col(/시수|시간/, 4), block: col(/연강/, 5) };
  const at = (r, k) => (ci[k] >= 0 ? (r[ci[k]] ?? '') : '');
  const bySub = new Map(subjects.map((s) => [norm(s.name), s]).concat(subjects.filter((s) => s.short_name).map((s) => [norm(s.short_name), s])));
  const out = [];
  table.forEach((r, i) => {
    if (i === hi || !r.some((c) => c)) return;
    if (hi < 0 && i === 0 && !/\d/.test(`${at(r, 'grade')}${at(r, 'hours')}`)) return; // 머리 없는 파일의 제목 줄
    const who = String(at(r, 'who')).trim();
    const subName = String(at(r, 'sub')).trim();
    const num = (v) => { const m = /\d+/.exec(String(v ?? '')); return m ? Number(m[0]) : null; };
    const gradeRaw = String(at(r, 'grade')).trim();
    const grade = gradeRaw ? num(gradeRaw) : null;
    const hours = num(at(r, 'hours'));
    const why = [];
    let teacherMissing = false;
    let membership_id = null;
    if (!who) { why.push('교사 칸이 비어 있음'); teacherMissing = true; } else {
      const hit = people.filter((p) => norm(p.login_id) === norm(who));
      const byName = hit.length ? hit : people.filter((p) => p.name === who);
      if (byName.length === 1) membership_id = Number(byName[0].membership_id);
      else if (byName.length > 1) { why.push('이름이 같은 분이 여럿 — ID로 적어 주세요'); teacherMissing = true; } else { why.push('교사를 찾지 못함'); teacherMissing = true; }
    }
    const sb = bySub.get(norm(subName));
    if (!sb) why.push(subName ? '교과를 찾지 못함' : '교과 칸이 비어 있음');
    if (!(hours > 0)) why.push('시수를 읽지 못함');
    else if (hours > CEIL.loadPerWeek) why.push(`시수가 한도 ${CEIL.loadPerWeek}를 넘음`);
    const blk = parseBlock(at(r, 'block'));
    if (blk.bad) why.push(blk.bad);
    // 반: 학년·반 모두 비움 = 학교 전체(classroom_id 비움) · 학년만 = 그 학년 전체 · 학년+반 목록
    const pc = parseClassCell(at(r, 'cls'));
    let classroom_ids = null; // null = 학교 전체
    let target = '학교 전체';
    if (pc.bad) why.push(pc.bad);
    else if (gradeRaw && grade == null) why.push('학년을 읽지 못함');
    else if (grade == null) {
      if (!pc.all) why.push('학년 없이 반만 적었음');
    } else {
      const inGrade = classrooms.filter((c) => c.grade === grade);
      const picked = pc.all ? inGrade : inGrade.filter((c) => pc.nums.includes(c.class_no));
      const lost = pc.all ? [] : pc.nums.filter((n) => !inGrade.some((c) => c.class_no === n));
      if (!inGrade.length) why.push(`${grade}학년에 반이 없음`);
      else if (lost.length) why.push(`${grade}학년 ${lost.join('·')}반을 찾지 못함`);
      classroom_ids = picked.map((c) => Number(c.id));
      target = pc.all ? `${grade}학년 전체(${picked.length}반)` : `${grade}학년 ${pc.nums.join('·')}반`;
    }
    // 교사만 못 맞춘 줄(다른 건 다 읽힘)은 「교사 빈 줄로 받기」로 고를 수 있다
    const onlyTeacher = teacherMissing && why.length === 1;
    out.push({
      line: i + 1, teacher: who, subject: subName, grade, cls: String(at(r, 'cls')).trim(), hours, block: blk.block ?? 1, target,
      membership_id, subject_id: sb ? Number(sb.id) : null, classroom_ids,
      ok: !why.length, blank_teacher_ok: onlyTeacher, reason: why.join(' · '),
    });
  });
  return out;
}

export async function makeLoadTemplate() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('시수표');
  ws.addRow(LOAD_TEMPLATE_HEADER).font = { bold: true };
  ws.addRow(['예) 가나다', '체육', 3, '1~4', 2, '○']);
  ws.addRow(['예) 가나다', '음악', 4, '', 2, '']);
  ws.addRow(['예) 라마바', '영어', '', '', 1, '']);
  ws.columns.forEach((c) => { c.width = 18; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
