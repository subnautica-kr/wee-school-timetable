// 엑셀 바닥(T-1301b ②) — 명단 내려받기 → 그대로 올리기 0건 · 한 칸 고침 → 반영 → 되돌리기 · 그사이 바뀐 칸은 skipped · 오류 시트 · 보관함에 excel 묶음 안 보임
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { applyPlans, makeWorkbook, markErrors, planSheet, readWorkbook, rosterSpec, undoExcel } from '../server/export/import.js';
import { loadsSpec, pinsSpec } from '../server/export/loadsImport.js';
import { inTx } from '../server/cascade.js';
import { t, 값이름 } from '../shared/text/index.js';
import { smallSchool, seedPeople, seedStructure } from './fixtures/schools.js';
import { setupSchoolEnv, HAS_DB } from './fixtures/school-env.js';

const SHEET = t('roster.excel.sheet');
const download = async (pool, orgId) => {
  const ctx = await rosterSpec.context(pool, orgId);
  return makeWorkbook([rosterSpec], { roster: await rosterSpec.rows(pool, orgId, ctx) });
};
const editCell = async (buf, fn) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  fn(wb.getWorksheet(SHEET));
  return Buffer.from(await wb.xlsx.writeBuffer());
};
// 머리줄에서 칸 번호(1부터)
const colOf = (ws, head) => { let n = 0; ws.getRow(1).eachCell((c, i) => { if (c.value === head) n = i; }); return n; };
const plan = async (pool, orgId, buf) => planSheet(pool, orgId, rosterSpec, (await readWorkbook(buf))[SHEET]);

