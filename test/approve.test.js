// T-1322a 가입 승인 서버 — 승인 목록·한 건 승인(경고·줄 찬 때)·일괄(경고 건 빠짐)·전입 승인(앞 학교 전출)·「이 계정으로 연결」·학교 경계. DB 필요.
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

test('가입 승인: 목록 · 경고면 409 · 일괄에서 빠짐 · 그래도 승인 → 연결·대기 닫힘·본인 소식·감사', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const f = await boot(t);
  const A = await f.mkOrg('가학교');
  const a = await f.admin(A);
  const base = `/api/orgs/${A}/roster`;
  const nm = `김${f.tag}`;
  const L1 = await f.line(A, nm, '1990-01-01');
  const u1 = await f.user(nm, '1991-02-02');
  await f.pending(A, L1, u1.id);
  // 경고 없는 건 하나 — 일괄로 승인된다
  const nm2 = `최${f.tag}`;
  const L2 = await f.line(A, nm2, '1985-05-05');
  const u2 = await f.user(nm2, '1985-05-05');
  await f.pending(A, L2, u2.id);

  const list = await a.call('GET', `${base}/approvals`);
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 2);
  const one = list.json.find((x) => x.userId === u1.id);
  assert.deepEqual(one.warnings.map((w) => w.code), ['birth']);
  assert.equal(one.line.id, L1);
  assert.equal(one.account.loginId, u1.login);
  assert.equal(list.json.find((x) => x.userId === u2.id).warnings.length, 0);

  const no = await a.call('POST', `${base}/approvals/${u1.id}/approve`, {});
  assert.equal(no.status, 409);
  assert.equal(no.json.code, 'roster.err.need_confirm');
  assert.equal(no.json.warnings[0].code, 'birth');

  const bulk = await a.call('POST', `${base}/approvals/bulk`, { userIds: [u1.id, u2.id] });
  assert.equal(bulk.status, 200);
  assert.deepEqual(bulk.json.done.map((x) => x.userId), [u2.id]);
  assert.equal(bulk.json.skipped.length, 1);
  assert.equal(bulk.json.skipped[0].code, 'need_confirm');
  assert.equal(Number((await f.lineUser(L2)).user_id), u2.id);
  assert.equal((await f.lineUser(L1)).user_id, null);

  const ok = await a.call('POST', `${base}/approvals/${u1.id}/approve`, { force: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(Number((await f.lineUser(L1)).user_id), u1.id);
  assert.ok((await f.open(u1.id, A)).resolved_at);
  const news = (await f.pool.query(`SELECT text FROM notification WHERE user_id = $1 AND kind = 'roster.approve'`, [u1.id])).rows;
  assert.equal(news.length, 1);
  assert.match(news[0].text, /가학교에 들어왔어요/);
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1 AND action = 'roster.approve'`, [A])).rows[0].n, 2);
  assert.equal((await a.call('GET', `${base}/approvals`)).json.length, 0);
  // 할 일 탭은 「가입 승인」(화면 판이 이 이름을 쓴다)
  const L9 = await f.line(A, `할${f.tag}`);
  const u9 = await f.user(`할${f.tag}`);
  await f.pending(A, L9, u9.id);
  const bell = await a.call('GET', '/api/notifications');
  assert.equal(bell.json.todos.find((x) => x.kind === 'signup').tab, 'approve');
});

test('가입 승인: 줄이 먼저 찼으면 409 line_taken_pick · 일괄 사유 · 줄 다시 골라 승인', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const f = await boot(t);
  const A = await f.mkOrg('나학교');
  const a = await f.admin(A);
  const base = `/api/orgs/${A}/roster`;
  const nm = `이${f.tag}`;
  const L1 = await f.line(A, nm);
  const u1 = await f.user(nm);
  await f.pending(A, L1, u1.id);
  const other = await f.user(`박${f.tag}`);
  await f.pool.query(`UPDATE membership SET user_id = $2 WHERE id = $1`, [L1, other.id]);

  const r = await a.call('POST', `${base}/approvals/${u1.id}/approve`, { force: true });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'roster.err.line_taken_pick');
  assert.equal(r.json.lineTaken, true);
  const bulk = await a.call('POST', `${base}/approvals/bulk`, { userIds: [u1.id] });
  assert.equal(bulk.json.skipped[0].code, 'line_taken_pick');
  assert.equal((await a.call('GET', `${base}/approvals`)).json[0].line.taken, true);

  const L2 = await f.line(A, nm);
  const ok = await a.call('POST', `${base}/approvals/${u1.id}/approve`, { membershipId: L2 });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(Number((await f.lineUser(L2)).user_id), u1.id);
  assert.equal(Number((await f.open(u1.id, A)).membership_id), L2); // 대기 건이 가리키는 줄도 바뀐다(평균 승인 시간이 센다)
});

test('가입 승인: 전입 코드 대기 건은 승인 순간 앞 학교 줄이 「전출」', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const f = await boot(t);
  const A = await f.mkOrg('다학교');
  const B = await f.mkOrg('앞학교');
  const a = await f.admin(A);
  const nm = `정${f.tag}`;
  const u = await f.user(nm, '1970-03-03');
  const LB = await f.line(B, nm, '1970-03-03', u.id);
  const LA = await f.line(A, nm, '1970-04-04');
  await f.pending(A, LA, u.id, 'move_in');
  const list = await a.call('GET', `/api/orgs/${A}/roster/approvals`);
  assert.equal(list.json[0].kind, 'move_in');
  assert.deepEqual(list.json[0].moveFrom, [`${f.tag}-앞학교`]);
  assert.deepEqual(list.json[0].account.orgs, [`${f.tag}-앞학교`]);
  const ok = await a.call('POST', `/api/orgs/${A}/roster/approvals/${u.id}/approve`, { force: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.moved, true);
  assert.equal((await f.lineUser(LB)).status, '전출');
  assert.equal(Number((await f.lineUser(LA)).user_id), u.id);
});

test('가입 승인: 「이 계정으로 연결」 — 휴면 계정은 연결·원래 대기 닫힘 · 다른 학교 재직이면 409 · 후보 밖 계정 409', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const f = await boot(t);
  const A = await f.mkOrg('라학교');
  const B = await f.mkOrg('딴학교');
  const a = await f.admin(A);
  const base = `/api/orgs/${A}/roster`;
  const nm = `윤${f.tag}`;
  const L = await f.line(A, nm, '1980-01-01');
  const dup = await f.user(nm, '1980-01-01');
  const old = await f.user(nm, '1980-01-01'); // 소속 없는 옛 계정
  await f.pending(A, L, dup.id);

  const w = (await a.call('GET', `${base}/approvals`)).json[0].warnings;
  const o = w.find((x) => x.code === 'other');
  assert.equal(o.accounts[0].userId, old.id);
  assert.equal(o.accounts[0].birthDate, '19800101');
  assert.match(o.text, new RegExp(old.login));

  const stranger = await f.user(`엉${f.tag}`);
  assert.equal((await a.call('POST', `${base}/approvals/${dup.id}/use-other`, { userId: stranger.id })).json.code, 'roster.err.other_not_found');

  const ok = await a.call('POST', `${base}/approvals/${dup.id}/use-other`, { userId: old.id });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(Number((await f.lineUser(L)).user_id), old.id);
  assert.ok((await f.open(dup.id, A)).resolved_at);

  const nm2 = `한${f.tag}`;
  const L2 = await f.line(A, nm2);
  const dup2 = await f.user(nm2);
  const busy = await f.user(nm2);
  await f.line(B, nm2, null, busy.id);
  await f.pending(A, L2, dup2.id);
  const r = await a.call('POST', `${base}/approvals/${dup2.id}/use-other`, { userId: busy.id });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'roster.err.other_active');
  assert.equal((await f.lineUser(L2)).user_id, null);
});

test('가입 승인: 남의 기관 승인 길목은 404', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const f = await boot(t);
  const A = await f.mkOrg('마학교');
  const B = await f.mkOrg('바학교');
  const a = await f.admin(A);
  const nm = `서${f.tag}`;
  const LB = await f.line(B, nm);
  const u = await f.user(nm);
  await f.pending(B, LB, u.id);
  assert.equal((await a.call('GET', `/api/orgs/${B}/roster/approvals`)).status, 404);
  assert.equal((await a.call('GET', `/api/orgs/${A}/roster/approvals`)).json.length, 0); // 내 목록에 남의 기관 건이 안 섞인다
  assert.equal((await a.call('POST', `/api/orgs/${B}/roster/approvals/${u.id}/approve`, { force: true })).status, 404);
  // 내 기관 경로로 남의 기관 대기 건을 집어도 404
  assert.equal((await a.call('POST', `/api/orgs/${A}/roster/approvals/${u.id}/approve`, { force: true })).status, 404);
  assert.equal((await a.call('POST', `/api/orgs/${A}/roster/approvals/${u.id}/use-other`, { userId: u.id })).status, 404);
  const bulk = await a.call('POST', `/api/orgs/${A}/roster/approvals/bulk`, { userIds: [u.id] });
  assert.equal(bulk.json.done.length, 0);
  assert.equal((await f.lineUser(LB)).user_id, null);
});
