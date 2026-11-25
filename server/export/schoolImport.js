import { CEIL } from '../orgConfig.js';
import { t } from '../../shared/text/index.js';

// 엑셀 바닥 스펙 둘(T-1308) — 「학교 기본」(한 줄에 한 학년) · 「특별실」. 틀(스펙 꼴)은 import.js 의 설명을 본다.
// 학년 줄은 표의 한 줄이 아니라 반 여럿 + 교시 설정이라, 스펙에 write(db, orgId, x, ctx, item)를 둔다 — applyPlans 가 insert/UPDATE 대신 이걸 부른다.
// item(table, rowId, column, 옛값JSON, 새값JSON)으로 되돌리기 기록을 남긴다. 되돌릴 표·칸은 undo 에 적는다(허용 집합).
const STRICT_NUM = /^\d+$/;
const numIn = (s, head, min, max) => (STRICT_NUM.test(s) && Number(s) >= min && Number(s) <= max ? { value: Number(s) } : { error: t('school.excel_err.number', { 칸: head, 최소: min, 최대: max }) });
const J = (v) => JSON.stringify(v ?? null);
const expose = (status, key, vars) => Object.assign(new Error(t(key, vars)), { status, expose: true, code: key });

async function gradeCtx(db, orgId) {
  const term = (await db.query(`SELECT id FROM term WHERE org_id = $1 AND status = '진행' AND deleted_at IS NULL ORDER BY year DESC, semester DESC LIMIT 1`, [orgId])).rows[0] ?? null; // 문구-예외: 저장 값
  const classes = new Map(); // 학년 → 가장 큰 반 번호
  if (term) {
    for (const r of (await db.query(`SELECT grade, max(class_no)::int AS n FROM classroom WHERE org_id = $1 AND term_id = $2 AND deleted_at IS NULL GROUP BY grade`, [orgId, term.id])).rows) classes.set(Number(r.grade), r.n);
  }
  const pc = (await db.query(`SELECT period_config FROM org WHERE id = $1`, [orgId])).rows[0]?.period_config ?? {};
  return { term, classes, pc };
}

const gradeOfCells = (cells) => (STRICT_NUM.test(cells.grade ?? '') ? Number(cells.grade) : null);

