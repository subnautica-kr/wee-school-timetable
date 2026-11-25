// T-1322a 「이 학교에서 나가기」(POST /api/me/leave) — 연결 해제·관리자 소식·세션 끝 · 마지막 기관 관리자 409. DB 필요.
import test from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { cleanupOrgs } from './sec-helpers.js';
const HAS_DB = !!(process.env.DATABASE_URL || process.env.DATABASE_URL_FILE);
const PW = 'pw-test-1234-Zq';

async function boot(t) {
  const { createPool } = await import('../server/db.js');
  const { migrate } = await import('../server/migrate.js');
  const { createApp } = await import('../server/app.js');
  const pool = createPool();
  await migrate(pool);
  const tag = `lv${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const orgs = [];
  const mkOrg = async (name) => { const id = (await pool.query(`INSERT INTO org (name, kind) VALUES ($1,'초') RETURNING id`, [`${tag}-${name}`])).rows[0].id; orgs.push(id); return id; };
  const app = createApp(pool, { testMode: true, cookieSecure: false, loginLimit: 1000, apiLimit: 10000 });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.close();
    await cleanupOrgs(pool, orgs, tag);
    await pool.end();
  });
  let n = 0;
  // 계정 + 그 학교 줄 하나 + 로그인한 손님
  const member = async (orgId, role = '교직원') => {
    const login = `${tag}-u${++n}`;
    const name = `교사${tag}${n}`;
    const uid = Number((await pool.query(
      `INSERT INTO app_user (name, login_id, password_hash, must_change_password) VALUES ($1,$2,$3,FALSE) RETURNING id`,
      [name, login, await argon2.hash(PW)])).rows[0].id);
    const mid = Number((await pool.query(`INSERT INTO membership (org_id, role, name, user_id, status) VALUES ($1,$2,$3,$4,'사용') RETURNING id`, [orgId, role, name, uid])).rows[0].id);
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
    const r = await call('POST', '/api/auth/login', { loginId: login, password: PW });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return { uid, mid, name, call };
  };
  return { pool, mkOrg, member };
}

test('나가기: 교직원 → 줄의 계정 칸 빔 · 휴면 · 관리자 소식 한 줄 · 세션 끝 · 감사', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const f = await boot(t);
  const A = await f.mkOrg('가학교');
  await f.member(A, '기관관리자');
  const m = await f.member(A);
  const r = await m.call('POST', '/api/me/leave');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.dormant, true);
  const ln = (await f.pool.query(`SELECT user_id, name FROM membership WHERE id = $1`, [m.mid])).rows[0];
  assert.equal(ln.user_id, null);
  assert.equal(ln.name, m.name); // 줄은 그대로
  assert.equal((await f.pool.query(`SELECT dormant_reason FROM app_user WHERE id = $1`, [m.uid])).rows[0].dormant_reason, 'left');
  const news = (await f.pool.query(`SELECT text, audience FROM notification WHERE org_id = $1 AND kind = 'me.leave'`, [A])).rows;
  assert.equal(news.length, 1);
  assert.equal(news[0].audience, 'org_admins');
  assert.match(news[0].text, new RegExp(m.name));
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1 AND action = 'me.leave'`, [A])).rows[0].n, 1);
  assert.equal((await m.call('GET', '/api/auth/session')).json?.user?.id ?? null, null);
  assert.equal((await m.call('POST', '/api/me/leave')).status, 401);
});

test('나가기: 마지막 기관 관리자는 409 · 관리자가 둘이면 나간다', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const f = await boot(t);
  const A = await f.mkOrg('나학교');
  const a1 = await f.member(A, '기관관리자');
  const r = await a1.call('POST', '/api/me/leave');
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'roster.err.leave_last_admin');
  assert.ok((await f.pool.query(`SELECT user_id FROM membership WHERE id = $1`, [a1.mid])).rows[0].user_id);
  await f.member(A, '기관관리자');
  assert.equal((await a1.call('POST', '/api/me/leave')).status, 200);
});
