// T-1321①b 가입 서버 — 가입(숨은 칸·IP 제한·캡차 스위치) · 코드 확인·대조·본인 재확인 · 로그인 상태 코드 입력 · 7일 정리 · 평균 승인 시간. DB 필요.
import test from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { cleanupOrgs } from './sec-helpers.js';

const HAS_DB = !!(process.env.DATABASE_URL || process.env.DATABASE_URL_FILE);
const PW = 'pw-test-1234-Zq';

async function boot(t, appOpts = {}) {
  const { createPool } = await import('../server/db.js');
  const { migrate } = await import('../server/migrate.js');
  const { createApp } = await import('../server/app.js');
  const pool = createPool();
  await migrate(pool);
  const tag = `su${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const orgs = [];
  const mkOrg = async (name) => { const id = (await pool.query(`INSERT INTO org (name, kind) VALUES ($1,'초') RETURNING id`, [`${tag}-${name}`])).rows[0].id; orgs.push(id); return id; };
  const app = createApp(pool, { testMode: true, cookieSecure: false, loginLimit: 1000, apiLimit: 10000, signupCodeLimit: 1000, signupDailyLimit: 1000, ...appOpts });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.close();
    await pool.query(`DELETE FROM notification WHERE org_id = ANY($1::bigint[])`, [orgs]);
    await pool.query(`DELETE FROM invite_code WHERE org_id = ANY($1::bigint[])`, [orgs]);
    await pool.query(`DELETE FROM unlinked_account WHERE org_id = ANY($1::bigint[]) OR user_id IN (SELECT id FROM app_user WHERE login_id LIKE $2)`, [orgs, `${tag}-%`]);
    await pool.query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM app_user WHERE login_id LIKE $1)`, [`${tag}-%`]).catch(() => {});
    await pool.query(`DELETE FROM app_user WHERE login_id LIKE $1 AND id NOT IN (SELECT user_id FROM membership WHERE user_id IS NOT NULL)`, [`${tag}~%`]);
    await cleanupOrgs(pool, orgs, tag);
    await pool.end();
  });
  const client = (ip) => {
    let cookie = '';
    let csrf = '';
    const call = async (method, path, body) => {
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf, ...(ip ? { 'x-forwarded-for': ip } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.getSetCookie?.() ?? [];
      if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
      const json = await res.json().catch(() => null);
      if (json?.csrf) csrf = json.csrf;
      return { status: res.status, json };
    };
    return { call, init: () => call('GET', '/api/auth/session') };
  };
  const line = async (orgId, name, birth = null) => (await pool.query(`INSERT INTO membership (org_id, role, name, birth_date) VALUES ($1,'교직원',$2,$3) RETURNING id`, [orgId, name, birth])).rows[0].id;
  let n = 0;
  const code = async (orgId, membershipId, kind = 'move_in') => {
    const c = `${tag}C${++n}`;
    await pool.query(`INSERT INTO invite_code (org_id, membership_id, kind, code) VALUES ($1,$2,$3,$4)`, [orgId, membershipId, kind, c]);
    return c;
  };
  const user = async (login, name, birth = null) => (await pool.query(
    `INSERT INTO app_user (name, login_id, password_hash, must_change_password, birth_date) VALUES ($1,$2,$3,FALSE,$4) RETURNING id`,
    [name, `${tag}-${login}`, await argon2.hash(PW), birth])).rows[0].id;
  const signup = async (c, over = {}) => c.call('POST', '/api/signup', { name: '홍길동', birthDate: '19900101', loginId: `${tag}-u${++n}`, password: PW, ...over });
  return { pool, tag, mkOrg, client, line, code, user, signup };
}

test('가입: 코드 없이 → 학교 없는 세션 · 칸 검사 · 중복 아이디는 같은 이름 말 없이', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const f = await boot(t);
  const c = f.client();
  await c.init();
  const bad = await f.signup(c, { birthDate: '1990-01-01' });
  assert.equal(bad.status, 400);
  assert.equal((await f.signup(c, { birthDate: '19901301' })).status, 400);
  const id = `${f.tag}-dup`;
  const ok = await f.signup(c, { loginId: id });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.noOrg, 'none');
  assert.equal(ok.json.user.orgId, null);
  const row = (await f.pool.query(`SELECT signed_up_at, birth_date, must_change_password FROM app_user WHERE login_id = $1`, [id])).rows[0];
  assert.ok(row.signed_up_at);
  assert.equal(row.must_change_password, false);
  const c2 = f.client();
  await c2.init();
  const dup = await f.signup(c2, { loginId: id.toUpperCase(), name: '홍길동' });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.code, 'signup.err.id_taken');
  assert.ok(!/이름/.test(dup.json.error));
  assert.equal((await f.signup(c2, { password: 'a' })).status, 400); // 약한 비밀번호
  // 가입해 둔 세션은 학교 길목 404
  assert.equal((await c.call('GET', `/api/orgs/${f.tag.length}/roster`)).status, 404);
});

