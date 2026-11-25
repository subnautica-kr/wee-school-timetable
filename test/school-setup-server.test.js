// 학교 자료 넣기 서버(T-1308) — 단계별 세기 · 한 단계 올리기 한 바퀴(바로 저장 → 되돌리기) · 못 읽은 줄 물음 · 점검 항목 · 권한 없으면 404
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import argon2 from 'argon2';
import { makeWorkbook, gradeSpec, roomsSpec, rosterSpec } from '../server/export/import.js';
import { loadsSpec } from '../server/export/loadsImport.js';
import { fixturePassword } from './fixtures/schools.js';
import { setupSchoolEnv, HAS_DB } from './fixtures/school-env.js';

// 빈 양식에 줄을 붙인 파일 — 관리 번호는 비움(새 줄)
const sheetFile = async (spec, rows) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await makeWorkbook([spec], { [spec.name]: [] }));
  const ws = wb.getWorksheet(spec.sheet);
  for (const r of rows) ws.addRow(['', ...r]);
  return Buffer.from(await wb.xlsx.writeBuffer());
};
const stepNo = (st, key) => st.steps.find((s) => s.key === key);

test('학교 자료 넣기 서버: 한 바퀴', { skip: !HAS_DB && 'DATABASE_URL 없음' }, async (tt) => {
  const env = await setupSchoolEnv(tt, 'su');
  const { pool, orgId, tag, call, P } = env;
  const S = `${P}/school-setup`;

  await tt.test('(가) 빈 기관 — 단계마다 0건·빈 것, 넣을 것이 남음', async () => {
    const r = await call('GET', `${S}/status`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.steps.map((s) => s.key), ['school', 'rooms', 'roster', 'loads', 'pins', 'check', 'generate']);
    for (const k of ['school', 'rooms', 'loads', 'pins']) assert.equal(stepNo(r.json, k).count, 0, k);
    assert.ok(stepNo(r.json, 'school').empty && !stepNo(r.json, 'school').done);
    assert.equal(r.json.ready, false);
    for (const step of ['school', 'rooms', 'roster', 'loads', 'pins']) assert.equal((await call('GET', `${S}/${step}/file`)).status, 200, step);
  });

  let batchId;
  await tt.test('(나) 학교 기본 올리기 — 바로 저장 · 되돌리면 반·교시 설정이 처음 값', async () => {
    const before = (await pool.query(`SELECT period_config::text AS v FROM org WHERE id = $1`, [orgId])).rows[0].v;
    const buf = await sheetFile(gradeSpec, [['1', '2', '5', ''], ['3', '3', '6', '3']]);
    const r = await call('POST', `${S}/school/apply`, buf);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.added, r.json.changed, r.json.failed.length], [2, 0, 0]);
    batchId = r.json.batchId;
    const n = (await pool.query(`SELECT count(*)::int AS n FROM classroom WHERE org_id = $1 AND deleted_at IS NULL`, [orgId])).rows[0].n;
    assert.equal(n, 5);
    const pc = (await pool.query(`SELECT period_config FROM org WHERE id = $1`, [orgId])).rows[0].period_config;
    assert.equal(pc.grades['3'].periods, 6);
    assert.equal(pc.grades['3'].lunchAfter, 3);
    const st = (await call('GET', `${S}/status`)).json;
    assert.equal(stepNo(st, 'school').count, 2);
    assert.equal(stepNo(st, 'school').extra.classes, 5);
    // 같은 파일을 한 번 더 — 바뀐 것 없음(묶음도 안 만듦)
    const again = await call('POST', `${S}/school/apply`, await sheetFile(gradeSpec, []));
    assert.equal(again.json.batchId, null);
    // 반 줄이기는 못 읽은 줄로 거절
    const shrink = await call('POST', `${S}/school/apply`, await sheetFile(gradeSpec, [['3', '1', '', '']]), { expect: 400 });
    assert.equal(shrink.status, 400);
    const undo = await call('POST', `${S}/undo`, { batchId });
    assert.equal(undo.status, 200);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM classroom WHERE org_id = $1 AND deleted_at IS NULL`, [orgId])).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT period_config::text AS v FROM org WHERE id = $1`, [orgId])).rows[0].v, before);
    assert.equal((await call('POST', `${S}/undo`, { batchId }, { expect: 409 })).status, 409);
    // 다시 올려 둔다(뒤 시험이 쓴다)
    assert.equal((await call('POST', `${S}/school/apply`, buf)).status, 200);
  });

  await tt.test('(다) 특별실 · 명단 · 시수표 — 올리면 저장, 못 읽은 줄은 묻고 → partial 로 읽은 줄만', async () => {
    const rooms = await call('POST', `${S}/rooms/apply`, await sheetFile(roomsSpec, [['과학실', '수업용', '30'], ['도서관', '예약용', '']]));
    assert.equal(rooms.json.added, 2);
    const bad = await call('POST', `${S}/rooms/apply`, await sheetFile(roomsSpec, [['음악실', '수업용', ''], ['미술실', '엉뚱', '']]), { expect: 409 });
    assert.equal(bad.status, 409);
    assert.equal(bad.json.needConfirm, true);
    assert.equal(bad.json.readable, 1);
    assert.ok(bad.json.error.includes('1줄만 저장'), bad.json.error);
    assert.ok(bad.json.marked);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM special_room WHERE org_id = $1 AND deleted_at IS NULL`, [orgId])).rows[0].n, 2, '묻는 동안은 안 씀');
    const ok = await call('POST', `${S}/rooms/apply?partial=1`, await sheetFile(roomsSpec, [['음악실', '수업용', ''], ['미술실', '엉뚱', '']]));
    assert.equal(ok.json.added, 1);
    assert.equal(ok.json.errors.length, 1);
    // 읽을 줄이 하나도 없으면 partial 이어도 400
    assert.equal((await call('POST', `${S}/rooms/apply?partial=1`, await sheetFile(roomsSpec, [['', '엉뚱', '']]), { expect: 400 })).status, 400);

    const people = ['김담임', '이전담', '박교사'];
    assert.equal((await call('POST', `${S}/roster/apply`, await sheetFile(rosterSpec, people.map((n) => [n, n === '김담임' ? '담임' : '', '']))).catch?.(() => null) ?? { status: 0 }).status, 200);

    // 시수표: 1-1 반에 주당 28시수(칸은 5교시×5일=25) · 선생님·교과 빈 줄은 못 읽은 줄이라 제외
    const subj = (await pool.query(`SELECT name FROM subject WHERE org_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 2`, [orgId])).rows.map((x) => x.name);
    if (subj.length < 2) { for (const n of ['국어', '수학']) await pool.query(`INSERT INTO subject (org_id, name) VALUES ($1,$2)`, [orgId, n]); subj.splice(0, subj.length, '국어', '수학'); }
    const loads = await call('POST', `${S}/loads/apply`, await sheetFile(loadsSpec, [['김담임', subj[0], '1-1', '20', '', '', ''], ['박교사', subj[1], '1-1', '8', '', '', '']]));
    assert.equal(loads.status, 200, JSON.stringify(loads.json));
    assert.equal(loads.json.added, 2);
  });

  await tt.test('(라) 넣은 것 확인 — 칸보다 많은 반·담임 없는 반이 뜸', async () => {
    const st = (await call('GET', `${S}/status`)).json;
    const c = (k) => st.checks.find((x) => x.key === k);
    assert.equal(stepNo(st, 'rooms').count, 3);
    assert.equal(stepNo(st, 'loads').count, 2);
    assert.equal(c('over_class').count, 1);
    assert.deepEqual([c('over_class').items[0].grade, c('over_class').items[0].class_no, c('over_class').items[0].hours, c('over_class').items[0].cap], [1, 1, 28, 25]);
    assert.equal(c('no_homeroom').count, 5);
    assert.equal(c('no_class').count, 1, '담임 줄은 있는데 맡은 반이 없음');
    assert.equal(c('over_teacher').count, 0);
    assert.equal(c('incomplete').count, 0);
    assert.ok(st.issueTotal >= 7);
    assert.equal(stepNo(st, 'check').done, false);
    assert.equal(st.ready, true);
  });

  await tt.test('(마) 권한 없는 사용자는 앱 가드대로 404', async () => {
    const uid = (await pool.query(`INSERT INTO app_user (name, login_id, password_hash, must_change_password) VALUES ('교직원', $1, $2, FALSE) RETURNING id`, [`${tag}-tch`, await argon2.hash(fixturePassword)])).rows[0].id;
    await pool.query(`INSERT INTO membership (org_id, user_id, role) VALUES ($1,$2,'교직원')`, [orgId, uid]);
    const login = await call('POST', '/api/auth/login', { orgId, loginId: `${tag}-tch`, password: fixturePassword });
    assert.equal(login.status, 200);
    for (const [m, p] of [['GET', `${S}/loads/file`], ['POST', `${S}/loads/apply`], ['POST', `${S}/school/apply`], ['POST', `${S}/undo`], ['GET', `${S}/nothing/file`]]) {
      assert.equal((await call(m, p, m === 'POST' ? Buffer.from('x') : undefined, { expect: 404 })).status, 404, `${m} ${p}`);
    }
  });
});
