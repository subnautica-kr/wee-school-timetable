// T-1321①a 학교 없는 세션은 학교 길목(/api/orgs/:orgId/…)·상위 기관 길목에 하나도 못 들어간다. DB 필요(DATABASE_URL).
import test from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { cleanupOrgs } from './sec-helpers.js';
import { requireOrgAction } from '../server/guard.js';

const HAS_DB = !!(process.env.DATABASE_URL || process.env.DATABASE_URL_FILE);

test('가드: 학교 없는 세션은 역할이 남아 있어도 404', () => {
  for (const orgId of [null, undefined]) {
    let code = 0;
    let passed = false;
    const req = { params: { orgId: String(orgId) }, session: { userId: 1, orgId, role: '기관관리자' } };
    const res = { status: (c) => { code = c; return { json: () => {} }; } };
    requireOrgAction('school.manage')(req, res, () => { passed = true; });
    assert.equal(passed, false);
    assert.equal(code, 404);
  }
});

test('학교 없는 세션 → 학교 길목 404', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const { createPool } = await import('../server/db.js');
  const { migrate } = await import('../server/migrate.js');
  const { createApp } = await import('../server/app.js');
  const pool = createPool();
  await migrate(pool);
  const tag = `an${Date.now()}`;
  const hash = await argon2.hash('pw-test-1234');
  const school = (await pool.query(`INSERT INTO org (name, kind) VALUES ($1,'초') RETURNING id`, [`${tag}-school`])).rows[0].id;
  await pool.query(`INSERT INTO app_user (name, login_id, password_hash, must_change_password) VALUES ('bare',$1,$2,FALSE)`, [`${tag}-bare`, hash]);
  const app = createApp(pool, { testMode: true, cookieSecure: false, loginLimit: 1000, apiLimit: 10000 });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.close();
    await cleanupOrgs(pool, [school], tag);
    await pool.end();
  });
  let cookie = '';
  let csrf = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.getSetCookie?.() ?? [];
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const json = await res.json().catch(() => null);
    if (json?.csrf) csrf = json.csrf;
    return { status: res.status, json };
  };
  await call('GET', '/api/auth/session');
  const lg = await call('POST', '/api/auth/login', { loginId: `${tag}-bare`, password: 'pw-test-1234' });
  assert.equal(lg.status, 200);
  assert.equal(lg.json.user.orgId, null);

  const s = await call('GET', '/api/auth/session');
  assert.ok(s.json.user.id > 0);
  assert.equal(s.json.noOrg, 'none');

  const paths = [
    ['GET', `/api/orgs/${school}/attendance?ym=2026-11`],
    ['GET', `/api/orgs/${school}/roster`],
    ['GET', `/api/orgs/${school}/audit`],
    ['GET', '/api/orgs/null/attendance?ym=2026-11'],
    ['GET', '/api/orgs/null/roster'],
    ['GET', '/api/orgs/undefined/roster'],
    ['POST', `/api/orgs/${school}/attendance`, { on_date: '2026-11-03', hours: 1 }],
    ['POST', '/api/orgs/null/attendance', { on_date: '2026-11-03', hours: 1 }],
    ['GET', '/api/admin/orgs'],
  ];
  for (const [m, p, b] of paths) {
    const r = await call(m, p, b);
    assert.equal(r.status, 404, `${m} ${p} → ${r.status}`);
  }
  // 소속 목록은 비어 있고, 학교로 갈아타기도 404
  assert.deepEqual((await call('GET', '/api/auth/memberships')).json.items, []);
  assert.equal((await call('POST', '/api/auth/switch-org', { orgId: Number(school) })).status, 404);
});
