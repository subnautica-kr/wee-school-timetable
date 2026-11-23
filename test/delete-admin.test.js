// 시스템 관리자 지우기(T-1213) — 기관 삭제(중지 먼저·확인 글자·겸임 보호) · 계정 삭제 · 기관 관리자 떼기 · 권한 거부.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HAS_DB, setup } from './sec-helpers.js';
import { ACTION_LABEL } from '../shared/audit-labels.js';

const skip = !HAS_DB && 'DB 없음 — 건너뜀';
const one = async (pool, sql, args) => (await pool.query(sql, args)).rows[0];
const isLive = async (pool, table, id) => !(await one(pool, `SELECT deleted_at FROM ${table} WHERE id = $1`, [id])).deleted_at;

test('1 기관 삭제: 활성이면 409 · 글자 틀리면 400 · 지우면 자료·단독 계정 지움, 겸임 계정·감사 기록은 남김', { skip }, async (t) => {
  const f = await setup(t);
  const { pool, orgA, orgB, orgEdu, B, users } = f;
  const c = await f.as('sys');
  const org = (await one(pool, `SELECT name FROM org WHERE id = $1`, [orgB])).name;

  const pv = await c.call('GET', `/api/admin/orgs/${orgB}/delete-preview`);
  assert.equal(pv.status, 200);
  assert.equal(pv.json.canDelete, false);
  assert.equal(pv.json.confirmText, org);
  assert.equal(pv.json.counts.accounts, 1); // adminB 만 단독
  assert.equal(pv.json.counts.concurrentKept, 1); // dual
  assert.equal(pv.json.counts.classrooms, 1);

  const del = (body) => c.call('DELETE', `/api/admin/orgs/${orgB}`, body);
  const r1 = await del({ confirm: org });
  assert.equal(r1.status, 409);
  assert.match(r1.json.error, /먼저 중지/);
  assert.equal((await c.call('PATCH', `/api/admin/orgs/${orgB}`, { status: '중지' })).status, 200);
  assert.equal((await del({ confirm: '다른 이름' })).status, 400);
  assert.equal(await isLive(pool, 'org', orgB), true);
  assert.equal((await c.call('DELETE', `/api/admin/orgs/${orgEdu}`, { confirm: 'x' })).status, 404); // 상위 기관은 못 지움
  assert.equal((await c.call('DELETE', `/api/admin/orgs/${orgA}`, { confirm: 'x' })).status, 409); // 활성(A)

  const ok = await del({ confirm: org });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.accounts, 1);
  assert.equal(await isLive(pool, 'org', orgB), false);
  assert.equal(await isLive(pool, 'classroom', B.class), false);
  assert.equal(await isLive(pool, 'term', B.term), false);
  assert.equal(await isLive(pool, 'app_user', users.adminB.uid), false); // 단독 계정은 같이
  assert.equal(await isLive(pool, 'app_user', users.dual.uid), true); // 겸임 계정은 남김
  assert.equal(await isLive(pool, 'membership', users.dual.midB), false); // 이 기관 소속만 뗌
  assert.equal(await isLive(pool, 'membership', users.dual.mid), true);
  assert.equal(await isLive(pool, 'classroom', f.A.class), true); // 다른 기관은 그대로
  const logs = (await pool.query(`SELECT action FROM audit_log WHERE table_name = 'org' AND row_id = $1`, [orgB])).rows.map((r) => r.action);
  assert.ok(logs.includes('org.delete') && logs.includes('org.update')); // 기관 감사 기록은 지우지 않았다
  assert.ok(ACTION_LABEL['org.delete']);
  // 지운 기관은 목록에서 빠지고 이름을 다시 쓸 수 있다
  assert.ok(!(await c.call('GET', '/api/admin/orgs')).json.some((o) => o.id === String(orgB) || o.id === orgB));
  assert.equal((await c.call('POST', '/api/admin/orgs', { name: org, kind: '초' })).status, 201);
});

