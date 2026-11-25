// 시간표 격자 엑셀 왕복(T-1304b) — 내려받기(반별 정본 · 교사별·특별실별 보기 · 도움말) → 올린 「반별」 시트 읽기 → 반영 계획 → 반영.
// 되돌리기는 명단 엑셀의 undoExcel 을 그대로 쓴다(import.js allowedCols 의 cell 칸 넷).
// 읽기: 지금 값으로 그린 글자와 같으면 손 안 댄 칸. 다르면 고르게(전각→반각·공백 접기·소문자) 한 뒤 토막을 교과·선생님·특별실에 맞춘다.
import ExcelJS from 'exceljs';
import { t } from '../../shared/text/index.js';
import { loadSheetData, buildSheets, classSheet } from './data.js';
import { DEFAULT_WEEKDAYS, SHEET_DEFAULTS } from '../../shared/sheetCalc.js';
import { GRID_CELL_COLS, readWorkbook } from './import.js';
import { CEIL } from '../orgConfig.js';

const CELL_COLS = ['id', 'classroom_id', 'weekday', 'period', ...GRID_CELL_COLS].join(', ');
const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
const J = (v) => JSON.stringify(v ?? null);
const err = (status, key, vars) => Object.assign(new Error(t(key, vars)), { status, expose: true, code: key });

// 고르기: 전각→반각(NFKC) · 공백 접기 · 소문자
export const norm = (s) => String(s ?? '').normalize('NFKC').replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').trim().toLowerCase();
const flat = (s) => norm(s).replace(/\s+/g, '');
const EMPTY_MARKS = new Set(['', '—', '–', '-']);
const SPLIT = /[()[\],/·・|@\n]+/;
const TRAIL = /(…|\.{2,})$/;

// 시간표 + 칸(번호 포함) + 맞춤 목록(지운 교과·특별실은 뺌)
export async function loadGrid(db, orgId, ttId) {
  const d = await loadSheetData(db, orgId, ttId);
  if (!d) return null;
  d.cells = (await db.query(`SELECT ${CELL_COLS} FROM cell WHERE org_id = $1 AND timetable_id = $2 AND deleted_at IS NULL`, [orgId, ttId])).rows;
  d.live = {
    subjects: (await db.query(`SELECT id, name, short_name FROM subject WHERE org_id = $1 AND deleted_at IS NULL`, [orgId])).rows,
    rooms: (await db.query(`SELECT id, name FROM special_room WHERE org_id = $1 AND deleted_at IS NULL`, [orgId])).rows,
  };
  return d;
}

const days = (d) => d.weekdays ?? DEFAULT_WEEKDAYS;

// 내려받기 — 반별(고치는 곳) · 교사별·특별실별(보기) · 도움말
export async function makeGridWorkbook(d) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(t('grid.excel.sheet_class'));
  ws.addRow([t('grid.excel.head_class'), t('grid.excel.head_period'), ...days(d)]).eachCell((c) => { c.font = { bold: true }; c.fill = HEAD_FILL; });
  for (const cl of d.classrooms) {
    const sh = classSheet(d, SHEET_DEFAULTS, cl);
    for (const row of sh.rows) ws.addRow([sh.title, row[0].text, ...row.slice(1).map((c) => c.text)]);
  }
  ws.getColumn(1).width = 12;
  ws.getColumn(2).width = 8;
  for (let i = 3; i <= 2 + days(d).length; i++) { ws.getColumn(i).width = 16; ws.getColumn(i).alignment = { wrapText: true, vertical: 'top' }; }
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];
  for (const [key, view] of [['grid.excel.sheet_teacher', 'teacher'], ['grid.excel.sheet_room', 'room']]) {
    const vs = wb.addWorksheet(t(key));
    for (const sh of buildSheets(d, SHEET_DEFAULTS, { view })) {
      vs.addRow([sh.title]).font = { bold: true };
      vs.addRow(sh.header.map((h) => h.text)).eachCell((c) => { c.fill = HEAD_FILL; });
      for (const row of sh.rows) vs.addRow(row.map((c) => c.text));
      vs.addRow([]);
    }
    for (let i = 2; i <= 1 + days(d).length; i++) { vs.getColumn(i).width = 16; vs.getColumn(i).alignment = { wrapText: true, vertical: 'top' }; }
  }
  const help = wb.addWorksheet(t('grid.excel.sheet_help'));
  ['help_title', 'help_edit', 'help_cell', 'help_loose', 'help_skip', 'help_flow']
    .forEach((k, i) => { help.addRow([t(`grid.excel.${k}`)]).font = { bold: i === 0 }; });
  help.getColumn(1).width = 100;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// 맞춤 사전 — 교과(이름·줄임말) · 선생님 · 특별실