test('가입: 숨은 칸이 차면 만들지 않고 성공인 척 · IP 하루 제한 · 캡차 스위치(끔이 기본)', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const f = await boot(t, { signupDailyLimit: 3 });
  const c = f.client(`10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`); // 다른 시험·옛 실행의 시도와 안 섞이게 자기 IP
  await c.init();
  assert.equal((await c.call('GET', '/api/signup/config')).json.captcha, false);
  const bot = `${f.tag}-bot`;
  const r = await f.signup(c, { loginId: bot, website: 'http://spam' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user, undefined);
  assert.equal((await f.pool.query(`SELECT 1 FROM app_user WHERE login_id = $1`, [bot])).rowCount, 0);
  // 위 한 번 + 둘 더 = 3, 넷째는 429
  assert.equal((await f.signup(c)).status, 200);
  assert.equal((await f.signup(c)).status, 200);
  const over = await f.signup(c);
  assert.equal(over.status, 429);
  assert.equal(over.json.code, 'signup.err.too_many');

  const g = await boot(t, { signupCaptcha: true });
  const c2 = g.client();
  await c2.init();
  assert.equal((await c2.call('GET', '/api/signup/config')).json.captcha, true);
  const no = await g.signup(c2);
  assert.equal(no.status, 400);
  assert.equal(no.json.code, 'signup.err.captcha');
  assert.equal((await g.signup(c2, { captcha: 'x' })).status, 200);
});

test('코드: 확인 · 둘 다 맞으면 바로 연결(세션이 학교 소속으로) · 쓴 코드는 못 씀', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const f = await boot(t);
  const school = await f.mkOrg('school');
  const m = await f.line(school, '김 선생', '1985-03-05');
  const code = await f.code(school, m);
  const c = f.client();
  await c.init();
  const chk = await c.call('GET', `/api/signup/code/${code}`);
  assert.equal(chk.status, 200);
  assert.equal(chk.json.orgName, `${f.tag}-school`);
  assert.equal(chk.json.name, undefined);
  assert.equal((await c.call('GET', '/api/signup/code/nope')).status, 404);
  const r = await f.signup(c, { name: '김선생', birthDate: '19850305', code });
  assert.equal(r.status, 200);
  assert.equal(r.json.result, 'linked');
  assert.equal(String(r.json.user.orgId), String(school));
  assert.equal(r.json.noOrg, undefined);
  assert.equal((await c.call('GET', '/api/auth/session')).json.user.orgId, r.json.user.orgId);
  assert.equal((await f.pool.query(`SELECT user_id FROM membership WHERE id = $1`, [m])).rows[0].user_id != null, true);
  assert.equal((await f.pool.query(`SELECT first_linked_at FROM app_user WHERE id = $1`, [r.json.user.id])).rows[0].first_linked_at != null, true);
  const c2 = f.client();
  await c2.init();
  assert.equal((await c2.call('GET', `/api/signup/code/${code}`)).status, 404);
  const again = await f.signup(c2, { code });
  assert.equal(again.status, 409);
  assert.equal(again.json.code, 'signup.err.code_invalid');
  // 코드가 틀리면 계정도 안 만든다
  const lid = `${f.tag}-nocode`;
  await f.signup(c2, { loginId: lid, code: 'bad' });
  assert.equal((await f.pool.query(`SELECT 1 FROM app_user WHERE login_id = $1`, [lid])).rowCount, 0);
});