export const gradeSpec = {
  name: 'school',
  get sheet() { return t('school.excel_school.sheet'); },
  table: 'classroom',
  removable: false, // 반 줄이기·지우기는 반 목록(되살리기 있는 길)이 맡는다
  undo: { classroom: ['grade', 'class_no'], org: ['period_config'] },
  cols: [
    { key: 'grade', get head() { return t('school.excel_school.grade'); }, dbcols: ['grade', 'class_no'], required: true,
      read(s) { const n = numIn(s, this.head, 1, CEIL.grades); return n.error ? n : { set: { grade: n.value } }; } },
    { key: 'classes', get head() { return t('school.excel_school.classes'); }, dbcols: [],
      read(s, ctx, cells) {
        if (!s) return { set: {} };
        const n = numIn(s, this.head, 0, CEIL.classNo);
        if (n.error) return n;
        const g = gradeOfCells(cells);
        const now = g == null ? 0 : ctx.classes.get(g) ?? 0;
        if (n.value < now) return { error: t('school.excel_err.class_shrink', { 학년: g, 현재: now, 바꿀: n.value }) };
        return { set: { classes: n.value } };
      } },
    { key: 'periods', get head() { return t('school.excel_school.periods'); }, dbcols: [],
      read(s) { if (!s) return { set: {} }; const n = numIn(s, this.head, 1, CEIL.periods); return n.error ? n : { set: { periods: n.value } }; } },
    { key: 'lunch_after', get head() { return t('school.excel_school.lunch_after'); }, dbcols: [],
      read(s) { if (!s) return { set: {} }; const n = numIn(s, this.head, 0, CEIL.periods); return n.error ? n : { set: { lunch_after: n.value } }; } },
  ],
  context: gradeCtx,
  rows: async (db, orgId, ctx) => {
    const grades = new Set([...ctx.classes.keys(), ...Object.keys(ctx.pc?.grades ?? {}).map(Number).filter((g) => g > 0)]);
    return [...grades].sort((a, b) => a - b).map((g) => {
      const cfg = ctx.pc?.grades?.[g] ?? {};
      return {
        id: g,
        text: { grade: String(g), classes: ctx.classes.has(g) ? String(ctx.classes.get(g)) : '', periods: cfg.periods ? String(cfg.periods) : '', lunch_after: cfg.lunchAfter != null ? String(cfg.lunchAfter) : '' },
        set: {},
      };
    });
  },
  async write(db, orgId, x, ctx, item) {
    if (!ctx.term) throw expose(409, 'school.excel_err.no_term');
    const g = x.set.grade ?? x.id;
    if (x.set.classes != null) {
      for (let k = 1; k <= x.set.classes; k++) {
        const ins = await db.query(`INSERT INTO classroom (org_id, term_id, grade, class_no) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`, [orgId, ctx.term.id, g, k]);
        if (ins.rows[0]) await item('classroom', Number(ins.rows[0].id), null, null, J({ grade: String(g), class_no: String(k) }));
      }
    }
    const gradeKnown = (await db.query(`SELECT 1 FROM classroom WHERE org_id = $1 AND term_id = $2 AND grade = $3 AND deleted_at IS NULL LIMIT 1`, [orgId, ctx.term.id, g])).rows[0];
    const wantPc = x.set.periods != null || x.set.lunch_after != null || (gradeKnown && x.set.classes != null);
    if (!wantPc) return;
    const was = (await db.query(`SELECT period_config::text AS v FROM org WHERE id = $1`, [orgId])).rows[0]?.v ?? null;
    const pc = JSON.parse(was ?? '{}') ?? {};
    pc.grades = { ...(pc.grades ?? {}) };
    const own = { ...(pc.grades[g] ?? {}) };
    if (x.set.periods != null) own.periods = x.set.periods;
    if (x.set.lunch_after != null) own.lunchAfter = x.set.lunch_after;
    if (!own.periods) own.periods = g <= 2 ? 5 : 6; // 빠른 시작과 같은 처음 값
    pc.grades[g] = own;
    await db.query(`UPDATE org SET period_config = $2 WHERE id = $1`, [orgId, JSON.stringify(pc)]);
    const now = (await db.query(`SELECT period_config::text AS v FROM org WHERE id = $1`, [orgId])).rows[0].v;
    if (now !== was) await item('org', orgId, 'period_config', J(was), J(now));
  },
};

const PURPOSES = ['수업용', '예약용']; // 문구-예외: 저장 값
export const roomsSpec = {
  name: 'rooms',
  get sheet() { return t('school.excel_rooms.sheet'); },
  table: 'special_room',
  removable: false, // 특별실 지우기는 딸린 시수·고정·예약을 같이 정리해야 해서 지우기 길이 맡는다
  cols: [
    { key: 'name', get head() { return t('school.excel_rooms.name'); }, dbcols: ['name'], required: true, max: 40,
      read: (s) => (s.length > 40 ? { error: t('school.excel_err.number', { 칸: t('school.excel_rooms.name'), 최소: 1, 최대: 40 }) } : { set: { name: s } }) },
    { key: 'purpose', get head() { return t('school.excel_rooms.purpose'); }, dbcols: ['purpose'], list: () => PURPOSES,
      read: (s) => (!s ? { set: { purpose: PURPOSES[0] } } : PURPOSES.includes(s) ? { set: { purpose: s } } : { error: t('school.excel_err.purpose') }) },
    { key: 'capacity', get head() { return t('school.excel_rooms.capacity'); }, dbcols: ['capacity'],
      read(s) { if (!s) return { set: { capacity: null } }; const n = numIn(s, this.head, 0, CEIL.capacity); return n.error ? n : { set: { capacity: n.value } }; } },
  ],
  context: async () => ({}),
  rows: async (db, orgId) => (await db.query(`SELECT id, name, purpose, capacity FROM special_room WHERE org_id = $1 AND deleted_at IS NULL ORDER BY id`, [orgId])).rows
    .map((r) => ({ id: Number(r.id), text: { name: r.name ?? '', purpose: r.purpose ?? '', capacity: r.capacity == null ? '' : String(r.capacity) }, set: {} })),
  insert: async (db, orgId, set) => Number((await db.query(
    `INSERT INTO special_room (org_id, name, purpose, capacity) VALUES ($1,$2,$3,$4) RETURNING id`,
    [orgId, set.name, set.purpose ?? PURPOSES[0], set.capacity ?? null],
  )).rows[0].id),
};
