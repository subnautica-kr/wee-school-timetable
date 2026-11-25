// 시간표 격자 엑셀 왕복(T-1304b) — 그대로 올리면 바뀜 0 · 느슨한 다섯 꼴 · 못 읽은 칸 건너뜀 · 확정본 409 → confirm=1 · 되돌리기 · 남의 것 404
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { loadGrid, makeGridWorkbook, parseCell } from '../server/export/gridExcel.js';
import { cleanupOrgs } from './sec-helpers.js';
import { t } from '../shared/text/index.js';
import { smallSchool, seedPeople, seedStructure } from './fixtures/schools.js';
import { setupSchoolEnv, HAS_DB } from './fixtures/school-env.js';

const SHEET = t('grid.excel.sheet_class');

test('시간표 격자 엑셀 왕복', { skip: !HAS_DB && 'DATABASE_URL 없음' }, async (tt) => {
  const env = await setupSchoolEnv(tt, 'gx');
  const { pool, orgId, tag, call, P } = env;
  const school = smallSchool();
  const mids = await seedPeople(pool, orgId, tag, school);
  await pool.query(`UPDATE membership m SET name = u.name FROM app_user u WHERE m.user_id = u.id AND m.org_id = $1 AND m.name IS NULL`, [orgId]);
  const s = await seedStructure(pool, orgId, school, mids);
  const q1 = async (sql, a) => (await pool.query(sql, a)).rows[0];
  const changche = Number((await q1(`INSERT INTO subject (org_id, name) VALUES ($1, '창의적체험활동') RETURNING id`, [orgId])).id);
  const lab = Number((await q1(`INSERT INTO special_room (org_id, name) VALUES ($1, 'Lab A') RETURNING id`, [orgId])).id);
  const tid = Number((await q1(`INSERT INTO timetable (org_id, term_id, name) VALUES ($1, $2, 'gx시간표') RETURNING id`, [orgId, s.term])).id);
  const c11 = s.classrooms['1-1'];
  const c21 = s.classrooms['2-1'];
  const put = (cl, wd, p, sub, mid, room = null) => pool.query(
    `INSERT INTO cell (org_id, timetable_id, classroom_id, weekday, period, subject_id, membership_id, special_room_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [orgId, tid, cl, wd, p, sub, mid, room]);
  await put(c11, 1, 1, s.subjects['국어'], mids.h1);
  await put(c11, 1, 2, s.subjects['수학'], mids.h1);
  await put(c11, 2, 1, s.subjects['영어'], mids.s1, lab);
  const snap = async () => (await pool.query(`SELECT classroom_id, weekday, period, subject_id, membership_id, second_membership_id, special_room_id FROM cell WHERE timetable_id = $1 AND deleted_at IS NULL ORDER BY 1,2,3`, [tid])).rows;
  const cellAt = async (cl, wd, p) => (await pool.query(`SELECT subject_id, membership_id, second_membership_id, special_room_id FROM cell WHERE timetable_id = $1 AND classroom_id = $2 AND weekday = $3 AND period = $4 AND deleted_at IS NULL`, [tid, cl, wd, p])).rows[0] ?? null;
  const num = (r) => r && Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? null : Number(v)]));
  const download = async () => makeGridWorkbook(await loadGrid(pool, orgId, tid));
  // 반별 시트에서 (반 이름, 교시 번호, 요일 번호) 칸을 고친다
  const edit = async (buf, edits) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.getWorksheet(SHEET);
    for (const [cls, p, wd, v] of edits) {
      let hit = false;
      ws.eachRow((row, n) => { if (n > 1 && row.getCell(1).value === cls && String(row.getCell(2).value).startsWith(String(p))) { row.getCell(2 + wd).value = v; hit = true; } });
      assert.ok(hit, `줄 없음 ${cls} ${p}`);
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  const url = (x = '') => `${P}/timetables/${tid}/grid-excel${x}`;
  const cls1 = '1학년 1반';
  const cls2 = '2학년 1반';

  await tt.test('(가) 내려받기 200 · 그대로 올리면 바뀜 0 · 못 읽음 0', async () => {
    assert.equal((await call('GET', url())).status, 200);
    const r = await call('POST', url('/preview'), await download());
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.change, r.json.errors.length], [0, 0]);
    assert.ok(r.json.same > 0);
  });

  let buf;
  await tt.test('(나) 느슨한 다섯 꼴 + 못 읽은 칸 → 미리 보기', async () => {
    buf = await edit(await download(), [
      [cls2, 1, 3, '  수학 \n  소담임2  '], // 앞뒤 공백
      [cls2, 2, 3, '수(소담임2…)'], // 앞부분 · 끝 … 뗌
      [cls2, 3, 3, '창체'], // 교과 글자 순서
      [cls1, 1, 1, ''], // 빈칸 = 비움
      [cls1, 2, 1, '—'], // — = 비움
      [cls2, 1, 5, '국어（소담임１・소전담１）\nlab a'], // 전각 · 대소문자 · 둘째 교사
      [cls2, 2, 4, '국어(소담…)'], // 여럿 맞음 → 못 읽음
      [cls2, 3, 4, '외계어'], // 모름 → 못 읽음
    ]);
    const r = await call('POST', url('/preview'), buf);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.change, 6, JSON.stringify(r.json));
    assert.equal(r.json.errors.length, 2, JSON.stringify(r.json.errors));
    assert.ok(r.json.errors.every((e) => e.line > 1 && e.why && e.text));
    assert.equal(r.json.confirmed, false);
  });

  let batchId; let before;
  await tt.test('(다) 반영 → 칸 값 · 못 읽은 칸 건너뜀 · 감사', async () => {
    before = await snap();
    const r = await call('POST', url('/apply'), buf);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.changed, r.json.skipped], [6, 2]);
    batchId = r.json.batchId;
    const sub = s.subjects;
    assert.deepEqual(num(await cellAt(c21, 3, 1)), { subject_id: sub['수학'], membership_id: mids.h2, second_membership_id: null, special_room_id: null });
    assert.deepEqual(num(await cellAt(c21, 3, 2)), { subject_id: sub['수학'], membership_id: mids.h2, second_membership_id: null, special_room_id: null });
    assert.deepEqual(num(await cellAt(c21, 3, 3)), { subject_id: changche, membership_id: null, second_membership_id: null, special_room_id: null });
    assert.equal(await cellAt(c11, 1, 1), null);
    assert.equal(await cellAt(c11, 1, 2), null);
    assert.deepEqual(num(await cellAt(c21, 5, 1)), { subject_id: sub['국어'], membership_id: mids.h1, second_membership_id: mids.s1, special_room_id: lab });
    assert.equal(await cellAt(c21, 4, 2), null);
    const a = (await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1 AND action = 'timetable.excel'`, [orgId])).rows[0].n;
    assert.equal(a, 1);
    // 다시 내려받아 그대로 올리면 바뀜 0(반영 결과가 다시 그린 글자와 맞는다)
    const again = await call('POST', url('/preview'), await download());
    assert.equal(again.json.change, 0);
  });

  await tt.test('(라) 되돌리기 → 원래 칸 · 두 번째는 409 · 남의 시간표 묶음은 404', async () => {
    const other = Number((await q1(`INSERT INTO timetable (org_id, term_id, name) VALUES ($1, $2, 'gx다른') RETURNING id`, [orgId, s.term])).id);
    const wrong = await call('POST', `${P}/timetables/${other}/grid-excel/undo`, { batchId }, { expect: 404 });
    assert.equal(wrong.status, 404);
    const r = await call('POST', url('/undo'), { batchId });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.undone > 0, r.json.skipped.length], [true, 0]);
    assert.deepEqual(await snap(), before);
    assert.equal((await call('POST', url('/undo'), { batchId }, { expect: 409 })).status, 409);
  });

  await tt.test('(마) 확정본은 409 needConfirm → confirm=1 이면 반영 · 확정본 고침 감사', async () => {
    await pool.query(`UPDATE timetable SET status = '확정' WHERE id = $1`, [tid]);
    const r = await call('POST', url('/apply'), buf, { expect: 409 });
    assert.equal(r.status, 409);
    assert.equal(r.json.needConfirm, true);
    assert.deepEqual(await snap(), before);
    const ok = await call('POST', url('/apply?confirm=1'), buf);
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.changed, 6);
    const a = (await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1 AND action = 'timetable.edit_confirmed'`, [orgId])).rows[0].n;
    assert.ok(a >= 1);
  });

  await tt.test('(바) 남의 기관 시간표는 404 · 시트 없으면 400', async () => {
    const o2 = Number((await q1(`INSERT INTO org (name, kind) VALUES ($1, '초') RETURNING id`, [`${tag}-남`])).id);
    try {
      const term2 = Number((await q1(`INSERT INTO term (org_id, year, semester) VALUES ($1, 2026, 2) RETURNING id`, [o2])).id);
      const tid2 = Number((await q1(`INSERT INTO timetable (org_id, term_id, name) VALUES ($1, $2, 'gx남') RETURNING id`, [o2, term2])).id);
      for (const [m, x, body] of [['GET', '', undefined], ['POST', '/preview', buf], ['POST', '/apply?confirm=1', buf], ['POST', '/undo', { batchId }]]) {
        const r = await call(m, `${P}/timetables/${tid2}/grid-excel${x}`, body, { expect: 404 });
        assert.equal(r.status, 404, `${m} ${x}`);
      }
      const wb = new ExcelJS.Workbook();
      wb.addWorksheet('x').addRow(['a']);
      const r = await call('POST', url('/preview'), Buffer.from(await wb.xlsx.writeBuffer()), { expect: 400 });
      assert.equal(r.status, 400);
    } finally {
      await cleanupOrgs(pool, [o2], tag);
    }
  });
});

test('칸 글자 읽기(DB 없이)', () => {
  const dict = [
    { kind: 'subject', id: 1, key: '국어' }, { kind: 'subject', id: 2, key: '수학' }, { kind: 'subject', id: 3, key: '창의적체험활동' },
    { kind: 'teacher', id: 10, key: '소담임1' }, { kind: 'teacher', id: 11, key: '소담임2' }, { kind: 'teacher', id: 12, key: '소전담1' },
    { kind: 'room', id: 20, key: 'laba' }, { kind: 'room', id: 21, key: '과학실' },
  ];
  assert.deepEqual(parseCell('국어 소담임1', dict).set, { subject_id: 1, membership_id: 10, second_membership_id: null, special_room_id: null });
  assert.equal(parseCell('  ', dict).clear, true);
  assert.ok(parseCell('국어/수학', dict).error);
  assert.ok(parseCell('소담임1·소담임2·소전담1', dict).error);
  assert.ok(parseCell('laba [과학실]', dict).error);
  assert.equal(parseCell('[과학실]', dict).set.special_room_id, 21);
});