function dictOf(d) {
  const ents = [];
  for (const s of d.live.subjects) for (const n of [s.name, s.short_name]) if (n) ents.push({ kind: 'subject', id: Number(s.id), key: flat(n) });
  for (const m of d.teachers) if (m.name) ents.push({ kind: 'teacher', id: Number(m.id), key: flat(m.name) });
  for (const r of d.live.rooms) if (r.name) ents.push({ kind: 'room', id: Number(r.id), key: flat(r.name) });
  return ents.filter((e) => e.key);
}
const uniq = (hits) => [...new Map(hits.map((e) => [`${e.kind}:${e.id}`, e])).values()];
const inOrder = (tok, key) => { let i = 0; for (const ch of key) if (ch === tok[i]) i++; return i === tok.length; };

// 토막 하나 → { ent } | { many } | { none }. 차례: 정확히 → 앞부분 하나로만(끝 … 뗌) → 교과만 글자 순서 하나로만
function matchToken(tok, dict) {
  const k = flat(tok);
  const pick = (hits) => { const u = uniq(hits); return u.length === 1 ? { ent: u[0] } : u.length ? { many: true } : null; };
  const exact = pick(dict.filter((e) => e.key === k));
  if (exact) return exact;
  const head = k.replace(TRAIL, '');
  if (head) {
    const pre = pick(dict.filter((e) => e.key.startsWith(head)));
    if (pre) return pre;
  }
  if (head.length >= 2) {
    const sub = pick(dict.filter((e) => e.kind === 'subject' && inOrder(head, e.key)));
    if (sub) return sub;
  }
  return { none: true };
}

// 칸 글자 → { clear } | { set: { subject_id, membership_id, second_membership_id, special_room_id } } | { error }
export function parseCell(raw, dict) {
  const s = norm(raw);
  if (EMPTY_MARKS.has(s)) return { clear: true };
  const got = [];
  for (const part of s.split(SPLIT).map((x) => x.trim()).filter((x) => x && !EMPTY_MARKS.has(x))) {
    const whole = matchToken(part, dict);
    if (whole.ent) { got.push(whole.ent); continue; }
    const words = part.split(' ').filter(Boolean);
    if (words.length < 2) return { error: t(whole.many ? 'grid.excel_err.many' : 'grid.excel_err.unknown', { 글자: part }) };
    for (const w of words) {
      const m = matchToken(w, dict);
      if (!m.ent) return { error: t(m.many ? 'grid.excel_err.many' : 'grid.excel_err.unknown', { 글자: w }) };
      got.push(m.ent);
    }
  }
  const of = (kind) => uniq(got.filter((e) => e.kind === kind)).map((e) => e.id);
  const [sub, tea, room] = [of('subject'), of('teacher'), of('room')];
  if (sub.length > 1) return { error: t('grid.excel_err.two_subjects') };
  if (tea.length > 2) return { error: t('grid.excel_err.three_teachers') };
  if (room.length > 1) return { error: t('grid.excel_err.two_rooms') };
  if (!sub.length && !tea.length && !room.length) return { clear: true };
  return { set: { subject_id: sub[0] ?? null, membership_id: tea[0] ?? null, second_membership_id: tea[1] ?? null, special_room_id: room[0] ?? null } };
}

const valOf = (c) => Object.fromEntries(GRID_CELL_COLS.map((k) => [k, c?.[k] == null ? null : Number(c[k])]));
const sameVal = (a, b) => GRID_CELL_COLS.every((k) => a[k] === b[k]);

