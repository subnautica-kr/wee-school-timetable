// T-1321①a 로그인 분기 넷(설계 「명단·계정·요청 보드 상세 설계」 가입 화면 절). DB 필요(DATABASE_URL).
// ① 계정 없음 401 ② 잠김 401 ③ 로그인 되는 줄 0 → 학교 없는 세션(noOrg 갈래) ④ 고른 학교 소속 아님 401
import test from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { cleanupOrgs } from './sec-helpers.js';

const HAS_DB = !!(process.env.DATABASE_URL || process.env.DATABASE_URL_FILE);

test('로그인 분기 넷', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const { createPool } = await import('../server/db.js');
  const { migrate } = await import('../server/migrate.js');
  const { createApp } = await import('../server/app.js');
  const pool = createPool();
  await migrate(pool);
  const tag = `ab${Date.now()}`;
  const hash = await argon2.hash('pw-test-1234');
  const q1 = async (sql, args) => (await pool.query(sql, args)).rows[0];
  const org = async (name) => (await q1(`INSERT INTO org (name, kind) VALUES ($1,'초') RETURNING id`, [`${tag}-${name}`])).id;
  const user = async (id) => Number((await q1(`INSERT INTO app_user (name, login_id, password_hash) VALUES ($1,$2,$3) RETURNING id`, [id, `${tag}-${id}`, hash])).id);
  const member = (orgId, uid, status = '사용') => pool.query(`INSERT INTO membership (org_id, user_id, role, status) VALUES ($1,$2,'교직원',$3)`, [orgId, uid, status]);
  const school = await org('school');
  const other = await org('other');
  const app = createApp(pool, { testMode: true, cookieSecure: false, loginLimit: 1000, apiLimit: 10000 });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.close();
    await pool.query(`DELETE FROM unlinked_account WHERE user_id IN (SELECT id FROM app_user WHERE login_id LIKE $1)`, [`${tag}-%`]);
    await cleanupOrgs(pool, [school, other], tag);
    await pool.end();
  });
  const login = async (id, password = 'pw-test-1234', orgId) => {
    const s = await fetch(base + '/api/auth/session');
    const cookie = (s.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const { csrf } = await s.json();
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ loginId: `${tag}-${id}`, password, orgId }) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  // 소속 있음 — 평소 로그인, noOrg 없음
  const tch = await user('tch');
  await member(school, tch);
  const okRes = await login('tch');
  assert.equal(okRes.status, 200);
  assert.equal(okRes.json.user.orgId, Number(school));
  assert.equal(okRes.json.noOrg, undefined);

  // ① 계정 없음
  assert.equal((await login('nobody')).status, 401);

  // ② 잠김 — 비밀번호가 맞아도 401
  const lck = await user('lck');
  await pool.query(`UPDATE app_user SET status = '잠김' WHERE id = $1`, [lck]);
  assert.equal((await login('lck')).status, 401);

  // ③ 로그인 되는 줄 0 — 학교 없는 세션 · 갈래 넷
  await user('bare'); // 코드 없이 가입(소속 0)
  const r3 = await login('bare');
  assert.equal(r3.status, 200);
  assert.equal(r3.json.user.orgId, null);
  assert.equal(r3.json.user.role, null);
  assert.equal(r3.json.noOrg, 'none');

  const hid = await user('hid'); // 옛 숨김 줄만 — 「연결된 줄 0」이 아니라 「로그인 되는 줄 0」
  await member(school, hid, '숨김');
  assert.equal((await login('hid')).json.noOrg, 'none');

  const pend = await user('pend');
  await pool.query(`INSERT INTO unlinked_account (org_id, user_id, reason, expires_at) VALUES ($1,$2,'pending_approval', now() + interval '7 days')`, [school, pend]);
  assert.equal((await login('pend')).json.noOrg, 'pending_approval');

  const dor = await user('dor');
  await pool.query(`UPDATE app_user SET dormant_at = now(), dormant_reason = 'retired' WHERE id = $1`, [dor]);
  assert.equal((await login('dor')).json.noOrg, 'dormant');

  const unl = await user('unl');
  await pool.query(`INSERT INTO unlinked_account (org_id, user_id, reason, expires_at) VALUES ($1,$2,'unlinked', now() + interval '30 days')`, [school, unl]);
  assert.equal((await login('unl')).json.noOrg, 'unlinked');

  // ③ 인데 비밀번호가 틀리면 401 과 실패 횟수
  assert.equal((await login('bare', 'wrong-pw-0000')).status, 401);
  assert.equal((await q1(`SELECT failed_count FROM app_user WHERE login_id = $1`, [`${tag}-bare`])).failed_count, 1);

  // ④ 고른 학교에 소속 없음 → 401 · 소속 있는 학교를 고르면 그 학교로
  assert.equal((await login('tch', 'pw-test-1234', Number(other))).status, 401);
  assert.equal((await login('bare', 'pw-test-1234', Number(school))).status, 401);
  const r4 = await login('tch', 'pw-test-1234', Number(school));
  assert.equal(r4.status, 200);
  assert.equal(r4.json.user.orgId, Number(school));
});