test('엑셀 바닥: 명단 한 바퀴', { skip: !HAS_DB && 'DATABASE_URL 없음' }, async (tt) => {
  const env = await setupSchoolEnv(tt, 'xl');
  const { pool, orgId, tag, call, P } = env;
  const school = smallSchool();
  const mids = await seedPeople(pool, orgId, tag, school);
  await seedStructure(pool, orgId, school, mids);
  // 계정 없는 줄 하나(user_id NULL)도 같이 돈다
  const bare = Number((await pool.query(`INSERT INTO membership (org_id, role, name, duty) VALUES ($1, '교직원', '계정없음', '전담') RETURNING id`, [orgId])).rows[0].id);
  const nameOf = async (id) => (await pool.query(`SELECT name FROM membership WHERE id = $1`, [id])).rows[0].name;

  await tt.test('(가) 내려받은 그대로 다시 올리면 add·change·remove 0', async () => {
    const p = await plan(pool, orgId, await download(pool, orgId));
    assert.deepEqual([p.add.length, p.change.length, p.remove.length, p.errors.length], [0, 0, 0, 0]);
    assert.ok(p.same.length >= school.teachers.length + 1, `같음 ${p.same.length}`);
    assert.ok(p.same.includes(bare));
  });

  let batchId;
  await tt.test('(나) 한 칸 고침 → 반영 → 되돌리기 → 원래 값', async () => {
    const buf = await editCell(await download(pool, orgId), (ws) => {
      const nc = colOf(ws, rosterSpec.cols[0].head);
      ws.eachRow((row, n) => { if (n > 1 && Number(row.getCell(1).value) === bare) row.getCell(nc).value = '계정없음2'; });
    });
    const p = await plan(pool, orgId, buf);
    assert.equal(p.change.length, 1);
    assert.deepEqual(p.change[0].set, { name: '계정없음2' });
    const r = await inTx(pool, (c) => applyPlans(c, orgId, null, [p]));
    assert.deepEqual([r.added, r.changed, r.removed, r.failed.length], [0, 1, 0, 0]);
    assert.equal(await nameOf(bare), '계정없음2');
    const u = await inTx(pool, (c) => undoExcel(c, orgId, r.batchId));
    assert.deepEqual([u.undone, u.skipped.length], [1, 0]);
    assert.equal(await nameOf(bare), '계정없음');
    await assert.rejects(inTx(pool, (c) => undoExcel(c, orgId, r.batchId)), (e) => e.status === 409);
    batchId = r.batchId;
  });

  await tt.test('(다) 그 사이 바뀐 칸은 덮지 않고 skipped', async () => {
    const buf = await editCell(await download(pool, orgId), (ws) => {
      const nc = colOf(ws, rosterSpec.cols[0].head);
      ws.eachRow((row, n) => { if (n > 1 && Number(row.getCell(1).value) === bare) row.getCell(nc).value = '엑셀이름'; });
      ws.addRow(['', '새줄', '담임', '']);
    });
    const p = await plan(pool, orgId, buf);
    assert.deepEqual([p.add.length, p.change.length], [1, 1]);
    const r = await inTx(pool, (c) => applyPlans(c, orgId, null, [p]));
    assert.deepEqual([r.added, r.changed], [1, 1]);
    await pool.query(`UPDATE membership SET name = '손이름' WHERE id = $1`, [bare]);
    const u = await inTx(pool, (c) => undoExcel(c, orgId, r.batchId));
    assert.equal(u.undone, 1, '새 줄 되돌리기');
    assert.deepEqual(u.skipped.map((s) => [s.rowId, s.column]), [[bare, 'name']]);
    assert.equal(await nameOf(bare), '손이름');
    const added = (await pool.query(`SELECT deleted_at FROM membership WHERE org_id = $1 AND name = '새줄'`, [orgId])).rows;
    assert.equal(added.length, 1);
    assert.ok(added[0].deleted_at, '넣은 줄은 표시 삭제로 되돌림');
  });

  await tt.test('(라) 오류 칸 → markErrors 에 「오류」 시트 · 칸 빨강·메모', async () => {
    const buf = await editCell(await download(pool, orgId), (ws) => {
      const bc = colOf(ws, rosterSpec.cols[2].head);
      ws.eachRow((row, n) => { if (n === 2) row.getCell(bc).value = '2001-13-40'; });
      ws.addRow([999999999, '없는줄', '', '']);
    });
    const p = await plan(pool, orgId, buf);
    assert.equal(p.errors.length, 2);
    assert.ok(p.errors.some((e) => e.col === 1 && e.key === 'key'));
    const out = new ExcelJS.Workbook();
    await out.xlsx.load(await markErrors(buf, [p]));
    const names = out.worksheets.slice().sort((a, b) => a.orderNo - b.orderNo).map((w) => w.name);
    assert.equal(names[0], t('school.excel.error_sheet'), names.join(','));
    const es = out.getWorksheet(t('school.excel.error_sheet'));
    assert.equal(es.rowCount, 2 + p.errors.length);
    const be = p.errors.find((e) => e.key === 'birth');
    const cell = out.getWorksheet(SHEET).getCell(be.line, be.col);
    assert.equal(cell.fill?.fgColor?.argb, 'FFFFC7CE');
    assert.ok(cell.note);
  });

  await tt.test('(마) 보관함 목록에 excel 묶음이 안 보인다', async () => {
    const list = await call('GET', `${P}/trash`);
    assert.equal(list.status, 200);
    assert.ok(!list.json.some((b) => b.kind === 'excel' || Number(b.id) === batchId));
    const n = (await pool.query(`SELECT count(*)::int AS n FROM delete_batch WHERE org_id = $1 AND kind = 'excel'`, [orgId])).rows[0].n;
    assert.equal(n, 2, '묶음은 DB 엔 있다');
  });
});

// ───────── ③ 시수표·고정금지 시트 + 길 넷 ─────────
const SPECS = [rosterSpec, loadsSpec, pinsSpec];
const downloadAll = async (pool, orgId) => {
  const data = {};
  for (const s of SPECS) data[s.name] = await s.rows(pool, orgId, await s.context(pool, orgId));
  return makeWorkbook(SPECS, data);
};
const editSheet = async (buf, sheet, fn) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  fn(wb.getWorksheet(sheet));
  return Buffer.from(await wb.xlsx.writeBuffer());
};
const plansFor = async (pool, orgId, buf) => {
  const book = await readWorkbook(buf);
  return Promise.all(SPECS.map((s) => planSheet(pool, orgId, s, book[s.sheet])));
};
const count = async (pool, sql, args) => Number((await pool.query(sql, args)).rows[0].n);

