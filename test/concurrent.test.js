// T-1322b②c 겸임 연결·기간·종료 — 기본 기한(한국 시간·윤년) · 연결 때 기한·양쪽 소식 · 기간 늘리기 · 30일 전 알림 한 번 · 기한이 지나면 연결 풀림. DB 필요.
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

import { defaultConcurrentUntil, kstToday, resolveUntil, isRealDate } from '../server/concurrent.js';
import { concurrentEnd } from '../server/concurrent.js';
import { cleanupNames } from '../server/cleanup.js';

test('기본 기한: 그 학년도 2월 말일 · 한국 시간 기준 · 윤년', () => {
  assert.equal(defaultConcurrentUntil(new Date('2026-11-25T03:00:00Z')), '2027-02-28');
  assert.equal(defaultConcurrentUntil(new Date('2027-03-01T00:00:00+09:00')), '2028-02-29'); // 3월 1일 = 새 학년도 · 2028 윤년
  assert.equal(defaultConcurrentUntil(new Date('2027-02-28T23:30:00+09:00')), '2027-02-28');
  assert.equal(defaultConcurrentUntil(new Date('2028-01-15T12:00:00+09:00')), '2028-02-29');
  // UTC 로는 2월 28일 15시 이후 = 한국은 3월 1일 → 다음 학년도
  assert.equal(defaultConcurrentUntil(new Date('2027-02-28T15:00:00Z')), '2028-02-29');
  assert.equal(defaultConcurrentUntil(new Date('2027-02-28T14:59:00Z')), '2027-02-28');
  assert.equal(defaultConcurrentUntil(new Date('2099-04-01T00:00:00+09:00')), '2100-02-28'); // 2100 은 윤년 아님
  assert.equal(kstToday(new Date('2026-12-31T15:00:00Z')), '2027-01-01');
});

test('기한 입력: 없으면 기본값 · 지난 날·없는 날·글자 아님은 거부', () => {
  const now = new Date('2026-11-25T03:00:00Z');
  assert.deepEqual(resolveUntil(undefined, now), { until: '2027-02-28' });
  assert.deepEqual(resolveUntil('2027-01-31', now), { until: '2027-01-31' });
  assert.deepEqual(resolveUntil('2026-11-25', now), { until: '2026-11-25' });
  for (const bad of ['2026-11-24', '2027-02-30', '내일', '2027-1-1']) assert.equal(resolveUntil(bad, now).error, 'roster.err.concurrent_until_bad', bad);
  assert.ok(isRealDate('2028-02-29') && !isRealDate('2027-02-29'));
});

// 보내는 학교 F 에 본 소속 계정 · 겸임 학교 T 에 빈 줄 · 두 학교 관리자
async function scene(t) {
  const f = await boot(t);
  const F = await f.mkOrg('본소속학교');
  const T = await f.mkOrg('겸임학교');
  const aF = await f.admin(F);
  const aT = await f.admin(T);
  const nm = `겸${f.tag}`;
  const u = await f.user(nm);
  const LF = await f.line(F, nm, null, u.id);
  const LT = await f.line(T, nm);
  const link = (extra = {}) => aT.call('POST', `/api/orgs/${T}/roster/${LT}/link`, { loginId: u.login, force: true, concurrent: true, ...extra });
  const row = async () => (await f.pool.query(
    `SELECT user_id, is_concurrent, to_char(concurrent_until,'YYYY-MM-DD') AS until, to_char(concurrent_warned_until,'YYYY-MM-DD') AS warned FROM membership WHERE id = $1`, [LT])).rows[0];
  const news = async (org, kind) => (await f.pool.query(`SELECT text FROM notification WHERE org_id = $1 AND kind = $2 ORDER BY id`, [org, kind])).rows;
  const clean = (now) => concurrentEnd(f.pool, now); // 한 일만 돌린다(전체를 2099 시계로 돌리면 소식 90일 정리가 시험 자료를 지운다)
  return { ...f, F, T, aF, aT, u, LF, LT, link, row, news, clean };
}

test('겸임 연결: 기한을 안 주면 기본값 · 양쪽 학교에 소식', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const s = await scene(t);
  const r = await s.link();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.isConcurrent, true);
  assert.equal(r.json.concurrentUntil, defaultConcurrentUntil());
  const w = await s.row();
  assert.equal(w.is_concurrent, true);
  assert.equal(w.until, defaultConcurrentUntil());
  assert.equal((await s.news(s.T, 'concurrent.linked')).length, 1);
  assert.equal((await s.news(s.F, 'concurrent.linked')).length, 1);
});