test('2 계정 삭제: 확인 글자 · 자기 자신 409 · 마지막 관리자 409(기관 이름) · 겸임 계정은 두 소속 다 지움', { skip }, async (t) => {
  const f = await setup(t);
  const { pool, users } = f;
  const c = await f.as('sys');
  const del = (u, confirm) => c.call('DELETE', `/api/admin/users/${u.uid}`, { confirm });

  assert.equal((await del(users.sys, users.sys.loginId)).status, 409); // 자기 자신
  const last = await del(users.adminA, users.adminA.loginId); // A 의 하나뿐인 관리자
  assert.equal(last.status, 409);
  assert.ok(last.json.error.includes(`${f.tag}-A`));
  assert.equal(await isLive(pool, 'app_user', users.adminA.uid), true);

  assert.equal((await del(users.staffA, '틀린 아이디')).status, 400);
  assert.equal((await del(users.staffA, users.staffA.loginId)).status, 200);
  assert.equal(await isLive(pool, 'app_user', users.staffA.uid), false);
  assert.equal(await isLive(pool, 'membership', users.staffA.mid), false);
  assert.equal((await del(users.staffA, users.staffA.loginId)).status, 404); // 이미 없음

  // 겸임 계정(B 관리자지만 B 에 다른 관리자가 있다): 계정과 두 소속 모두 지움
  assert.equal((await del(users.dual, users.dual.loginId)).status, 200);
  assert.equal(await isLive(pool, 'membership', users.dual.mid), false);
  assert.equal(await isLive(pool, 'membership', users.dual.midB), false);
  assert.equal(await isLive(pool, 'membership', users.adminB.mid), true); // 남의 소속은 그대로

  // 다른 시스템 관리자가 있으면 지울 수 있고, 그가 마지막이 되면 자기 자신 규칙이 막는다
  const sys2 = await one(pool, `INSERT INTO app_user (name, login_id, password_hash) SELECT 's2', $1, password_hash FROM app_user WHERE id = $2 RETURNING id`, [`${f.tag}-sys2`, users.sys.uid]);
  await pool.query(`INSERT INTO membership (org_id, user_id, role) VALUES ($1, $2, '시스템관리자')`, [f.orgEdu, sys2.id]);
  assert.equal((await del({ uid: sys2.id }, `${f.tag}-sys2`)).status, 200);
  const acts = (await pool.query(`SELECT action FROM audit_log WHERE action = 'admin.delete-user' AND user_id = $1`, [users.sys.uid])).rows;
  assert.equal(acts.length, 3);
  assert.ok(ACTION_LABEL['admin.delete-user']);
});

test('3 기관 관리자 떼기: 역할만 교직원으로 · 마지막 관리자 409 · 관리자 아니면 404', { skip }, async (t) => {
  const f = await setup(t);
  const { pool, orgB, users } = f;
  const c = await f.as('sys');
  const demote = (u) => c.call('POST', `/api/admin/orgs/${orgB}/admins/${u.uid}/demote`, {});

  assert.equal((await demote(users.dual)).status, 200); // B 관리자 둘(adminB·dual) 중 하나
  assert.equal((await one(pool, `SELECT role FROM membership WHERE id = $1`, [users.dual.midB])).role, '교직원');
  assert.equal(await isLive(pool, 'app_user', users.dual.uid), true);
  assert.equal(await isLive(pool, 'membership', users.dual.midB), true);
  const last = await demote(users.adminB);
  assert.equal(last.status, 409);
  assert.match(last.json.error, /마지막 관리자/);
  assert.equal((await demote(users.dual)).status, 404); // 이미 교직원
  assert.ok(ACTION_LABEL['admin.demote']);
  assert.equal((await one(pool, `SELECT count(*)::int AS n FROM audit_log WHERE action = 'admin.demote'`)).n >= 1, true);
});

test('4 권한: 기관 관리자·교직원은 세 동작 모두 거부', { skip }, async (t) => {
  const f = await setup(t);
  const { pool, orgB, users } = f;
  for (const who of ['adminA', 'staffA']) {
    const c = await f.as(who);
    for (const [m, p, b] of [
      ['GET', `/api/admin/orgs/${orgB}/delete-preview`], ['DELETE', `/api/admin/orgs/${orgB}`, { confirm: 'x' }],
      ['DELETE', `/api/admin/users/${users.staffA.uid}`, { confirm: users.staffA.loginId }], ['POST', `/api/admin/orgs/${orgB}/admins/${users.adminB.uid}/demote`, {}],
    ]) {
      const r = await c.call(m, p, b);
      assert.ok([403, 404].includes(r.status), `${who} ${m} ${p} → ${r.status}`); // 시스템 관리자 구역 전체가 404 로 숨는다
    }
  }
  assert.equal(await isLive(pool, 'app_user', users.staffA.uid), true);
  assert.equal(await isLive(pool, 'org', orgB), true);
});