test('엑셀 바닥: 시수표·고정금지 한 바퀴 + 길 넷', { skip: !HAS_DB && 'DATABASE_URL 없음' }, async (tt) => {
  const env = await setupSchoolEnv(tt, 'xl3');
  const { pool, orgId, tag, call, P } = env;
  const school = smallSchool();
  const mids = await seedPeople(pool, orgId, tag, school);
  const seeded = await seedStructure(pool, orgId, school, mids);
  const LS = t('school.excel_loads.sheet');
  const PS = t('school.excel_pins.sheet');
  const ROOM = 값이름('pin.target_kind', '반'); // 문구-예외: 저장 값
  const BAN = 값이름('pin.kind', '금지'); // 문구-예외: 저장 값
  const who = (await pool.query(`SELECT name FROM membership WHERE id = $1`, [mids.s1])).rows[0].name;
  await pool.query(`INSERT INTO pin (org_id, term_id, target_kind, target_id, weekday, period, kind) VALUES ($1,$2,'교사',$3,3,4,'금지')`, [orgId, seeded.term, mids.s1]); // 문구-예외: 저장 값
  const nLoads = () => count(pool, `SELECT count(*)::int AS n FROM teaching_load WHERE org_id = $1 AND deleted_at IS NULL`, [orgId]);
  const nPins = () => count(pool, `SELECT count(*)::int AS n FROM pin WHERE org_id = $1 AND deleted_at IS NULL`, [orgId]);
  const L0 = await nLoads();
  assert.ok(L0 >= 6);
  const hoursOf = async (id) => Number((await pool.query(`SELECT weekly_hours AS h FROM teaching_load WHERE id = $1`, [id])).rows[0].h);
  const hoursCol = loadsSpec.cols.findIndex((c) => c.key === 'hours') + 2;

  await tt.test('(가) 내려받은 그대로 올리면 세 시트 모두 add·change·remove·오류 0', async () => {
    const plans = await plansFor(pool, orgId, await downloadAll(pool, orgId));
    for (const p of plans) assert.deepEqual([p.add.length, p.change.length, p.remove.length, p.errors.length], [0, 0, 0, 0], p.sheet);
    assert.equal(plans[1].same.length, L0);
    assert.equal(plans[2].same.length, 1);
  });

  await tt.test('(나) 시수 고침·새 줄·고정금지 새 줄·줄 지움 → 반영 → 되돌리기 → 처음 그대로', async () => {
    let buf = await downloadAll(pool, orgId);
    const firstLoad = Number((await readWorkbook(buf))[LS][1][0]);
    const before = await hoursOf(firstLoad);
    buf = await editSheet(buf, LS, (ws) => {
      ws.getRow(2).getCell(hoursCol).value = before + 1;
      ws.addRow(['', who, '국어', '1-1', 1]);
    });
    buf = await editSheet(buf, PS, (ws) => {
      ws.addRow(['', ROOM, '1-1', '월', 2, BAN]);
      ws.getRow(2).getCell(pinsSpec.cols.length + 2).value = t('school.excel.yes_mark');
    });
    const plans = await plansFor(pool, orgId, buf);
    assert.deepEqual(plans.map((p) => p.errors.length), [0, 0, 0], JSON.stringify(plans.map((p) => p.errors)));
    assert.deepEqual([plans[1].add.length, plans[1].change.length, plans[2].add.length, plans[2].remove.length], [1, 1, 1, 1]);
    // 지움은 옵션 없이는 안 지운다
    const r0 = await inTx(pool, (c) => applyPlans(c, orgId, null, plans));
    assert.equal(r0.removed, 0);
    await inTx(pool, (c) => undoExcel(c, orgId, r0.batchId));
    assert.equal(await nLoads(), L0);
    assert.equal(await nPins(), 1);
    const r = await inTx(pool, (c) => applyPlans(c, orgId, null, plans, { remove: true }));
    assert.deepEqual([r.added, r.changed, r.removed, r.failed.length], [2, 1, 1, 0]);
    assert.equal(await hoursOf(firstLoad), before + 1);
    assert.equal(await nLoads(), L0 + 1);
    assert.equal(await nPins(), 1); // 하나 지우고 하나 넣음
    const u = await inTx(pool, (c) => undoExcel(c, orgId, r.batchId));
    assert.equal(u.skipped.length, 0);
    assert.equal(await hoursOf(firstLoad), before);
    assert.equal(await nLoads(), L0);
    assert.equal(await nPins(), 1);
    const back = await plansFor(pool, orgId, await downloadAll(pool, orgId));
    assert.deepEqual(back.map((p) => p.change.length + p.add.length + p.remove.length), [0, 0, 0]);
  });

  await tt.test('(다) 고쳐 올린 줄의 오류: 없는 교과·반·요일·큰 시수', async () => {
    let buf = await downloadAll(pool, orgId);
    buf = await editSheet(buf, LS, (ws) => { ws.addRow(['', who, '없는교과', '9-9', 99999]); });
    buf = await editSheet(buf, PS, (ws) => { ws.addRow(['', ROOM, '1-1', '금', 3, '아님']); ws.addRow(['', ROOM, '1-1', '화', 3, BAN]); });
    const plans = await plansFor(pool, orgId, buf);
    assert.ok(plans[1].errors.length >= 3, `시수표 오류 ${plans[1].errors.length}`);
    assert.equal(plans[2].errors.length, 1);
    assert.equal(plans[2].errors[0].key, 'kind');
    assert.equal(plans[2].add.length, 1, '요일·교시가 맞는 줄은 들어간다');
    assert.equal(plans[1].add.length, 0);
  });

  await tt.test('(라) 길 넷 HTTP — 내려받기·미리 보기(오류 표시 파일)·반영·되돌리기', async () => {
    const dl = await call('GET', `${P}/roster/excel`);
    assert.equal(dl.status, 200);
    let buf = await downloadAll(pool, orgId);
    buf = await editSheet(buf, LS, (ws) => { ws.addRow(['', who, '국어', '1-1', 1]); });
    const pv = await call('POST', `${P}/roster/excel/preview`, buf);
    assert.equal(pv.status, 200);
    assert.equal(pv.json.sheets.find((s) => s.name === 'loads').add.length, 1);
    assert.equal(pv.json.marked, undefined);
    assert.equal(await nLoads(), L0, '미리 보기는 쓰지 않는다');
    const bad = await editSheet(buf, PS, (ws) => { ws.addRow(['', ROOM, '1-1', '화', 3, '아님']); });
    const pb = await call('POST', `${P}/roster/excel/preview`, bad);
    assert.ok(pb.json.sheets.find((s) => s.name === 'pins').errors.length >= 1);
    const marked = new ExcelJS.Workbook();
    await marked.xlsx.load(Buffer.from(pb.json.marked, 'base64'));
    assert.ok(marked.getWorksheet(t('school.excel.error_sheet')));
    const ap = await call('POST', `${P}/roster/excel/apply`, buf);
    assert.equal(ap.status, 200);
    assert.equal(ap.json.added, 1);
    assert.equal(await nLoads(), L0 + 1);
    const un = await call('POST', `${P}/roster/excel/undo`, { batchId: ap.json.batchId });
    assert.equal(un.status, 200);
    assert.equal(await nLoads(), L0);
    const again = await call('POST', `${P}/roster/excel/undo`, { batchId: ap.json.batchId }, { expect: 409 });
    assert.equal(again.status, 409);
    assert.equal(again.json.error, t('school.excel_err.batch_done'));
    assert.equal((await call('POST', `${P}/roster/excel/undo`, { batchId: 999999999 }, { expect: 404 })).status, 404);
    assert.equal((await call('POST', `${P}/roster/excel/apply`, Buffer.from('not xlsx'), { expect: 400 })).status, 400);
  });

  await tt.test('(마) 관리 권한이 없는 사용자는 길 넷 모두 막힌다(이 앱의 가드는 404)', async () => {
    const login = await call('POST', '/api/auth/login', { orgId, loginId: `${tag}-s1`, password: 'pw-test-1234' });
    assert.equal(login.status, 200);
    const x = { expect: 404 };
    assert.equal((await call('GET', `${P}/roster/excel`, undefined, x)).status, 404);
    assert.equal((await call('POST', `${P}/roster/excel/preview`, Buffer.from('x'), x)).status, 404);
    assert.equal((await call('POST', `${P}/roster/excel/apply`, Buffer.from('x'), x)).status, 404);
    assert.equal((await call('POST', `${P}/roster/excel/undo`, { batchId: 1 }, x)).status, 404);
  });
});
