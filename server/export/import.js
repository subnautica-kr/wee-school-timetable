import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { t } from '../../shared/text/index.js';
import { dutyFromText, loadConfig } from '../orgConfig.js';
import { loadsSpec, pinsSpec } from './loadsImport.js';

// 담임 과목 취합본 읽기 — 엑셀(.xlsx) · 한글(.hwpx). 못 읽은 줄은 버리지 않고 ok:false 로 돌려 화면이 빨강으로 보인다.
export const TEMPLATE_HEADER = ['학년', '반', '교과', '주당 시수'];

const text = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.text ?? v.result ?? (v.richText ? v.richText.map((x) => x.text).join('') : '')).trim();
  return String(v).trim();
};

export async function readXlsx(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  const rows = [];
  ws?.eachRow({ includeEmpty: false }, (row) => rows.push(row.values.slice(1).map(text)));
  return rows;
}

const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// hwpx: zip 안 Contents/section*.xml 의 표(<hp:tr>/<hp:tc>)에서 글자만 뽑는다
export async function readHwpx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).filter((n) => /^Contents\/section\d+\.xml$/.test(n)).sort();
  if (!names.length) throw Object.assign(new Error('hwpx 가 아닙니다'), { status: 400 });
  const rows = [];
  for (const n of names) {
    const xml = await zip.files[n].async('string');
    for (const tr of xml.match(/<hp:tr[\s>][\s\S]*?<\/hp:tr>/g) ?? []) {
      rows.push((tr.match(/<hp:tc[\s>][\s\S]*?<\/hp:tc>/g) ?? []).map((tc) => unesc((tc.match(/<hp:t>([\s\S]*?)<\/hp:t>/g) ?? []).map((t) => t.replace(/<\/?hp:t>/g, '')).join(' ').trim())));
    }
  }
  return rows;
}

export async function readTable(buf) {
  // zip 시그니처(PK)만 확인한다 — xlsx 와 hwpx 둘 다 zip 이라 안의 파일로 가른다
  if (!(buf?.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b)) throw Object.assign(new Error('엑셀(.xlsx)이나 한글(.hwpx) 파일이 아닙니다'), { status: 400 });
  const zip = await JSZip.loadAsync(buf);
  if (zip.file('mimetype') || Object.keys(zip.files).some((n) => n.startsWith('Contents/section'))) return readHwpx(buf);
  return readXlsx(buf);
}

// 표 → 줄. 머리 줄에서 열을 찾고(이름이 달라도 학년·반·교과·시수가 든 낱말), 없으면 앞 네 열 순서로 본다.
export function parseRows(table, { classrooms, subjects }) {
  const hi = table.findIndex((r) => r.some((c) => /학년/.test(c)) && r.some((c) => /교과|과목/.test(c)));
  const head = hi >= 0 ? table[hi] : null;
  const col = (re, dflt) => { const i = head ? head.findIndex((c) => re.test(c)) : -1; return i >= 0 ? i : dflt; };
  const ci = { grade: col(/학년/, 0), cls: col(/^반|반$/, 1), sub: col(/교과|과목/, 2), hours: col(/시수|시간/, 3) };
  const bySub = new Map(subjects.map((s) => [s.name, s]).concat(subjects.filter((s) => s.short_name).map((s) => [s.short_name, s])));
  const out = [];
  table.forEach((r, i) => {
    if (i === hi || !r.some((c) => c)) return;
    if (hi < 0 && i === 0 && !/\d/.test(r[ci.grade] ?? '')) return; // 머리 없는 파일의 제목 줄
    const num = (v) => { const m = /\d+/.exec(v ?? ''); return m ? Number(m[0]) : null; };
    const grade = num(r[ci.grade]); const cls = num(r[ci.cls]); const hours = num(r[ci.hours]);
    const subName = (r[ci.sub] ?? '').trim();
    const cl = classrooms.find((c) => c.grade === grade && c.class_no === cls);
    const sb = bySub.get(subName);
    const why = [];
    if (!cl) why.push('반을 찾지 못함');
    if (!sb) why.push('교과를 찾지 못함');
    if (!(hours > 0)) why.push('시수를 읽지 못함');
    out.push({ line: i + 1, grade, class_no: cls, subject: subName, hours, classroom_id: cl?.id ?? null, subject_id: sb?.id ?? null, ok: !why.length, reason: why.join(' · ') });
  });
  return out;
}