test('코드: 하나라도 다르면 본인 재확인 → 맞아요면 승인 대기(소식 한 줄) · 고쳐서 맞으면 연결 · 명단에 생년월일 없으면 이름만', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const f = await boot(t);
  const school = await f.mkOrg('school');
  const m1 = await f.line(school, '박주무', '1980-01-01');
  const m2 = await f.line(school, '이교사', '1975-07-07');
  const m3 = await f.line(school, '최이름만');
  const k1 = await f.code(school, m1);
  const k2 = await f.code(school, m2);
  const k3 = await f.code(school, m3);

  // 이름만 다름 → 재확인(자기 값만 보임) → 맞아요 → 승인 대기
  const a = f.client();
  await a.init();
  const r1 = await f.signup(a, { name: '박 주무관', birthDate: '19800101', code: k1 });
  assert.equal(r1.json.result, 'recheck');
  assert.deepEqual(r1.json.recheck, { name: '박 주무관', birthDate: '19800101' });
  assert.equal((await f.pool.query(`SELECT user_id FROM membership WHERE id = $1`, [m1])).rows[0].user_id, null);
  const ok = await a.call('POST', '/api/signup/code', { code: k1, confirm: 'ok' });
  assert.equal(ok.json.result, 'pending');
  assert.equal(ok.json.noOrg, 'pending_approval');
  assert.equal((await a.call('GET', '/api/auth/session')).json.noOrg, 'pending_approval');
  const note = (await f.pool.query(`SELECT text, audience FROM notification WHERE org_id = $1 AND kind = 'signup.pending'`, [school])).rows;
  assert.equal(note.length, 1);
  assert.equal(note[0].audience, 'org_admins');
  const pend = await a.call('GET', '/api/signup/pending');
  assert.equal(pend.json.pending.orgName, `${f.tag}-school`);
  assert.equal(pend.json.pending.avgDays, null);
  assert.equal(pend.json.everLinked, false);
  assert.equal((await a.call('GET', `/api/orgs/${school}/roster`)).status, 404);

  // 생년월일이 다름 → 고쳐서 맞으면 바로 연결(학교 소속 세션)
  const b = f.client();
  await b.init();
  const r2 = await f.signup(b, { name: '이교사', birthDate: '19750708', code: k2 });
  assert.equal(r2.json.result, 'recheck');
  const fix = await b.call('POST', '/api/signup/code', { code: k2, confirm: 'fix', name: '이교사', birthDate: '19750707' });
  assert.equal(fix.json.result, 'linked');
  assert.equal(String(fix.json.user.orgId), String(school));
  assert.equal((await f.pool.query(`SELECT to_char(birth_date,'YYYYMMDD') AS b FROM app_user WHERE id = $1`, [fix.json.user.id])).rows[0].b, '19750707');

  // 명단에 생년월일이 없으면 이름만 본다(공백·순서 무시)
  const d = f.client();
  await d.init();
  const r3 = await f.signup(d, { name: '최 이름만', birthDate: '20000101', code: k3 });
  assert.equal(r3.json.result, 'linked');

  // 고쳐도 다르면 승인 대기
  const m4 = await f.line(school, '정다름', '1990-02-02');
  const k4 = await f.code(school, m4);
  const e = f.client();
  await e.init();
  await f.signup(e, { name: '정다름', birthDate: '19900303', code: k4 });
  const still = await e.call('POST', '/api/signup/code', { code: k4, confirm: 'fix', name: '정다름', birthDate: '19900304' });
  assert.equal(still.json.result, 'pending');
});

test('코드 입력(로그인 상태): 전입은 확인창 뒤 앞 학교 줄 「전출」 · 겸임은 확인 없이 · 승인 대기는 앞 학교 줄 그대로', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const f = await boot(t);
  const A = await f.mkOrg('A');
  const B = await f.mkOrg('B');
  const C = await f.mkOrg('C');
  const uid = await f.user('mover', '오전입', '1988-08-08');
  const old = (await f.pool.query(`INSERT INTO membership (org_id, user_id, role) VALUES ($1,$2,'교직원') RETURNING id`, [A, uid])).rows[0].id;
  const c = f.client();
  await c.init();
  assert.equal((await c.call('POST', '/api/auth/login', { loginId: `${f.tag}-mover`, password: PW })).status, 200);
  assert.equal((await c.call('POST', '/api/signup/code', { code: 'x' })).status, 409);

  // 겸임: 확인 없이 연결, 지금 학교(A) 그대로
  const mC = await f.line(C, '오전입', '1988-08-08');
  const kC = await f.code(C, mC, 'concurrent');
  const con = await c.call('POST', '/api/signup/code', { code: kC });
  assert.equal(con.json.result, 'linked');
  assert.equal(String(con.json.user.orgId), String(A));
  assert.equal((await f.pool.query(`SELECT is_concurrent FROM membership WHERE id = $1`, [mC])).rows[0].is_concurrent, true);

  // 승인 대기로 가는 전입 코드: 앞 학교 줄을 안 건드린다
  const mP = await f.line(B, '오전입', '1988-08-09');
  const kP = await f.code(B, mP);
  const mv0 = await c.call('POST', '/api/signup/code', { code: kP });
  assert.equal(mv0.json.result, 'move');
  assert.equal(mv0.json.move.from, `${f.tag}-A`);
  assert.equal(mv0.json.move.to, `${f.tag}-B`);
  const pd = await c.call('POST', '/api/signup/code', { code: kP, moveOk: true, confirm: 'ok' });
  assert.equal(pd.json.result, 'pending');
  assert.equal((await f.pool.query(`SELECT status FROM membership WHERE id = $1`, [old])).rows[0].status, '사용');
  assert.equal(String(pd.json.user.orgId), String(A)); // 학교 세션은 그대로

  // 맞는 전입 코드: 확인창 뒤 전출 + 새 학교 세션
  const m2 = await f.line(B, '오전입', '1988-08-08');
  const k2 = await f.code(B, m2);
  assert.equal((await c.call('POST', '/api/signup/code', { code: k2 })).json.result, 'move');
  const ok = await c.call('POST', '/api/signup/code', { code: k2, moveOk: true });
  assert.equal(ok.json.result, 'linked');
  assert.equal(String(ok.json.user.orgId), String(B));
  assert.equal((await f.pool.query(`SELECT status FROM membership WHERE id = $1`, [old])).rows[0].status, '전출');
  assert.equal((await c.call('GET', '/api/auth/session')).json.user.orgId, ok.json.user.orgId);
});

