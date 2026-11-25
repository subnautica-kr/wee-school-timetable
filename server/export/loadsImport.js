import ExcelJS from 'exceljs';
import { CEIL } from '../orgConfig.js';
import { t, 값이름 } from '../../shared/text/index.js';

// 시수표 올리기 — 양식 · 표 읽기. 못 읽은 줄은 버리지 않고 사유와 함께 돌려준다(미리보기가 빨강으로 보인다).
// 열: 교사(이름 또는 로그인 ID) · 교과 · 학년 · 반 · 주당 시수 · 연강 · 둘째 교사 · 함께 시수. 새 열은 전부 선택 항목 — 연강·둘째 교사 열이 없어도 읽힌다.
export const LOAD_TEMPLATE_HEADER = ['교사(이름 또는 ID)', '교과', '학년', '반(비우면 그 학년 전체)', '주당 시수', '연강(○ 또는 비움)', '둘째 교사(선택)', '함께 시수(비우면 전부)'];

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
  const col = (re, dflt, not = null) => { const i = head ? head.findIndex((c) => re.test(c) && !(not && not.test(c))) : -1; return i >= 0 ? i : (head ? -1 : dflt); };
  const SECOND = /둘째|함께|보조|협력/; // 둘째 교사 열 머리 — 「교사」·「시수」 열 찾기에서 뺀다
  const ci = { who: col(/교사|선생/, 0, SECOND), sub: col(/교과|과목/, 1), grade: col(/^학년/, 2), cls: col(/^반/, 3), hours: col(/시수|시간/, 4, SECOND), block: col(/연강/, 5),
    who2: col(/둘째|협력|보조/, 6, /시수|시간/), hours2: col(/함께.*(시수|시간)|둘째.*(시수|시간)/, 7) };
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
    const findPerson = (name) => {
      const hit = people.filter((p) => norm(p.login_id) === norm(name));
      return hit.length ? hit : people.filter((p) => p.name === name);
    };
    if (!who) { why.push('교사 칸이 비어 있음'); teacherMissing = true; } else {
      const byName = findPerson(who);
      if (byName.length === 1) membership_id = Number(byName[0].membership_id);
      else if (byName.length > 1) { why.push('이름이 같은 분이 여럿 — ID로 적어 주세요'); teacherMissing = true; } else { why.push('교사를 찾지 못함'); teacherMissing = true; }
    }
    // 둘째 교사(선택 · 명단의 누구나) · 함께 시수(비우면 전부)
    const who2 = String(at(r, 'who2')).trim();
    let second_membership_id = null;
    let second_hours = null;
    if (who2) {
      const p2 = findPerson(who2);
      if (p2.length === 1) second_membership_id = Number(p2[0].membership_id);
      else why.push(p2.length > 1 ? '둘째 교사 이름이 같은 분이 여럿 — ID로 적어 주세요' : '둘째 교사를 찾지 못함');
      if (second_membership_id && second_membership_id === membership_id) { why.push('둘째 교사가 첫째 교사와 같음'); second_membership_id = null; }
      const h2raw = String(at(r, 'hours2')).trim();
      if (h2raw) {
        const h2 = num(h2raw);
        if (h2 == null) why.push('함께 시수를 읽지 못함');
        else if (hours > 0 && h2 > hours) why.push('함께 시수가 주당 시수보다 큼');
        else second_hours = h2;
      }
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
      membership_id, ...(who2 ? { second_teacher: who2, second_membership_id, second_hours } : {}), subject_id: sb ? Number(sb.id) : null, classroom_ids,
      ok: !why.length, blank_teacher_ok: onlyTeacher, reason: why.join(' · '),
    });
  });
  return out;
}