export async function makeTemplate() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('담임 과목');
  ws.addRow(TEMPLATE_HEADER).font = { bold: true };
  ws.addRow([3, 1, '체육', 3]);
  ws.columns.forEach((c) => { c.width = 12; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ───────── 엑셀 바닥(T-1301b) — 표 하나 = 스펙 하나. 내려받기 → 고쳐 올리기 → 미리 보기 → 반영 → 되돌리기 ─────────
// 스펙: { name, sheet, table, removable, cols:[{ key, head, dbcols, dep?, required?, list?, max?, read(text, ctx, cells) → {set}|{error} }],
//         context(db, orgId) → ctx, rows(db, orgId, ctx) → [{ id, text:{key:글자}, set:{dbcol:값} }], insert(db, orgId, set, ctx) → id }
// 비교는 칸 글자로 한다 — 손 안 댄 칸은 다시 읽지 않는다(지금 저장 값 그대로). 줄은 맨 앞 관리 번호(줄 id)로 맞댄다.
// SQL 에 끼우는 표·칸 이름은 스펙의 고정 값(table·dbcols)뿐이고, 되돌리기가 DB 에서 읽은 이름은 EXCEL_SPECS 허용 집합에 든 것만 쓴다.
const cellText = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : text(v));
const err = (status, key, vars) => Object.assign(new Error(t(key, vars)), { status, expose: true, code: key });
const RED = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
const J = (v) => JSON.stringify(v ?? null);

// 명단 스펙 — 이름·담당·생년월일. 반·아이디 열은 T-1302a① 몫이라 안 넣는다. 줄은 계정이 없을 수 있다(이름은 membership.name).
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const readBirth = (s) => {
  if (!s) return { set: { birth_date: null } };
  const m = DATE_RE.exec(s);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d && d.getUTCDate() === +m[3] && d.getUTCMonth() === +m[2] - 1 ? { set: { birth_date: s } } : { error: t('roster.excel_err.birth') };
};
export const rosterSpec = {
  name: 'roster',
  get sheet() { return t('roster.excel.sheet'); },
  table: 'membership',
  removable: false, // 명단 줄 지우기는 관리자 잠김 위험이 있어 엑셀로는 안 연다(명단 탭 지우기 길이 맡는다)
  cols: [
    { key: 'name', get head() { return t('roster.excel.name'); }, dbcols: ['name'], required: true, max: 40, read: (s) => ({ set: { name: s } }) },
    { key: 'duty', get head() { return t('roster.excel.duty'); }, dbcols: ['duty'], list: (ctx) => ctx.cfg.duties,
      read: (s, ctx) => { const d = dutyFromText(ctx.cfg, s); return d === undefined ? { error: t('roster.excel_err.duty') } : { set: { duty: d } }; } },
    { key: 'birth', get head() { return t('roster.excel.birth'); }, dbcols: ['birth_date'], read: readBirth },
  ],
  context: async (db, orgId) => ({ cfg: await loadConfig(db, orgId) }),
  rows: async (db, orgId) => (await db.query(
    `SELECT id, name, duty, to_char(birth_date, 'YYYY-MM-DD') AS birth FROM membership WHERE org_id = $1 AND deleted_at IS NULL AND role <> '시스템관리자' ORDER BY name, id`, // 문구-예외: 저장 값
    [orgId],
  )).rows.map((r) => ({ id: Number(r.id), text: { name: r.name ?? '', duty: r.duty ?? '', birth: r.birth ?? '' }, set: { name: r.name, duty: r.duty, birth_date: r.birth } })),
  insert: async (db, orgId, set) => Number((await db.query(
    `INSERT INTO membership (org_id, role, name, duty, birth_date) VALUES ($1, '교직원', $2, $3, $4) RETURNING id`, // 문구-예외: 저장 값
    [orgId, set.name, set.duty ?? null, set.birth_date ?? null],
  )).rows[0].id),
};

// 되돌리기 허용 집합의 출처 — 명단·시수표·고정금지(앞 둘은 loadsImport.js)
export const EXCEL_SPECS = [rosterSpec, loadsSpec, pinsSpec];
const allowedCols = () => new Map(EXCEL_SPECS.map((s) => [s.table, new Set([...s.cols.flatMap((c) => c.dbcols), 'deleted_at'])]));

// specs·data → 엑셀. data[spec.name] = spec.rows() 결과. 맨 앞 열은 관리 번호, 지울 수 있는 시트는 맨 끝에 「지움」.
export async function makeWorkbook(specs, data) {
  const wb = new ExcelJS.Workbook();
  const help = wb.addWorksheet(t('school.excel.help_sheet'));
  [t('school.excel.help_title'), t('school.excel.help_key'), t('school.excel.help_new'), t('school.excel.help_remove'), t('school.excel.help_colors'), t('school.excel.help_flow')]
    .forEach((s, i) => { help.addRow([s]).font = { bold: i === 0 }; });
  help.getColumn(1).width = 100;
  for (const spec of specs) {
    const ws = wb.addWorksheet(spec.sheet);
    const head = [t('school.excel.key_head'), ...spec.cols.map((c) => c.head), ...(spec.removable ? [t('school.excel.remove_head')] : [])];
    ws.addRow(head).eachCell((c) => { c.font = { bold: true }; c.fill = HEAD_FILL; });
    for (const r of data[spec.name] ?? []) ws.addRow([r.id, ...spec.cols.map((c) => r.text[c.key] ?? ''), ...(spec.removable ? [''] : [])]);
    ws.getColumn(1).width = 10;
    for (let i = 2; i <= head.length; i++) ws.getColumn(i).width = 18;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// 엑셀 → { 시트 이름: 줄[][] } (칸은 글자로)
export async function readWorkbook(buf) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); } catch { throw err(400, 'school.excel_err.not_xlsx'); }
  const out = {};
  for (const ws of wb.worksheets) {
    const rows = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => { rows[n - 1] = row.values.slice(1).map(cellText); });
    for (let i = 0; i < rows.length; i++) rows[i] ??= [];
    out[ws.name] = rows;
  }
  return out;
}

