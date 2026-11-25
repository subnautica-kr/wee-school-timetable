// 초대 코드 일괄 발급 — POST /roster/invites/bulk · 연결 안 된 줄만 · 두 번 부르면 같은 코드 · 권한 없으면 403
import test from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { setupSchoolEnv, HAS_DB } from './fixtures/school-env.js';
import { fixturePassword } from './fixtures/schools.js';

const skip = !HAS_DB && 'DATABASE_URL 없음';

test('초대 코드 일괄 발급: 연결 안 된 줄만 · 두 번째는 같은 코드 · 교직원은 거절', { skip }, async (tt) => {
  const env = await setupSchoolEnv(tt, 'ib');
  const { pool, orgId, tag, call, P } = env;
  const line = async (name) => Number((await call('POST', `${P}/roster`, { name })).json.id);
  const free1 = await line(`${tag}가`);
  const free2 = await line(`${tag}나`);
  const uid = (await pool.query(`INSERT INTO app_user (name, login_id, password_hash, must_change_password) VALUES ($1,$2,'x',FALSE) RETURNING id`, [`${tag}연결`, `${tag}-linked`])).rows[0].id;
  await pool.query(`INSERT INTO membership (org_id, user_id, role, name) VALUES ($1,$2,'교직원',$3)`, [orgId, uid, `${tag}연결`]);
  const staff = (await pool.query(`INSERT INTO app_user (name, login_id, password_hash, must_change_password) VALUES ($1,$2,$3,FALSE) RETURNING id`, [`${tag}직원`, `${tag}-staff`, await argon2.hash(fixturePassword)])).rows[0].id;
  await pool.query(`INSERT INTO membership (org_id, user_id, role, name) VALUES ($1,$2,'교직원',$3)`, [orgId, staff, `${tag}직원`]);
  try {
    const a = await call('POST', `${P}/roster/invites/bulk`, {});
    assert.equal(a.status, 200);
    assert.deepEqual(a.json.items.map((x) => x.lineId).sort(), [free1, free2].sort());
    assert.ok(a.json.items.every((x) => /^[A-Z2-9]{8}$/.test(x.code) && x.expiresAt));
    assert.ok(a.json.xlsx.length > 100);
    const b = await call('POST', `${P}/roster/invites/bulk`, {});
    assert.deepEqual(b.json.items.map((x) => x.code), a.json.items.map((x) => x.code));
    const one = await call('POST', `${P}/roster/invites/bulk`, { lineIds: [free1] });
    assert.equal(one.json.items.length, 1);
    assert.equal(one.json.items[0].code, a.json.items.find((x) => x.lineId === free1).code);
    const l = await call('POST', '/api/auth/login', { orgId, loginId: `${tag}-staff`, password: fixturePassword });
    assert.equal(l.status, 200);
    const denied = await call('POST', `${P}/roster/invites/bulk`, {}, { expect: 404 });
    assert.equal(denied.status, 404); // 관리자 길 가드가 권한 없는 계정에 404 로 답한다(단건 길과 같다)
  } finally {
    await pool.query(`DELETE FROM invite_code WHERE org_id = $1`, [orgId]);
  }
});