export async function makeLoadTemplate() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('시수표');
  ws.addRow(LOAD_TEMPLATE_HEADER).font = { bold: true };
  ws.addRow(['예) 가나다', '체육', 3, '1~4', 2, '○', '', '']);
  ws.addRow(['예) 가나다', '음악', 4, '', 2, '', '', '']);
  ws.addRow(['예) 라마바', '영어', '', '', 2, '', '예) 원어민', 1]);
  ws.columns.forEach((c) => { c.width = 18; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ───────── 엑셀 바닥(T-1301b③) — 시수표·고정금지 스펙. 학교(기관) 단위 줄만, 현재 학기 ─────────
// 스펙 꼴은 import.js 의 설명을 본다. 칸 글자는 지금 저장 값에서 만들고, 올린 글은 목록(이름·반·교과)에서 찾는다.
const STRICT_NUM = /^\d+$/;
const classText = (c) => `${c.grade}-${c.class_no}`;
const parseClass = (s) => { const m = /^(\d{1,2})\s*(?:학년|-|\s)\s*(\d{1,2})\s*(?:반)?$/.exec(s); return m ? [Number(m[1]), Number(m[2])] : null; };
const numIn = (s, head, min, max) => (STRICT_NUM.test(s) && Number(s) >= min && Number(s) <= max ? { value: Number(s) } : { error: t('school.excel_err.number', { 칸: head, 최소: min, 최대: max }) });

async function schoolCtx(db, orgId) {
  const term = (await db.query(`SELECT id FROM term WHERE org_id = $1 AND status = '진행' AND deleted_at IS NULL ORDER BY year DESC, semester DESC LIMIT 1`, [orgId])).rows[0] ?? null; // 문구-예외: 저장 값
  const people = (await db.query(
    `SELECT m.id, m.name, u.login_id FROM membership m LEFT JOIN app_user u ON u.id = m.user_id AND u.deleted_at IS NULL WHERE m.org_id = $1 AND m.deleted_at IS NULL AND m.role <> '시스템관리자' ORDER BY m.name, m.id`, [orgId], // 문구-예외: 저장 값
  )).rows.map((p) => ({ id: Number(p.id), name: p.name ?? '', login: p.login_id ?? '' }));
  const dupName = new Set(people.filter((p, i) => people.findIndex((q) => q.name === p.name) !== i).map((p) => p.name));
  const personText = (id) => { const p = people.find((x) => x.id === Number(id)); return p ? (dupName.has(p.name) && p.login ? p.login : p.name) : ''; };
  const findPerson = (s) => { const byLogin = people.filter((p) => p.login && norm(p.login) === norm(s)); return byLogin.length ? byLogin : people.filter((p) => p.name === s); };
  const rooms = (await db.query(`SELECT id, grade, class_no FROM classroom WHERE org_id = $1 AND term_id = $2 AND deleted_at IS NULL`, [orgId, term?.id ?? 0])).rows;
  const subjects = (await db.query(`SELECT id, name FROM subject WHERE org_id = $1 AND deleted_at IS NULL`, [orgId])).rows;
  const special = (await db.query(`SELECT id, name FROM special_room WHERE org_id = $1 AND deleted_at IS NULL`, [orgId])).rows;
  return { term, people, personText, findPerson, rooms, subjects, special };
}
// 이름으로 사람 찾기 → { id } | { error }
const pickPerson = (ctx, s) => {
  const hit = ctx.findPerson(s);
  if (hit.length === 1) return { id: hit[0].id };
  return { error: t(hit.length ? 'school.excel_err.same_name' : 'school.excel_err.not_found', { 값: s }) };
};
const pickSubject = (ctx, s) => { const h = ctx.subjects.find((x) => x.name === s); return h ? { id: Number(h.id) } : { error: t('school.excel_err.not_found', { 값: s }) }; };
const needTerm = (ctx) => { if (!ctx.term) throw Object.assign(new Error(t('school.excel_err.no_term')), { status: 409, expose: true, code: 'school.excel_err.no_term' }); return ctx.term.id; };

export const loadsSpec = {
  name: 'loads',
  get sheet() { return t('school.excel_loads.sheet'); },
  table: 'teaching_load',
  removable: true,
  cols: [
    { key: 'teacher', get head() { return t('school.excel_loads.teacher'); }, dbcols: ['membership_id'], required: true,
      read: (s, ctx) => { const p = pickPerson(ctx, s); return p.error ? p : { set: { membership_id: p.id } }; } },
    { key: 'subject', get head() { return t('school.excel_loads.subject'); }, dbcols: ['subject_id'], required: true,
      read: (s, ctx) => { const p = pickSubject(ctx, s); return p.error ? p : { set: { subject_id: p.id } }; } },
    { key: 'classroom', get head() { return t('school.excel_loads.classroom'); }, dbcols: ['classroom_id'],
      read: (s, ctx) => {
        if (!s) return { set: { classroom_id: null } };
        const g = parseClass(s);
        if (!g) return { error: t('school.excel_err.class_cell') };
        const c = ctx.rooms.find((x) => x.grade === g[0] && x.class_no === g[1]);
        return c ? { set: { classroom_id: Number(c.id) } } : { error: t('school.excel_err.not_found', { 값: s }) };
      } },
    { key: 'hours', get head() { return t('school.excel_loads.hours'); }, dbcols: ['weekly_hours'], required: true,
      read(s) { const n = numIn(s, this.head, 0, CEIL.loadPerWeek); return n.error ? n : { set: { weekly_hours: n.value } }; } },
    { key: 'block', get head() { return t('school.excel_loads.block'); }, dbcols: ['block'],
      read(s) { if (!s) return { set: { block: 1 } }; const n = numIn(s, this.head, 1, CEIL.block); return n.error ? n : { set: { block: n.value } }; } },
    { key: 'second', get head() { return t('school.excel_loads.second'); }, dbcols: ['second_membership_id'],
      read: (s, ctx) => { if (!s) return { set: { second_membership_id: null } }; const p = pickPerson(ctx, s); return p.error ? p : { set: { second_membership_id: p.id } }; } },
    { key: 'second_hours', get head() { return t('school.excel_loads.second_hours'); }, dbcols: ['second_hours'],
      read(s) { if (!s) return { set: { second_hours: null } }; const n = numIn(s, this.head, 0, CEIL.loadPerWeek); return n.error ? n : { set: { second_hours: n.value } }; } },
  ],
  context: schoolCtx,
  rows: async (db, orgId, ctx) => (await db.query(
    `SELECT id, membership_id, subject_id, classroom_id, weekly_hours, block, second_membership_id, second_hours FROM teaching_load
      WHERE org_id = $1 AND term_id = $2 AND deleted_at IS NULL ORDER BY id`,
    [orgId, ctx.term?.id ?? 0],
  )).rows.map((r) => {
    const room = ctx.rooms.find((x) => Number(x.id) === Number(r.classroom_id));
    return {
      id: Number(r.id),
      text: {
        teacher: r.membership_id ? ctx.personText(r.membership_id) : '',
        subject: ctx.subjects.find((x) => Number(x.id) === Number(r.subject_id))?.name ?? '',
        classroom: room ? classText(room) : '',
        hours: String(r.weekly_hours ?? 0),
        block: r.block > 1 ? String(r.block) : '',
        second: r.second_membership_id ? ctx.personText(r.second_membership_id) : '',
        second_hours: r.second_hours == null ? '' : String(r.second_hours),
      },
      set: {},
    };
  }),
  insert: async (db, orgId, set, ctx) => Number((await db.query(
    `INSERT INTO teaching_load (org_id, term_id, membership_id, subject_id, classroom_id, weekly_hours, block, second_membership_id, second_hours) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [orgId, needTerm(ctx), set.membership_id ?? null, set.subject_id ?? null, set.classroom_id ?? null, set.weekly_hours ?? 0, set.block ?? 1, set.second_membership_id ?? null, set.second_hours ?? null],
  )).rows[0].id),
};

const TARGET_KINDS = ['교사', '반', '특별실']; // 문구-예외: 저장 값
const PIN_KINDS = ['고정', '금지']; // 문구-예외: 저장 값
const KIND_OF = (word) => TARGET_KINDS.find((k) => 값이름('pin.target_kind', k) === word || k === word);
const dayChars = () => [...t('school.excel_pins.weekdays')];
const pickTarget = (ctx, kind, s) => {
  if (kind === TARGET_KINDS[0]) return pickPerson(ctx, s);
  if (kind === TARGET_KINDS[1]) {
    const g = parseClass(s);
    const c = g && ctx.rooms.find((x) => x.grade === g[0] && x.class_no === g[1]);
    return c ? { id: Number(c.id) } : { error: g ? t('school.excel_err.not_found', { 값: s }) : t('school.excel_err.class_cell') };
  }
  const sp = ctx.special.find((x) => x.name === s);
  return sp ? { id: Number(sp.id) } : { error: t('school.excel_err.not_found', { 값: s }) };
};
// 「대상 종류」·「대상」 두 칸은 얽혀 있어 어느 쪽을 고쳐도 종류와 번호를 같이 다시 정한다 — 짝이 어긋나지 않는다
const readTarget = (cells, ctx) => {
  const kind = KIND_OF(cells.target_kind);
  if (!kind) return { error: t('school.excel_err.pin_target_kind') };
  const p = pickTarget(ctx, kind, cells.target);
  return p.error ? p : { set: { target_kind: kind, target_id: p.id } };
};
const targetText = (ctx, kind, id) => {
  if (kind === TARGET_KINDS[0]) return ctx.personText(id);
  if (kind === TARGET_KINDS[1]) { const c = ctx.rooms.find((x) => Number(x.id) === Number(id)); return c ? classText(c) : ''; }
  return ctx.special.find((x) => Number(x.id) === Number(id))?.name ?? '';
};

export const pinsSpec = {
  name: 'pins',
  get sheet() { return t('school.excel_pins.sheet'); },
  table: 'pin',
  removable: true,
  cols: [
    { key: 'target_kind', get head() { return t('school.excel_pins.target_kind'); }, dbcols: ['target_kind', 'target_id'], required: true, read: (s, ctx, cells) => readTarget(cells, ctx) },
    { key: 'target', get head() { return t('school.excel_pins.target'); }, dbcols: ['target_kind', 'target_id'], required: true, read: (s, ctx, cells) => readTarget(cells, ctx) },
    { key: 'weekday', get head() { return t('school.excel_pins.weekday'); }, dbcols: ['weekday'], required: true,
      read: (s) => { const i = s.length === 1 ? dayChars().indexOf(s) : -1; return i >= 0 ? { set: { weekday: i + 1 } } : { error: t('school.excel_err.weekday') }; } },
    { key: 'period', get head() { return t('school.excel_pins.period'); }, dbcols: ['period'], required: true,
      read(s) { const n = numIn(s, this.head, 1, CEIL.periods); return n.error ? n : { set: { period: n.value } }; } },
    { key: 'kind', get head() { return t('school.excel_pins.kind'); }, dbcols: ['kind'], required: true,
      read: (s) => { const k = PIN_KINDS.find((x) => 값이름('pin.kind', x) === s || x === s); return k ? { set: { kind: k } } : { error: t('school.excel_err.pin_kind') }; } },
    { key: 'subject', get head() { return t('school.excel_pins.subject'); }, dbcols: ['subject_id'],
      read: (s, ctx) => { if (!s) return { set: { subject_id: null } }; const p = pickSubject(ctx, s); return p.error ? p : { set: { subject_id: p.id } }; } },
  ],
  context: schoolCtx,
  rows: async (db, orgId, ctx) => (await db.query(
    `SELECT id, target_kind, target_id, weekday, period, kind, subject_id FROM pin WHERE org_id = $1 AND term_id = $2 AND deleted_at IS NULL ORDER BY target_kind, target_id, weekday, period, id`,
    [orgId, ctx.term?.id ?? 0],
  )).rows.map((r) => ({
    id: Number(r.id),
    text: {
      target_kind: 값이름('pin.target_kind', r.target_kind),
      target: targetText(ctx, r.target_kind, r.target_id),
      weekday: dayChars()[r.weekday - 1] ?? '',
      period: String(r.period),
      kind: 값이름('pin.kind', r.kind),
      subject: ctx.subjects.find((x) => Number(x.id) === Number(r.subject_id))?.name ?? '',
    },
    set: {},
  })),
  insert: async (db, orgId, set, ctx) => Number((await db.query(
    `INSERT INTO pin (org_id, term_id, target_kind, target_id, weekday, period, kind, subject_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [orgId, needTerm(ctx), set.target_kind, set.target_id, set.weekday, set.period, set.kind, set.subject_id ?? null],
  )).rows[0].id),
};
