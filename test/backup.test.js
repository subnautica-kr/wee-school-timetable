import test from 'node:test';
import assert from 'node:assert/strict';
import { HAS_DB, setup } from './sec-helpers.js';
import { readdirSync } from 'node:fs';
const LAST_MIGRATION = readdirSync(new URL('../server/migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort().at(-1).slice(0, -'.sql'.length); // 마지막 마이그레이션 — 새 판이 더해도 따라간다

test('학교 자료 내려받기(백업)', { skip: !HAS_DB }, async (t) => {
  const f = await setup(t);
  const { pool } = f;
  const o = `/api/orgs/${f.orgA}/backup`;
  // 심은 비밀: 사용자 비밀번호 해시는 setup 이 이미 넣었다. 감사 기록 안에도 해시 모양 값을 심는다
  const hashA = (await pool.query('SELECT password_hash FROM app_user WHERE id = $1', [f.users.adminA.uid])).rows[0].password_hash;
  await pool.query(`INSERT INTO audit_log (org_id, user_id, action, after) VALUES ($1,$2,'test.x',$3)`, [f.orgA, f.users.adminA.uid, JSON.stringify({ password_hash: hashA, note: 'ok' })]);
  const hashB = (await pool.query('SELECT password_hash FROM app_user WHERE id = $1', [f.users.adminB.uid])).rows[0].password_hash;

  await t.test('① 기관관리자는 200 · JSON · attachment', async () => {
    const c = await f.as('adminA');
    const res = await c.call('GET', o);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="backup-.+-\d{8}\.json"/);
    assert.equal(res.json.format, 'wee-timetable-backup');
    assert.equal(res.json.version, 1);
    assert.equal(res.json.schemaVersion, LAST_MIGRATION);
    assert.equal(res.json.org.id, f.orgA);
    const log = await pool.query(`SELECT 1 FROM audit_log WHERE org_id = $1 AND action = 'org.backup'`, [f.orgA]);
    assert.equal(log.rowCount, 1);
  });

  await t.test('② 교직원·보기만·다른 학교 관리자·시스템관리자는 접근 불가', async () => {
    for (const who of ['staffA', 'viewA', 'sys']) assert.equal((await (await f.as(who)).call('GET', o)).status, 404, who);
    assert.equal((await (await f.as('adminB')).call('GET', o)).status, 404);
    assert.equal((await f.client().call('GET', o)).status, 404);
  });

  await t.test('③ 다른 학교 줄이 섞이지 않는다', async () => {
    const res = await (await f.as('adminA')).call('GET', o);
    for (const [name, rows] of Object.entries(res.json.tables)) {
      for (const r of rows) if ('org_id' in r) assert.equal(String(r.org_id), String(f.orgA), `${name} 에 남의 기관 줄`);
    }
    const names = res.json.tables.subject.map((s) => s.name);
    assert.ok(names.includes('A과목') && !names.includes('B과목'));
    const logins = res.json.tables.app_user.map((u) => u.login_id);
    assert.ok(logins.includes(f.users.adminA.loginId) && !logins.includes(f.users.adminB.loginId));
  });

  await t.test('④ 비밀번호 해시가 파일 안에 없다', async () => {
    const res = await (await f.as('adminA')).call('GET', o);
    assert.ok(hashA.length > 20);
    assert.ok(!res.text.includes(hashA), '관리자 A 해시가 샜다');
    assert.ok(!res.text.includes(hashB));
    assert.ok(!res.text.includes('$argon2'));
    assert.ok(!res.text.includes('password_hash'));
    assert.ok(!('sess' in (res.json.tables.session ?? {})) && res.json.tables.session === undefined);
  });

  await t.test('⑤ 주요 표가 들어 있다', async () => {
    const res = await (await f.as('adminA')).call('GET', o);
    const T = res.json.tables;
    for (const k of ['app_user', 'membership', 'term', 'classroom', 'subject', 'special_room', 'teaching_load', 'pin', 'timetable', 'cell', 'substitute', 'booking', 'attendance']) assert.ok(Array.isArray(T[k]), k);
    assert.ok(T.app_user.length >= 4 && T.membership.length >= 4);
    assert.equal(T.timetable[0].name, 'A시간표');
    assert.ok(T.app_user[0].login_id && T.app_user[0].name);
    assert.ok('duty' in T.membership[0]); // select * — 전 열
  });
});
