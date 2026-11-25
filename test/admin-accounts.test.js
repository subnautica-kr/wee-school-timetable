// 총괄관리자 계정 화면(T-1326) — 계정 잠금·풂 · 소속 없는 계정 · 기관 관리자 없는 학교 · 캡차 스위치 · 연락처 · 권한(기관 관리자는 404).
import test from 'node:test';
import assert from 'node:assert/strict';
import { HAS_DB, setup, PW } from './sec-helpers.js';
import { ACTION_LABEL } from '../shared/audit-labels.js';

const skip = !HAS_DB && 'DB 없음 — 건너뜀';
const one = async (pool, sql, args) => (await pool.query(sql, args)).rows[0];
const KEYS = ['signup_captcha', 'contact_super'];

async function boot(t) {
  const { createPool } = await import('../server/db.js');
  const own = createPool(); // 설정 칸은 앱 전체 값이라 시험이 건드린 만큼 되돌린다 — setup 의 풀이 닫히기 전에 돌게 먼저 건다
  const before = (await own.query(`SELECT key, value FROM app_setting WHERE key = ANY($1::text[])`, [KEYS]).catch(() => ({ rows: [] }))).rows;
  t.after(async () => {
    await own.query(`DELETE FROM app_setting WHERE key = ANY($1::text[])`, [KEYS]);
    for (const r of before) await own.query(`INSERT INTO app_setting (key, value) VALUES ($1, $2::jsonb)`, [r.key, JSON.stringify(r.value)]);
    await own.end();
  });
  const f = await setup(t);
  await f.pool.query(`DELETE FROM app_setting WHERE key = ANY($1::text[])`, [KEYS]);
  return f;
}

test('1 잠금·풂: 총괄관리자만(기관 관리자는 404) · 잠그면 로그인·세션 끊김 · 풀면 다시 로그인 · 자기 자신·마지막 총괄관리자는 409', { skip }, async (t) => {
  const f = await boot(t);
  const { pool, users } = f;
  const sys = await f.as('sys');
  const staff = await f.as('staffA');
  const adminA = await f.as('adminA');

  for (const [m, p] of [['POST', 'lock'], ['POST', 'unlock']]) {
    const r = await adminA.call(m, `/api/admin/users/${users.staffA.uid}/${p}`);
    assert.equal(r.status, 404, `기관 관리자의 ${p}`);
  }
  assert.equal((await one(pool, `SELECT status FROM app_user WHERE id = $1`, [users.staffA.uid])).status, '사용');

  assert.equal((await sys.call('POST', `/api/admin/users/${users.sys.uid}/lock`)).status, 409); // 자기 자신
  assert.equal((await sys.call('POST', `/api/admin/users/999999999/lock`)).status, 404);

  const lk = await sys.call('POST', `/api/admin/users/${users.staffA.uid}/lock`);
  assert.equal(lk.status, 200);
  assert.equal((await one(pool, `SELECT status FROM app_user WHERE id = $1`, [users.staffA.uid])).status, '잠김');
  assert.equal((await staff.call('GET', '/api/auth/session')).json.user ?? null, null, '열린 세션이 끊겼다');
  const again = f.client();
  assert.equal((await again.login('staffA')).status, 401, '잠긴 계정은 로그인 안 됨');

  assert.equal((await sys.call('POST', `/api/admin/users/${users.staffA.uid}/unlock`)).status, 200);
  assert.equal((await f.client().login('staffA')).status, 200, '풀면 로그인');

  const log = await one(pool, `SELECT action FROM audit_log WHERE action = 'admin.lock-user' AND row_id = $1 ORDER BY id DESC LIMIT 1`, [users.staffA.uid]);
  assert.ok(log, '감사 기록');
  assert.ok(ACTION_LABEL['admin.lock-user'] && ACTION_LABEL['admin.unlock-user']);

  // 마지막 총괄관리자: 다른 총괄관리자가 없으면 잠글 수 없다(다른 총괄관리자 계정을 만들어 시험)
  const other = await pool.query(`INSERT INTO app_user (name, login_id, password_hash, must_change_password) VALUES ('s2', $1, 'x', FALSE) RETURNING id`, [`${f.tag}-sys2`]);
  await pool.query(`INSERT INTO membership (org_id, user_id, role) VALUES ($1, $2, '시스템관리자')`, [f.orgEdu, other.rows[0].id]);
  assert.equal((await sys.call('POST', `/api/admin/users/${other.rows[0].id}/lock`)).status, 200, '다른 총괄관리자가 남아 있으면 잠긴다');
  assert.equal((await sys.call('POST', `/api/admin/users/${other.rows[0].id}/unlock`)).status, 200);
});