// 시트 줄[][] → 반영 계획. errors 의 line·col 은 엑셀 줄·열 번호(1부터). plan.spec 은 숨은 칸(JSON 에 안 실림).
export async function planSheet(db, orgId, spec, rows) {
  const ctx = await spec.context(db, orgId);
  const cur = new Map((await spec.rows(db, orgId, ctx)).map((r) => [r.id, r]));
  const plan = { sheet: spec.sheet, add: [], change: [], same: [], remove: [], errors: [] };
  Object.defineProperty(plan, 'spec', { value: spec });
  const head = rows[0] ?? [];
  const at = (h, dflt) => { const i = head.indexOf(h); return i >= 0 ? i : dflt; };
  const ci = spec.cols.map((c, i) => at(c.head, i + 1));
  const rmi = spec.removable ? at(t('school.excel.remove_head'), spec.cols.length + 1) : -1;
  const seen = new Set();
  for (let li = 1; li < rows.length; li++) {
    const r = rows[li] ?? [];
    if (!r.some((c) => c)) continue;
    const line = li + 1;
    const bad = (col, key, msg) => plan.errors.push({ line, col, key, msg });
    const keyText = (r[0] ?? '').trim();
    let old = null;
    if (keyText) {
      const id = Number(keyText);
      old = cur.get(id);
      if (!old) { bad(1, 'key', t('school.excel_err.key_unknown', { 번호: keyText })); continue; }
      if (seen.has(id)) { bad(1, 'key', t('school.excel_err.key_dup', { 번호: keyText })); continue; }
      seen.add(id);
      if (rmi >= 0 && (r[rmi] ?? '').trim() === t('school.excel.yes_mark')) { plan.remove.push({ line, id }); continue; }
    }
    const cells = Object.fromEntries(spec.cols.map((c, i) => [c.key, (r[ci[i]] ?? '').trim()]));
    const set = {};
    const before = plan.errors.length;
    spec.cols.forEach((c, i) => {
      const s = cells[c.key];
      if (old && s === (old.text[c.key] ?? '')) return; // 손 안 댄 칸 — 다시 읽지 않는다
      if (c.required && !s) return bad(ci[i] + 1, c.key, t('school.excel_err.required', { 칸: c.head }));
      const got = c.read(s, ctx, cells);
      if (got.error) return bad(ci[i] + 1, c.key, got.error);
      Object.assign(set, got.set);
    });
    if (plan.errors.length > before) continue;
    if (!old) plan.add.push({ line, set });
    else if (Object.keys(set).length) plan.change.push({ line, id: old.id, set });
    else plan.same.push(old.id);
  }
  return plan;
}