test('겸임 연결: 기한을 주면 그대로 · 지난 날은 400 · 연결 안 됨', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const s = await scene(t);
  const bad = await s.link({ until: '2020-01-01' });
  assert.equal(bad.status, 400, JSON.stringify(bad.json));
  assert.equal((await s.row()).user_id, null);
  const ok = await s.link({ until: '2099-03-31' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal((await s.row()).until, '2099-03-31');
});

test('기간 늘리기: PUT 으로 바꾸면 양쪽 소식 · 겸임 아닌 줄은 409 · 남의 학교 줄은 404', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const s = await scene(t);
  const put = (body, org = s.T, mid = s.LT, c = s.aT) => c.call('PUT', `/api/orgs/${org}/roster/${mid}/concurrent`, body);
  assert.equal((await put({ until: '2099-01-01' })).status, 409); // 아직 연결 전
  assert.equal((await s.link({ until: '2099-01-31' })).status, 200);
  const r = await put({ until: '2099-12-31' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await s.row()).until, '2099-12-31');
  assert.equal((await s.news(s.T, 'concurrent.extended')).length, 1);
  assert.equal((await s.news(s.F, 'concurrent.extended')).length, 1);
  assert.equal((await put({ until: '2001-01-01' })).status, 400);
  assert.equal((await put({})).status, 400);
  assert.equal((await put({ until: '2099-12-31' }, s.F, s.LT, s.aF)).status, 404); // F 관리자가 T 줄을 건드릴 수 없다
  assert.equal((await put({ until: '2099-12-31' }, s.F, s.LF, s.aF)).status, 409); // 본 소속 줄은 겸임 아님
});

test('정리 작업: 끝나기 30일 전 소식은 한 번 · 기한이 지나면 연결이 풀리고 종료 소식 · 묶음엔 안 섬', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const s = await scene(t);
  assert.equal((await s.link({ until: '2099-03-31' })).status, 200);
  const at = (d) => new Date(`${d}T12:00:00+09:00`);
  await s.clean(at('2099-02-01')); // 58일 전 — 아직
  assert.equal((await s.news(s.T, 'concurrent.warn')).length, 0);
  await s.clean(at('2099-03-01')); // 30일 전
  assert.equal((await s.news(s.T, 'concurrent.warn')).length, 1);
  assert.equal((await s.news(s.F, 'concurrent.warn')).length, 1);
  assert.equal((await s.row()).warned, '2099-03-31');
  await s.clean(at('2099-03-15'));
  assert.equal((await s.news(s.T, 'concurrent.warn')).length, 1, '두 번째로 안 낸다');
  await s.clean(at('2099-03-31')); // 기한 당일은 아직 겸임
  assert.equal((await s.row()).user_id != null, true);
  await s.clean(at('2099-04-01')); // 기한 다음 날 — 끝
  const w = await s.row();
  assert.equal(w.user_id, null);
  assert.equal(w.is_concurrent, false);
  assert.equal(w.until, null);
  assert.equal((await s.news(s.T, 'concurrent.ended')).length, 1);
  assert.equal((await s.news(s.F, 'concurrent.ended')).length, 1);
  assert.equal((await s.pool.query(`SELECT 1 FROM unlinked_account WHERE user_id = $1`, [s.u.id])).rowCount, 0);
  assert.equal((await s.pool.query(`SELECT user_id FROM membership WHERE id = $1`, [s.LF])).rows[0].user_id != null, true); // 본 소속은 그대로
  await s.clean(at('2099-04-02'));
  assert.equal((await s.news(s.T, 'concurrent.ended')).length, 1, '다시 안 낸다');
});

test('정리 작업: 기한을 늘리면 알림이 다시 · 이미 기한이 지났으면 알림 없이 끝', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const s = await scene(t);
  assert.equal((await s.link({ until: '2099-03-31' })).status, 200);
  const at = (d) => new Date(`${d}T12:00:00+09:00`);
  await s.clean(at('2099-03-10'));
  assert.equal((await s.news(s.T, 'concurrent.warn')).length, 1);
  const r = await s.aT.call('PUT', `/api/orgs/${s.T}/roster/${s.LT}/concurrent`, { until: '2099-05-31' });
  assert.equal(r.status, 200);
  assert.equal((await s.row()).warned, null);
  await s.clean(at('2099-05-10'));
  assert.equal((await s.news(s.T, 'concurrent.warn')).length, 2);
  // 알림 없이 기한이 지난 줄
  await s.pool.query(`UPDATE membership SET concurrent_until = '2099-01-01', concurrent_warned_until = NULL WHERE id = $1`, [s.LT]);
  await s.clean(at('2099-06-01'));
  assert.equal((await s.news(s.T, 'concurrent.warn')).length, 2);
  assert.equal((await s.row()).user_id, null);
});

test('정리 작업 틀에 concurrent-end 가 달려 있다', () => {
  assert.ok(cleanupNames().includes('concurrent-end'));
});
