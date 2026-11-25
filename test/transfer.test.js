// T-1322b① 전출 요청 서버 — 보내기→승인 · 거절 · 자동 승인 · 7일 만료 · 휴면 재임용(요청 없이 연결) · 남의 기관 404. DB 필요.
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
  const tag = `ap${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const orgs = [];
  const mkOrg = async (name) => { const id = (await pool.query(`INSERT INTO org (name, kind) VALUES ($1,'초') RETURNING id`, [`${tag}-${name}`])).rows[0].id; orgs.push(id); return id; };
  const app = createApp(pool, { testMode: true, cookieSecure: false, loginLimit: 1000, apiLimit: 10000 });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.close();
    await pool.query(`DELETE FROM transfer_request WHERE from_org = ANY($1::bigint[]) OR to_org = ANY($1::bigint[])`, [orgs]);
    await pool.query(`DELETE FROM transfer_request WHERE from_org = ANY($1::bigint[]) OR to_org = ANY($1::bigint[])`, [orgs]);
    await pool.query(`DELETE FROM invite_code WHERE org_id = ANY($1::bigint[])`, [orgs]);
    await pool.query(`DELETE FROM unlinked_account WHERE org_id = ANY($1::bigint[])`, [orgs]);
    await cleanupOrgs(pool, orgs, tag);
    await pool.end();
  });
  const client = () => {
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
    return { call };
  };
  let n = 0;
  const user = async (name, birth = null) => {
    const login = `${tag}-u${++n}`;
    const id = (await pool.query(
      `INSERT INTO app_user (name, login_id, password_hash, must_change_password, birth_date) VALUES ($1,$2,$3,FALSE,$4) RETURNING id`,
      [name, login, await argon2.hash(PW), birth])).rows[0].id;
    return { id: Number(id), login };
  };
  const line = async (orgId, name, birth = null, userId = null, role = '교직원') =>
    Number((await pool.query(`INSERT INTO membership (org_id, role, name, birth_date, user_id, status) VALUES ($1,$2,$3,$4,$5,'사용') RETURNING id`, [orgId, role, name, birth, userId])).rows[0].id);
  // 코드를 쓴 뒤 승인 대기로 넘어간 상태를 바로 심는다(가입 길은 signup.test.js 몫)
  const pending = async (orgId, mid, uid, kind = 'concurrent') => {
    await pool.query(`INSERT INTO invite_code (org_id, membership_id, kind, code, used_at, used_by) VALUES ($1,$2,$3,$4, now(), $5)`, [orgId, mid, kind, `${tag}C${++n}`, uid]);
    await pool.query(`INSERT INTO unlinked_account (org_id, user_id, reason, membership_id, expires_at) VALUES ($1,$2,'pending_approval',$3, now() + interval '7 days')`, [orgId, uid, mid]);
  };
  const admin = async (orgId) => {
    const a = await user(`관리${tag}${n}`);
    await line(orgId, `관리${tag}${n}`, null, a.id, '기관관리자');
    const c = client();
    await c.call('GET', '/api/auth/session');
    const r = await c.call('POST', '/api/auth/login', { loginId: a.login, password: PW });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return c;
  };
  const open = async (uid, orgId) => (await pool.query(`SELECT resolved_at, membership_id FROM unlinked_account WHERE user_id = $1 AND org_id = $2 AND reason = 'pending_approval' ORDER BY id DESC LIMIT 1`, [uid, orgId])).rows[0];
  const lineUser = async (mid) => (await pool.query(`SELECT user_id, status FROM membership WHERE id = $1`, [mid])).rows[0];
  return { pool, tag, mkOrg, user, line, pending, admin, open, lineUser };
}


// 보내는 학교 F 에 재직 계정 u(줄 있음) · 받는 학교 T 에 빈 줄 하나 + 두 학교 관리자
async function scene(t, name = '전') {
  const f = await boot(t);
  const F = await f.mkOrg('보내는학교');
  const T = await f.mkOrg('받는학교');
  const aF = await f.admin(F);
  const aT = await f.admin(T);
  const nm = `${name}${f.tag}`;
  const u = await f.user(nm);
  const LF = await f.line(F, nm, null, u.id);
  const LT = await f.line(T, nm);
  const link = (extra = {}) => aT.call('POST', `/api/orgs/${T}/roster/${LT}/link`, { loginId: u.login, force: true, ...extra });
  const reqRow = async () => (await f.pool.query(`SELECT * FROM transfer_request WHERE user_id = $1 AND to_org = $2 ORDER BY id DESC LIMIT 1`, [u.id, T])).rows[0];
  return { ...f, F, T, aF, aT, u, LF, LT, link, reqRow };
}

test('전출 요청: 보내기 202 → 보내는 학교 목록 → 승인 → 줄 옮김', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const s = await scene(t);
  const r = await s.link();
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(r.json.transferRequested, true);
  assert.equal((await s.lineUser(s.LT)).user_id, null);
  const list = await s.aF.call('GET', `/api/orgs/${s.F}/transfers`);
  assert.equal(list.status, 200);
  assert.equal(list.json.received.length, 1);
  assert.equal(list.json.received[0].id, r.json.requestId);
  const sent = await s.aT.call('GET', `/api/orgs/${s.T}/transfers`);
  assert.equal(sent.json.sent[0].status, 'waiting');
  const ok = await s.aF.call('POST', `/api/orgs/${s.F}/transfers/${r.json.requestId}/approve`);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(Number((await s.lineUser(s.LT)).user_id), s.u.id);
  assert.equal((await s.lineUser(s.LF)).user_id, null);
  assert.equal((await s.reqRow()).status, 'approved');
  assert.equal((await s.aF.call('POST', `/api/orgs/${s.F}/transfers/${r.json.requestId}/approve`)).status, 404); // 두 번째는 대기가 아님
});

test('전출 요청: 거절 → 줄은 그대로 · 상태 rejected', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const s = await scene(t);
  const r = await s.link();
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const no = await s.aF.call('POST', `/api/orgs/${s.F}/transfers/${r.json.requestId}/reject`);
  assert.equal(no.status, 200, JSON.stringify(no.json));
  assert.equal((await s.reqRow()).status, 'rejected');
  assert.equal((await s.lineUser(s.LT)).user_id, null);
  assert.equal(Number((await s.lineUser(s.LF)).user_id), s.u.id);
});

test('전출 요청: 보내는 학교가 자동 승인을 켜면 200 으로 바로 옮김', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const s = await scene(t);
  const on = await s.aF.call('PUT', `/api/orgs/${s.F}/transfers/auto-approve`, { on: true });
  assert.equal(on.json.autoApprove, true, JSON.stringify(on.json));
  const r = await s.link();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.autoApproved, true);
  assert.equal(Number((await s.lineUser(s.LT)).user_id), s.u.id);
  assert.equal((await s.reqRow()).status, 'approved');
});

test('전출 요청: 7일 지나면 승인·거절 409 · 정리 작업이 expired 로 닫는다', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const s = await scene(t);
  const r = await s.link();
  assert.equal(r.status, 202, JSON.stringify(r.json));
  await s.pool.query(`UPDATE transfer_request SET expires_at = now() - interval '1 minute' WHERE id = $1`, [r.json.requestId]);
  const a = await s.aF.call('POST', `/api/orgs/${s.F}/transfers/${r.json.requestId}/approve`);
  assert.equal(a.status, 409);
  assert.equal(a.json.code, 'roster.err.transfer_expired');
  assert.equal((await s.aF.call('POST', `/api/orgs/${s.F}/transfers/${r.json.requestId}/reject`)).status, 409);
  assert.equal((await s.aF.call('GET', `/api/orgs/${s.F}/transfers`)).json.received.length, 0);
  assert.equal((await s.aT.call('GET', `/api/orgs/${s.T}/transfers`)).json.sent[0].status, 'expired');
  const { runCleanups } = await import('../server/cleanup.js');
  const done = await runCleanups(s.pool, { log: { error() {} } });
  assert.equal(done.find((x) => x.name === 'transfer-7d')?.ok, true);
  assert.equal((await s.reqRow()).status, 'expired');
  assert.equal((await s.lineUser(s.LT)).user_id, null);
});

test('전출 요청: 휴면 계정을 아이디로 연결하면 요청 없이 바로 200', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const f = await boot(t);
  const T = await f.mkOrg('받는학교');
  const aT = await f.admin(T);
  const nm = `휴${f.tag}`;
  const u = await f.user(nm);
  await f.pool.query(`UPDATE app_user SET dormant_at = now(), dormant_reason = 'retired' WHERE id = $1`, [u.id]);
  const LT = await f.line(T, nm);
  const r = await aT.call('POST', `/api/orgs/${T}/roster/${LT}/link`, { loginId: u.login, force: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(Number((await f.lineUser(LT)).user_id), u.id);
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM transfer_request WHERE user_id = $1`, [u.id])).rows[0].n, 0);
  assert.equal((await f.pool.query(`SELECT dormant_at FROM app_user WHERE id = $1`, [u.id])).rows[0].dormant_at, null);
});

