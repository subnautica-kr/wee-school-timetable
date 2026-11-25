// T-1330 기관 관리자 연락처 — 승인 대기·연결 해제 화면에 닿은 학교 것만 · 코드 없이 가입은 없음 · 적기 권유는 서버가 한 번만. DB 필요.
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
  const { getSetting, setSetting, SETTING } = await import('../server/appSetting.js');
  const pool = createPool();
  await migrate(pool);
  const tag = `oc${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const orgs = [];
  const mkOrg = async (name, config = {}) => { const id = (await pool.query(`INSERT INTO org (name, kind, config) VALUES ($1,'초',$2::jsonb) RETURNING id`, [`${tag}-${name}`, JSON.stringify(config)])).rows[0].id; orgs.push(id); return id; };
  const app = createApp(pool, { testMode: true, cookieSecure: false, loginLimit: 1000, apiLimit: 10000 });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const superBefore = await getSetting(pool, SETTING.CONTACT_SUPER);
  t.after(async () => {
    server.close();
    await setSetting(pool, SETTING.CONTACT_SUPER, superBefore);
    await pool.query(`DELETE FROM invite_code WHERE org_id = ANY($1::bigint[])`, [orgs]);
    await pool.query(`DELETE FROM unlinked_account WHERE org_id = ANY($1::bigint[])`, [orgs]);
    await cleanupOrgs(pool, orgs, tag);
    await pool.end();
  });
  const client = () => {
    let cookie = ''; let csrf = '';
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
  const user = async (name) => {
    const login = `${tag}-u${++n}`;
    const id = (await pool.query(`INSERT INTO app_user (name, login_id, password_hash, must_change_password) VALUES ($1,$2,$3,FALSE) RETURNING id`, [name, login, await argon2.hash(PW)])).rows[0].id;
    return { id: Number(id), login };
  };
  const line = async (orgId, name, userId = null, role = '교직원') =>
    Number((await pool.query(`INSERT INTO membership (org_id, role, name, user_id, status) VALUES ($1,$2,$3,$4,'사용') RETURNING id`, [orgId, role, name, userId])).rows[0].id);
  const login = async (u) => {
    const c = client();
    await c.call('GET', '/api/auth/session');
    const r = await c.call('POST', '/api/auth/login', { loginId: u.login, password: PW });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return c;
  };
  const admin = async (orgId) => { const a = await user(`관리${tag}${n}`); await line(orgId, `관리${tag}${n}`, a.id, '기관관리자'); return login(a); };
  // 승인 대기 · 연결 해제 상태를 바로 심는다
  const waiting = async (orgId, reason) => {
    const u = await user(`대기${tag}${n}`);
    const mid = await line(orgId, `줄${tag}${n}`);
    await pool.query(`INSERT INTO unlinked_account (org_id, user_id, reason, membership_id, expires_at) VALUES ($1,$2,$3,$4, now() + interval '7 days')`, [orgId, u.id, reason, mid]);
    return login(u);
  };
  return { pool, tag, mkOrg, user, line, login, admin, waiting, setSuper: (v) => setSetting(pool, SETTING.CONTACT_SUPER, v) };
}

test('연락처: 승인 대기·연결 해제 화면은 닿은 학교 연락처만 · 총괄과 따로 · 없으면 그 줄이 없다 · 코드 없이 가입은 기관 것이 없다', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const f = await boot(t);
  const A = await f.mkOrg('가', { contact: ' 내선 111 ' });
  const B = await f.mkOrg('나', { contact: '내선 222' });
  const C = await f.mkOrg('다');
  await f.setSuper('055-총괄');
  const inA = await f.waiting(A, 'pending_approval');
  const p = (await inA.call('GET', '/api/signup/pending')).json;
  assert.deepEqual(p.contacts, { org: '내선 111', super: '055-총괄' });
  assert.ok(!JSON.stringify(p).includes('222'), '남의 학교 연락처가 안 샌다');
  const inC = (await (await f.waiting(C, 'pending_approval')).call('GET', '/api/signup/pending')).json;
  assert.deepEqual(inC.contacts, { super: '055-총괄' }, '기관 연락처가 비면 기관 줄만 빠진다');
  await f.setSuper(null);
  const inB = (await (await f.waiting(B, 'pending_approval')).call('GET', '/api/signup/pending')).json;
  assert.deepEqual(inB.contacts, { org: '내선 222' }, '총괄이 비면 총괄 줄만 빠진다');
  // 연결 해제된 본인 화면
  const off = (await (await f.waiting(A, 'unlinked')).call('GET', '/api/signup/pending')).json;
  assert.equal(off.noOrg, 'unlinked');
  assert.deepEqual(off.contacts, { org: '내선 111' });
  assert.equal(off.unlinkedFrom.orgName, `${f.tag}-가`, '해제된 학교 이름');
  assert.ok(!JSON.stringify(off).includes(`${f.tag}-나`), '남의 학교 이름이 안 샌다');
  assert.equal(p.unlinkedFrom, null, '승인 대기엔 이 칸이 없다');
  // 코드 없이 가입한 사람 — 어느 학교인지 몰라 기관 것이 없다
  const bare = await f.login(await f.user(`맨${f.tag}`));
  const nb = (await bare.call('GET', '/api/signup/pending')).json;
  assert.equal(nb.noOrg, 'none');
  assert.deepEqual(nb.contacts, {});
  assert.deepEqual((await (await f.admin(A)).call('GET', '/api/signup/contacts')).json, {}, '공개 길목은 총괄 것만(지금은 비어)');
});

test('연락처 칸: 기관 관리자가 적고 고친다 · 100자 넘으면 400 · 권유 표시 기록은 밖에서 못 쓴다', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const f = await boot(t);
  const A = await f.mkOrg('가');
  const a = await f.admin(A);
  const P = `/api/orgs/${A}/org/config`;
  assert.equal((await a.call('GET', P)).json.contact, '');
  assert.equal((await a.call('PUT', P, { contact: 'x'.repeat(101) })).status, 400);
  const r = await a.call('PUT', P, { contact: '  055-1  ', contactNudgeSeen: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.contact, '055-1');
  assert.equal(r.json.contactNudgeSeen, undefined);
  assert.equal((await f.pool.query(`SELECT config->>'contactNudgeSeen' AS s FROM org WHERE id = $1`, [A])).rows[0].s, null);
});

test('연락처 적기 권유: 첫 초대 코드 발급에서 한 번 · 승인 탭은 이미 보였으면 안 뜸 · 연락처가 있으면 안 뜸 · 학교마다 따로', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const f = await boot(t);
  const A = await f.mkOrg('가');
  const B = await f.mkOrg('나', { contact: '내선 1' });
  const D = await f.mkOrg('라');
  const a = await f.admin(A); const b = await f.admin(B); const d = await f.admin(D);
  const [l1, l2, lb, ld] = [await f.line(A, `갑${f.tag}`), await f.line(A, `을${f.tag}`), await f.line(B, `병${f.tag}`), await f.line(D, `정${f.tag}`)];
  const one = await a.call('POST', `/api/orgs/${A}/roster/${l1}/invite`);
  assert.equal(one.status, 201);
  assert.equal(one.json.nudge, true, '첫 코드 · 연락처 빔 · 처음');
  const two = await a.call('POST', `/api/orgs/${A}/roster/${l2}/invite`);
  assert.equal(two.json.nudge, false, '두 번째 코드엔 안 뜬다');
  assert.equal((await a.call('POST', `/api/orgs/${A}/roster/contact-nudge`)).json.show, false, '이미 보였으면 승인 탭에도 안 뜬다');
  assert.equal((await b.call('POST', `/api/orgs/${B}/roster/${lb}/invite`)).json.nudge, false, '연락처가 있으면 안 뜬다');
  assert.equal((await b.call('POST', `/api/orgs/${B}/roster/contact-nudge`)).json.show, false);
  // 승인 탭 쪽이 먼저면 거기서 한 번 · 그 뒤 첫 코드 발급엔 안 뜬다
  assert.equal((await d.call('POST', `/api/orgs/${D}/roster/contact-nudge`)).json.show, true);
  assert.equal((await d.call('POST', `/api/orgs/${D}/roster/contact-nudge`)).json.show, false);
  assert.equal((await d.call('POST', `/api/orgs/${D}/roster/${ld}/invite`)).json.nudge, false);
  // 동시에 둘이 불러도 한 쪽만 true
  const E = await f.mkOrg('마');
  const e = await f.admin(E);
  const both = await Promise.all([e.call('POST', `/api/orgs/${E}/roster/contact-nudge`), e.call('POST', `/api/orgs/${E}/roster/contact-nudge`)]);
  assert.equal(both.filter((x) => x.json.show).length, 1);
});
