// 엑셀 바닥(T-1301b ②) — 명단 내려받기 → 그대로 올리기 0건 · 한 칸 고침 → 반영 → 되돌리기 · 그사이 바뀐 칸은 skipped · 오류 시트 · 보관함에 excel 묶음 안 보임
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { applyPlans, makeWorkbook, markErrors, planSheet, readWorkbook, rosterSpec, undoExcel } from '../server/export/import.js';
import { inTx } from '../server/cascade.js';
import { t } from '../shared/text/index.js';
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