test('전출 요청: 남의 기관 경로는 404', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const s = await scene(t);
  const X = await s.mkOrg('제삼학교');
  const aX = await s.admin(X);
  const r = await s.link();
  const id = r.json.requestId;
  assert.equal((await aX.call('GET', `/api/orgs/${s.F}/transfers`)).status, 404);
  assert.equal((await aX.call('POST', `/api/orgs/${s.F}/transfers/${id}/approve`)).status, 404);
  // 내 기관 경로로 남의 요청 번호를 집어도 404(from_org 조건)
  assert.equal((await aX.call('POST', `/api/orgs/${X}/transfers/${id}/approve`)).status, 404);
  assert.equal((await aX.call('POST', `/api/orgs/${X}/transfers/${id}/reject`)).status, 404);
  // 받는 학교 관리자도 승인 못 한다
  assert.equal((await s.aT.call('POST', `/api/orgs/${s.T}/transfers/${id}/approve`)).status, 404);
  assert.equal((await s.reqRow()).status, 'waiting');
});

test('전출 요청: 엑셀 반영의 대기 줄도 requestTransfer 를 타서 자동 승인이 같이 먹는다', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (tt) => {
  const { makeWorkbook, rosterSpec } = await import('../server/export/import.js');
  const { setupSchoolEnv } = await import('./fixtures/school-env.js');
  const env = await setupSchoolEnv(tt, 'tx');
  const { pool, orgId, tag, call, P } = env;
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0];
  const other = Number((await one(`INSERT INTO org (name, kind) VALUES ($1, '초') RETURNING id`, [`${tag}-타교`])).id);
  const mk = async (key, name) => Number((await one(`INSERT INTO app_user (name, login_id, password_hash, must_change_password) VALUES ($1,$2,'x',FALSE) RETURNING id`, [name, `${tag}-${key}`])).id);
  const uWait = await mk('wait', '대기샘');
  const uAuto = await mk('auto', '자동샘');
  for (const [u, n] of [[uWait, '대기샘'], [uAuto, '자동샘']]) await pool.query(`INSERT INTO membership (org_id, user_id, role, name, status) VALUES ($1,$2,'교직원',$3,'사용')`, [other, u, n]);
  try {
    // 보내는 학교(other) 가 자동 승인을 켜면 둘 다 옮겨 오고, 끄면 대기. 계정마다 학교가 달라야 하니 자동샘만 별도 학교로
    const other2 = Number((await one(`INSERT INTO org (name, kind, config) VALUES ($1, '초', '{"transferAutoApprove": true}'::jsonb) RETURNING id`, [`${tag}-타교2`])).id);
    await pool.query(`UPDATE membership SET org_id = $2 WHERE user_id = $1`, [uAuto, other2]);
    const buf = await makeWorkbook([rosterSpec], { roster: [
      { id: '', text: { name: '대기샘', duty: '', birth: '', loginId: `${tag}-wait` } },
      { id: '', text: { name: '자동샘', duty: '', birth: '', loginId: `${tag}-auto` } },
    ] });
    const ap = await call('POST', `${P}/roster/excel/apply`, buf);
    assert.equal(ap.status, 200, JSON.stringify(ap.json));
    assert.deepEqual(ap.json.links.map((l) => [l.kind, l.done]), [['pending', true], ['pending', true]]);
    const line = async (n) => one(`SELECT user_id FROM membership WHERE org_id = $1 AND name = $2 AND deleted_at IS NULL`, [orgId, n]);
    assert.equal((await line('대기샘')).user_id, null);
    assert.equal(Number((await line('자동샘')).user_id), uAuto);
    assert.equal((await one(`SELECT status FROM transfer_request WHERE user_id = $1 AND to_org = $2`, [uWait, orgId])).status, 'waiting');
    assert.equal((await one(`SELECT status FROM transfer_request WHERE user_id = $1 AND to_org = $2`, [uAuto, orgId])).status, 'approved');
  } finally {
    await pool.query(`DELETE FROM notification WHERE org_id IN (SELECT id FROM org WHERE name LIKE $1)`, [`${tag}-%`]);
    await pool.query(`DELETE FROM transfer_request WHERE to_org IN (SELECT id FROM org WHERE name LIKE $1) OR from_org IN (SELECT id FROM org WHERE name LIKE $1)`, [`${tag}-%`]);
  }
});

test('전출 승인: 보내는 학교의 「담당 비었음」 소식에 시수표 빈 것 목록 링크가 실린다', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const s = await scene(t);
  const term = (await s.pool.query(`INSERT INTO term (org_id, year, semester) VALUES ($1, 2026, 2) RETURNING id`, [s.F])).rows[0].id;
  await s.pool.query(`INSERT INTO classroom (org_id, term_id, grade, class_no, homeroom_membership_id) VALUES ($1,$2,1,1,$3)`, [s.F, term, s.LF]);
  const r = await s.link();
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const ok = await s.aF.call('POST', `/api/orgs/${s.F}/transfers/${r.json.requestId}/approve`);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const n = (await s.pool.query(`SELECT link FROM notification WHERE org_id = $1 AND kind = 'roster_vacated'`, [s.F])).rows;
  assert.equal(n.length, 1);
  assert.equal(n[0].link, 'tab:school:vacant');
});