// 계획 → DB. 트랜잭션 안의 client 를 받는다(부르는 쪽이 inTx). 줄마다 SAVEPOINT — 유일 색인 위반(23505)은 그 줄만 failed.
// remove: true(모든 시트) 또는 지울 시트 이름 배열. 되돌리기 기록은 delete_batch(kind='excel') + delete_batch_item(값은 ::text 를 JSON 글자로).
export async function applyPlans(client, orgId, userId, plans, { remove = false } = {}) {
  const sheets = plans.map((p) => p.sheet).join(', ');
  const label = t('school.excel.batch_label', { 시트: sheets });
  const summary = plans.map((p) => ({ table: p.spec.table, label: p.sheet, add: p.add.length, change: p.change.length, remove: p.remove.length }));
  const batchId = Number((await client.query(
    `INSERT INTO delete_batch (org_id, kind, target_id, label, summary, created_by) VALUES ($1, 'excel', 0, $2, $3, $4) RETURNING id`,
    [orgId, label, JSON.stringify(summary), userId ?? null],
  )).rows[0].id);
  const item = (table, rowId, col, oldV, newV) => client.query(
    `INSERT INTO delete_batch_item (batch_id, table_name, row_id, column_name, old_value, new_value) VALUES ($1, $2, $3, $4, $5, $6)`,
    [batchId, table, rowId, col, oldV, newV],
  );
  const out = { batchId, added: 0, changed: 0, removed: 0, failed: [] };
  for (const p of plans) {
    const { table } = p.spec;
    const dbcols = [...new Set(p.spec.cols.flatMap((c) => c.dbcols))];
    const ctx = await p.spec.context(client, orgId);
    const doRemove = p.spec.removable && (remove === true || (Array.isArray(remove) && remove.includes(p.sheet)));
    const readCol = async (id, col) => (await client.query(`SELECT ${col}::text AS v FROM ${table} WHERE id = $1`, [id])).rows[0]?.v ?? null;
    const steps = [...p.add.map((x) => ['add', x]), ...p.change.map((x) => ['change', x]), ...(doRemove ? p.remove.map((x) => ['remove', x]) : [])];
    for (const [kind, x] of steps) {
      await client.query('SAVEPOINT excel_row');
      try {
        if (kind === 'add') {
          const id = await p.spec.insert(client, orgId, x.set, ctx);
          const now = {};
          for (const col of dbcols) now[col] = await readCol(id, col);
          await item(table, id, null, null, J(now));
          out.added++;
        } else if (kind === 'remove') {
          const was = await readCol(x.id, 'deleted_at');
          await client.query(`UPDATE ${table} SET deleted_at = now() WHERE id = $1 AND org_id = $2`, [x.id, orgId]);
          await item(table, x.id, 'deleted_at', J(was), J(await readCol(x.id, 'deleted_at')));
          out.removed++;
        } else {
          const keys = dbcols.filter((k) => k in x.set);
          const was = {};
          for (const col of keys) was[col] = await readCol(x.id, col);
          const sets = keys.map((col, i) => `${col} = $${i + 3}`);
          await client.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2`, [x.id, orgId, ...keys.map((k) => x.set[k])]);
          for (const col of keys) await item(table, x.id, col, J(was[col]), J(await readCol(x.id, col)));
          out.changed++;
        }
        await client.query('RELEASE SAVEPOINT excel_row');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT excel_row');
        if (e.code !== '23505') throw e;
        out.failed.push({ sheet: p.sheet, line: x.line, msg: t('school.excel_err.duplicate') });
      }
    }
  }
  return out;
}

// 반영 되돌리기 — 그 사이 값이 바뀐 칸(지금 값 ≠ 반영 때 넣은 값)은 덮지 않고 skipped 로 돌려준다.
export async function undoExcel(client, orgId, batchId) {
  const b = (await client.query(`SELECT id, restored_at FROM delete_batch WHERE id = $1 AND org_id = $2 AND kind = 'excel' FOR UPDATE`, [batchId, orgId])).rows[0];
  if (!b) throw err(404, 'school.excel_err.batch_missing');
  if (b.restored_at) throw err(409, 'school.excel_err.batch_done');
  const allow = allowedCols();
  const items = (await client.query(`SELECT table_name, row_id, column_name, old_value, new_value FROM delete_batch_item WHERE batch_id = $1 ORDER BY id DESC`, [batchId])).rows;
  const out = { batchId: Number(batchId), undone: 0, skipped: [] };
  for (const it of items) {
    const table = [...allow.keys()].find((k) => k === it.table_name);
    if (!table) continue;
    const okCols = [...allow.get(table)];
    const readCol = async (col) => (await client.query(`SELECT ${col}::text AS v FROM ${table} WHERE id = $1 AND org_id = $2`, [it.row_id, orgId])).rows[0]?.v ?? null;
    const skip = (column) => out.skipped.push({ table, rowId: Number(it.row_id), column });
    if (it.column_name == null) {
      // 넣은 줄 — 넣은 뒤 그대로면 표시 삭제, 그사이 누가 고쳤으면 둔다
      let same = (await readCol('deleted_at')) == null;
      for (const [k, v] of Object.entries(JSON.parse(it.new_value ?? '{}'))) {
        const col = okCols.find((c) => c === k);
        if (same && col) same = (await readCol(col)) === v;
      }
      if (!same) { skip(null); continue; }
      await client.query(`UPDATE ${table} SET deleted_at = now() WHERE id = $1 AND org_id = $2`, [it.row_id, orgId]);
      out.undone++;
      continue;
    }
    const col = okCols.find((c) => c === it.column_name);
    if (!col) continue;
    if ((await readCol(col)) !== JSON.parse(it.new_value)) { skip(col); continue; }
    await client.query(`UPDATE ${table} SET ${col} = $1 WHERE id = $2 AND org_id = $3`, [JSON.parse(it.old_value), it.row_id, orgId]);
    out.undone++;
  }
  await client.query(`UPDATE delete_batch SET restored_at = now() WHERE id = $1`, [batchId]);
  return out;
}

// 오류 칸을 빨강으로 칠하고 메모를 단 파일 + 맨 앞 「오류」 시트
export async function markErrors(buf, plans) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const all = plans.flatMap((p) => p.errors.map((e) => ({ ...e, sheet: p.sheet, spec: p.spec })));
  for (const e of all) {
    const ws = wb.getWorksheet(e.sheet);
    if (!ws) continue;
    const c = ws.getCell(e.line, e.col);
    c.fill = RED;
    c.note = t('school.excel.error_note', { 사유: e.msg });
  }
  const name = t('school.excel.error_sheet');
  const old = wb.getWorksheet(name);
  if (old) wb.removeWorksheet(old.id);
  const es = wb.addWorksheet(name);
  es.orderNo = -1;
  es.addRow([t('school.excel.error_intro')]).font = { bold: true };
  es.addRow([t('school.excel.error_col_sheet'), t('school.excel.error_col_line'), t('school.excel.error_col_head'), t('school.excel.error_col_why')]).eachCell((c) => { c.font = { bold: true }; c.fill = HEAD_FILL; });
  for (const e of all) es.addRow([e.sheet, e.line, e.col === 1 ? t('school.excel.key_head') : e.spec?.cols.find((c) => c.key === e.key)?.head ?? '', e.msg]);
  es.getColumn(4).width = 80;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