// 올린 파일 → 계획 { changes: [{ line, classroom_id, weekday, period, cur, set|clear }], same, errors: [{ line, cls, period, day, text, why }] }
export async function planGrid(db, orgId, ttId, buf) {
  const d = await loadGrid(db, orgId, ttId);
  if (!d) return null;
  const book = await readWorkbook(buf);
  const sheetName = t('grid.excel.sheet_class');
  const rows = book[sheetName];
  if (!rows) throw err(400, 'grid.excel_err.no_sheet', { 시트: sheetName });
  const dayNames = days(d);
  const head = (rows[0] ?? []).map(flat);
  const dayCol = dayNames.map((n, i) => { const at = head.indexOf(flat(n)); return at >= 0 ? at : i + 2; });
  const classByName = new Map();
  const sheetOf = new Map();
  for (const cl of d.classrooms) {
    const sh = classSheet(d, SHEET_DEFAULTS, cl);
    sheetOf.set(Number(cl.id), sh);
    classByName.set(flat(sh.title), cl);
    classByName.set(`${cl.grade}-${cl.class_no}`, cl);
  }
  const curOf = new Map(d.cells.map((c) => [`${c.classroom_id}:${c.weekday}:${c.period}`, c]));
  const dict = dictOf(d);
  const plan = { tt: d.tt, changes: [], same: 0, errors: [] };
  const seen = new Set();
  let lastCls = '';
  for (let li = 1; li < rows.length; li++) {
    const r = rows[li] ?? [];
    if (!r.some((c) => c)) continue;
    const line = li + 1;
    const clsText = (r[0] ?? '').trim() || lastCls;
    lastCls = clsText;
    const pText = (r[1] ?? '').trim();
    const bad = (why, extra = {}) => plan.errors.push({ line, cls: clsText, period: pText, day: '', text: '', why, ...extra });
    const cl = classByName.get(flat(clsText));
    if (!cl) { bad(t('grid.excel_err.class')); continue; }
    const period = Number((/\d+/.exec(norm(pText)) ?? [])[0]);
    if (!(period >= 1 && period <= CEIL.periods)) { bad(t('grid.excel_err.period')); continue; }
    const k = `${cl.id}:${period}`;
    if (seen.has(k)) { bad(t('grid.excel_err.dup')); continue; }
    seen.add(k);
    const drawn = sheetOf.get(Number(cl.id)).rows[period - 1];
    dayNames.forEach((dayName, wi) => {
      const raw = String(r[dayCol[wi]] ?? '').replace(/\r\n?/g, '\n').trim();
      const was = drawn ? String(drawn[wi + 1]?.text ?? '').trim() : '';
      if (raw === was) { plan.same++; return; } // 손 안 댄 칸
      const cur = curOf.get(`${cl.id}:${wi + 1}:${period}`) ?? null;
      const p = parseCell(raw, dict);
      if (p.error) { bad(p.error, { day: dayName, text: raw }); return; }
      if (p.clear ? !cur : cur && sameVal(valOf(cur), p.set)) { plan.same++; return; }
      plan.changes.push({ line, classroom_id: Number(cl.id), weekday: wi + 1, period, cur, ...(p.clear ? { clear: true } : { set: p.set }) });
    });
  }
  return plan;
}

// 계획 → DB(트랜잭션 안 client). 칸마다 되돌리기 기록 · 묶음은 delete_batch(kind excel, target_id 시간표) 하나.
export async function applyGrid(client, orgId, userId, plan) {
  const batchId = Number((await client.query(
    `INSERT INTO delete_batch (org_id, kind, target_id, label, summary, created_by) VALUES ($1, 'excel', $2, $3, $4, $5) RETURNING id`,
    [orgId, plan.tt.id, t('grid.excel.batch_label', { 이름: plan.tt.name }), JSON.stringify([{ table: 'cell', label: plan.tt.name, change: plan.changes.length }]), userId ?? null],
  )).rows[0].id);
  const item = (rowId, col, oldV, newV) => client.query(
    `INSERT INTO delete_batch_item (batch_id, table_name, row_id, column_name, old_value, new_value) VALUES ($1, 'cell', $2, $3, $4, $5)`,
    [batchId, rowId, col, oldV, newV],
  );
  const readCol = async (id, col) => (await client.query(`SELECT ${col}::text AS v FROM cell WHERE id = $1`, [id])).rows[0]?.v ?? null;
  for (const x of plan.changes) {
    if (x.clear) {
      await client.query(`UPDATE cell SET deleted_at = now() WHERE id = $1 AND org_id = $2`, [x.cur.id, orgId]);
      await item(x.cur.id, 'deleted_at', J(null), J(await readCol(x.cur.id, 'deleted_at')));
    } else if (x.cur) {
      const before = valOf(x.cur);
      for (const col of GRID_CELL_COLS) {
        if (before[col] === x.set[col]) continue;
        const was = await readCol(x.cur.id, col);
        await client.query(`UPDATE cell SET ${col} = $1 WHERE id = $2 AND org_id = $3`, [x.set[col], x.cur.id, orgId]);
        await item(x.cur.id, col, J(was), J(await readCol(x.cur.id, col)));
      }
    } else {
      const id = Number((await client.query(
        `INSERT INTO cell (org_id, timetable_id, classroom_id, weekday, period, subject_id, membership_id, second_membership_id, special_room_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [orgId, plan.tt.id, x.classroom_id, x.weekday, x.period, x.set.subject_id, x.set.membership_id, x.set.second_membership_id, x.set.special_room_id],
      )).rows[0].id);
      const now = {};
      for (const col of GRID_CELL_COLS) now[col] = await readCol(id, col);
      await item(id, null, null, J(now));
    }
  }
  return { batchId, changed: plan.changes.length, skipped: plan.errors.length };
}