test('7일 정리: 연결된 적 없는 가입 계정만 · 승인 대기 요청은 요청만 만료 · 시도 기록', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const f = await boot(t);
  const { runCleanups, cleanupNames } = await import('../server/cleanup.js');
  assert.ok(cleanupNames().includes('signup.unapproved'));
  const school = await f.mkOrg('school');
  const mk = async (login, ageDays, extra = '') => {
    const id = await f.user(login, login);
    await f.pool.query(`UPDATE app_user SET signed_up_at = now() - make_interval(days => $2) ${extra} WHERE id = $1`, [id, ageDays]);
    return id;
  };
  const stale = await mk('stale', 8);
  const fresh = await mk('fresh', 3);
  const everLinked = await mk('ever', 30, ', first_linked_at = now() - interval \'20 days\'');
  const withPending = await mk('withpending', 30);
  const m = await f.line(school, 'x');
  await f.pool.query(`INSERT INTO unlinked_account (org_id, user_id, reason, membership_id, expires_at) VALUES ($1,$2,'pending_approval',$3, now() + interval '2 days')`, [school, withPending, m]);
  // 쓰던 계정이 낸 요청: 요청만 만료
  const old = await f.user('olduser', 'olduser');
  await f.pool.query(`UPDATE app_user SET first_linked_at = now() - interval '90 days' WHERE id = $1`, [old]);
  await f.pool.query(`INSERT INTO unlinked_account (org_id, user_id, reason, membership_id, created_at, expires_at) VALUES ($1,$2,'pending_approval',$3, now() - interval '9 days', now() - interval '2 days')`, [school, old, m]);

  const out = await runCleanups(f.pool, { log: { error() {} } });
  assert.equal(out.find((x) => x.name === 'signup.unapproved').ok, true);
  const alive = async (id) => (await f.pool.query(`SELECT deleted_at, login_id FROM app_user WHERE id = $1`, [id])).rows[0];
  const s = await alive(stale);
  assert.ok(s.deleted_at);
  assert.ok(!s.login_id.endsWith('-stale')); // 아이디는 다시 쓸 수 있게 비켰다
  for (const id of [fresh, everLinked, withPending, old]) assert.equal((await alive(id)).deleted_at, null);
  const req = (await f.pool.query(`SELECT resolved_at FROM unlinked_account WHERE user_id = $1`, [old])).rows[0];
  assert.ok(req.resolved_at);
  assert.equal((await f.pool.query(`SELECT resolved_at FROM unlinked_account WHERE user_id = $1`, [withPending])).rows[0].resolved_at, null);
  // 정리된 아이디로 다시 가입
  const c = f.client();
  await c.init();
  assert.equal((await f.signup(c, { loginId: `${f.tag}-stale` })).status, 200);
});

test('평균 승인 시간: 최근 90일 승인 건이 5건 이상일 때만 · 가운데 값 올림 · 거절·만료는 안 센다', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const f = await boot(t);
  const { avgApprovalDays } = await import('../server/routes/signup.js');
  const school = await f.mkOrg('school');
  const days = [1, 1, 2, 2, 10]; // 가운데 2일(산술 평균이면 3.2)
  const add = async (i, d, { approve = true, ageDays = 5 } = {}) => {
    const uid = await f.user(`avg${i}`, `avg${i}`);
    const m = await f.line(school, `avg${i}`);
    if (approve) await f.pool.query(`UPDATE membership SET user_id = $1 WHERE id = $2`, [uid, m]);
    await f.pool.query(
      `INSERT INTO unlinked_account (org_id, user_id, reason, membership_id, created_at, resolved_at, expires_at)
       VALUES ($1,$2,'pending_approval',$3, now() - make_interval(days => $4) - make_interval(days => $5::int), now() - make_interval(days => $4), now() - make_interval(days => $4) + interval '7 days')`,
      [school, uid, m, ageDays, d],
    );
  };
  for (let i = 0; i < 4; i += 1) await add(i, days[i]);
  assert.equal(await avgApprovalDays(f.pool, school), null); // 4건
  await add(10, 5, { approve: false }); // 승인 아님(연결 안 됨) — 안 센다
  await add(11, 20, { ageDays: 120 }); // 90일 밖
  assert.equal(await avgApprovalDays(f.pool, school), null);
  await add(4, days[4]);
  assert.equal(await avgApprovalDays(f.pool, school), 2);
});