test('2 소속 없는 계정 목록: 가입 시각·7일 정리 예정일 · 소속 있는 계정은 안 나옴 · 기관 관리자는 404', { skip }, async (t) => {
  const f = await boot(t);
  const { pool, tag } = f;
  const mk = async (name, signed, linked) => (await pool.query(
    `INSERT INTO app_user (name, login_id, password_hash, must_change_password, signed_up_at, first_linked_at) VALUES ($1, $2, 'x', FALSE, $3, $4) RETURNING id`,
    [name, `${tag}-${name}`, signed, linked],
  )).rows[0].id;
  const fresh = await mk('new1', new Date(Date.now() - 86400000), null);
  const old = await mk('old1', null, null); // 가입 화면을 안 거친(관리자가 만든) 계정 — 정리 대상 아님
  const sys = await f.as('sys');
  const r = await sys.call('GET', '/api/admin/accounts/unlinked');
  assert.equal(r.status, 200);
  const row = r.json.find((x) => x.userId === String(fresh) || x.userId === fresh);
  assert.ok(row, '가입만 한 계정이 나온다');
  const gap = (new Date(row.cleanupAt) - new Date(row.signedUpAt)) / 86400000;
  assert.equal(Math.round(gap), 7);
  assert.equal(r.json.find((x) => Number(x.userId) === old).cleanupAt, null);
  assert.equal(r.json.find((x) => Number(x.userId) === f.users.staffA.uid), undefined, '소속 있는 계정은 안 나온다');
  assert.equal((await (await f.as('adminA')).call('GET', '/api/admin/accounts/unlinked')).status, 404);
});

test('3 기관 관리자 없는 학교: 관리자를 떼면 목록에 오른다', { skip }, async (t) => {
  const f = await boot(t);
  const sys = await f.as('sys');
  const names = async () => (await sys.call('GET', '/api/admin/schools/no-admin')).json.map((o) => o.name);
  assert.ok(!(await names()).includes(`${f.tag}-B`));
  await f.pool.query(`UPDATE membership SET role = '교직원' WHERE org_id = $1 AND role = '기관관리자'`, [f.orgB]);
  const after = await names();
  assert.ok(after.includes(`${f.tag}-B`), '관리자 없는 학교 B');
  assert.ok(!after.includes(`${f.tag}-상위 기관`), '상위 기관은 학교로 안 센다');
  assert.equal((await (await f.as('adminA')).call('GET', '/api/admin/schools/no-admin')).status, 404);
});

test('4 캡차 스위치: 저장하면 가입 쪽이 읽고(켜면 캡차 값 없는 가입 400) · 기관 관리자는 404 · 가입 감시 수', { skip }, async (t) => {
  const f = await boot(t);
  const { pool, tag } = f;
  const sys = await f.as('sys');
  const anon = f.client();
  await anon.call('GET', '/api/auth/session'); // 쿠키·CSRF 받기
  assert.equal((await anon.call('GET', '/api/signup/config')).json.captcha, false);

  assert.equal((await (await f.as('adminA')).call('PUT', '/api/admin/signup-captcha', { on: true })).status, 404);
  assert.equal((await sys.call('PUT', '/api/admin/signup-captcha', { on: 'yes' })).status, 400);
  assert.equal((await sys.call('PUT', '/api/admin/signup-captcha', { on: true })).status, 200);
  assert.equal((await anon.call('GET', '/api/signup/config')).json.captcha, true);
  const body = { name: '홍길동', birthDate: '19900101', loginId: `${tag}-c1`, password: PW };
  assert.equal((await anon.call('POST', '/api/signup', body)).status, 400, '캡차 값이 없으면 막힘');
  assert.equal((await sys.call('GET', '/api/admin/signup-watch')).json.captcha, true);
  assert.equal((await sys.call('PUT', '/api/admin/signup-captcha', { on: false })).status, 200);
  assert.equal((await anon.call('GET', '/api/signup/config')).json.captcha, false);

  // 의심스러운 가입 수 — 한 곳이 하루 5번 이상 시도한 것만 센다
  const base = (await sys.call('GET', '/api/admin/signup-watch')).json;
  await pool.query(`INSERT INTO signup_attempt (ip_hash) SELECT $1 FROM generate_series(1, 6)`, [`${tag}-heavy`]);
  await pool.query(`INSERT INTO signup_attempt (ip_hash) SELECT $1 FROM generate_series(1, 2)`, [`${tag}-light`]);
  const now = (await sys.call('GET', '/api/admin/signup-watch')).json;
  assert.equal(now.suspicious - base.suspicious, 6);
  assert.equal(now.sources - base.sources, 1);
  assert.equal(now.attempts - base.attempts, 8);
  await pool.query(`DELETE FROM signup_attempt WHERE ip_hash LIKE $1`, [`${tag}-%`]);
});

test('5 총괄관리자 연락처: 적고 고치고 비움 · 가입 화면 공개 길목(로그인 전)과 승인 대기 응답이 값만 준다 · 기관 관리자는 404', { skip }, async (t) => {
  const f = await boot(t);
  const sys = await f.as('sys');
  const anon = f.client();
  assert.deepEqual((await anon.call('GET', '/api/signup/contacts')).json, {});
  assert.equal((await (await f.as('adminA')).call('PUT', '/api/admin/contact', { contact: '055-000' })).status, 404);
  assert.equal((await sys.call('PUT', '/api/admin/contact', { contact: 'x'.repeat(101) })).status, 400);
  assert.equal((await sys.call('PUT', '/api/admin/contact', { contact: ' 055-123-4567 ' })).status, 200);
  assert.equal((await sys.call('GET', '/api/admin/contact')).json.contact, '055-123-4567');
  const pub = await anon.call('GET', '/api/signup/contacts');
  assert.equal(pub.status, 200);
  assert.deepEqual(pub.json, { super: '055-123-4567' });
  assert.equal((await (await f.as('staffA')).call('GET', '/api/signup/pending')).json.contacts.super, '055-123-4567');
  assert.equal((await sys.call('PUT', '/api/admin/contact', { contact: '  ' })).status, 200);
  assert.deepEqual((await anon.call('GET', '/api/signup/contacts')).json, {}, '비우면 줄이 안 보인다');
});
