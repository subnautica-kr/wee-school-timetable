// T-1320b 공용 함수 — 연결·해제(link.js) · 대조(match.js) · 알림 보내기(notify.js) · 정리 작업 틀(cleanup.js)
// 연결·해제의 갈래마다: 초대 코드 무효 · 묶음 줄 닫기 · 휴면 풀기 / 계정 칸 비움 · 권한 내림 · 세션 끊기 · 다른 소속 없으면 휴면
import test from 'node:test';
import assert from 'node:assert/strict';
import { HAS_DB, cleanupOrgs } from './sec-helpers.js';
import { ROLE, DORMANT_REASON, UNLINKED_REASON, INVITE_KIND } from '../shared/codes.js';
import { sameName, sameBirth, normBirth } from '../server/match.js';
import { registerCleanup, unregisterCleanup, runCleanups } from '../server/cleanup.js';

const skip = !HAS_DB && 'DB 없음 — 건너뜀';

test('대조: 이름은 빈칸 무시 · 생년월일은 한쪽이 비면 모름(null)', () => {
  assert.equal(sameName('홍 길동', '홍길동'), true);
  assert.equal(sameName('홍길동', '홍길순'), false);
  assert.equal(sameName('', ''), false);
  assert.equal(sameBirth('19800102', '1980-01-02'), true);
  assert.equal(sameBirth('1980-01-02', '1980-01-03'), false);
  assert.equal(sameBirth(null, '1980-01-02'), null);
  assert.equal(normBirth(new Date(1980, 0, 2)), '1980-01-02');
});

test('정리 작업 틀: 일 하나가 실패해도 나머지는 돈다', async () => {
  registerCleanup('t-ok', async () => 3);
  registerCleanup('t-bad', async () => { throw new Error('boom'); });
  try {
    const out = await runCleanups(null, { log: { error() {} } });
    const ok = out.find((r) => r.name === 't-ok');
    const bad = out.find((r) => r.name === 't-bad');
    assert.deepEqual(ok, { name: 't-ok', ok: true, count: 3 });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /boom/);
  } finally {
    unregisterCleanup('t-ok');
    unregisterCleanup('t-bad');
  }
});

test('연결·해제·대조·알림 — DB', { skip }, async (t) => {
  const { createPool } = await import('../server/db.js');
  const { migrate } = await import('../server/migrate.js');
  const { linkAccount, unlinkAccount } = await import('../server/link.js');
  const { matchPerson } = await import('../server/match.js');
  const { notify } = await import('../server/notify.js');
  const pool = createPool();
  await migrate(pool);
  const tag = `lk${Date.now()}${Math.floor(Math.random() * 1000)}`;
  // 뒷정리: 014 새 표(cleanupOrgs 가 모름)를 먼저 지우고 기관·계정은 공용 도우미로 — 계정 없는 줄이 시험 DB 에 남으면 덤프 시험이 깨진다
  t.after(async () => {
    const users = `SELECT id FROM app_user WHERE login_id LIKE '${tag}-%'`;
    const orgs = `SELECT id FROM org WHERE name LIKE '${tag}-%'`;
    await pool.query(`DELETE FROM notification_read WHERE user_id IN (${users})`);
    await pool.query(`DELETE FROM notification WHERE org_id IN (${orgs}) OR user_id IN (${users}) OR text = '${tag}'`);
    await pool.query(`DELETE FROM invite_code WHERE org_id IN (${orgs})`);
    await pool.query(`DELETE FROM unlinked_account WHERE org_id IN (${orgs}) OR user_id IN (${users})`);
    await pool.query(`DELETE FROM audit_log WHERE user_id IN (${users})`);
    await cleanupOrgs(pool, [], tag);
    await pool.end();
  });
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0];
  const id = async (sql, args) => Number((await one(sql, args)).id);
  const A = await id(`INSERT INTO org (name, kind) VALUES ($1,'초') RETURNING id`, [`${tag}-A`]);
  const B = await id(`INSERT INTO org (name, kind) VALUES ($1,'초') RETURNING id`, [`${tag}-B`]);
  const user = (name, birth = null) => id(
    `INSERT INTO app_user (name, login_id, password_hash, must_change_password, birth_date, signed_up_at) VALUES ($1,$2,'x',FALSE,$3, now()) RETURNING id`,
    [name, `${tag}-${name}-${Math.random()}`, birth],
  );
  const line = (orgId, name, role = ROLE.STAFF) => id(`INSERT INTO membership (org_id, name, role) VALUES ($1,$2,$3) RETURNING id`, [orgId, name, role]);
  const admin = await user(`${tag}관리`);
  const sess = async (uid, orgId) => {
    const sid = `${tag}-${Math.random()}`;
    await pool.query(`INSERT INTO session (sid, sess, expire) VALUES ($1,$2, now() + interval '1 day')`, [sid, JSON.stringify({ userId: uid, orgId })]);
    return sid;
  };
  const alive = async (sid) => !!(await one(`SELECT 1 AS x FROM session WHERE sid = $1`, [sid]));
  const u = async (uid) => one(`SELECT first_linked_at, dormant_at, dormant_reason FROM app_user WHERE id = $1`, [uid]);
  const m = async (mid) => one(`SELECT user_id, role, linked_at, linked_by, is_concurrent FROM membership WHERE id = $1`, [mid]);

  await t.test('연결: 계정 칸·연결 시각·처음 연결 시각 · 그 줄 초대 코드 무효 · 묶음 줄 닫기 · 휴면 풀기', async () => {
    const uid = await user(`${tag}가`, '1980-01-02');
    const mid = await line(A, `${tag}가`);
    const inv = await id(`INSERT INTO invite_code (org_id, membership_id, kind, code) VALUES ($1,$2,$3,$4) RETURNING id`, [A, mid, INVITE_KIND.MOVE_IN, `${tag}-c1`]);
    const ua = await id(`INSERT INTO unlinked_account (org_id, user_id, reason, membership_id, expires_at) VALUES ($1,$2,$3,$4, now() + interval '7 days') RETURNING id`, [A, uid, UNLINKED_REASON.PENDING_APPROVAL, mid]);
    await pool.query(`UPDATE app_user SET dormant_at = now(), dormant_reason = 'retired' WHERE id = $1`, [uid]);

    const r = await linkAccount(pool, { membershipId: mid, userId: uid, byUserId: admin });
    assert.deepEqual(r, { ok: true, membershipId: mid, userId: uid, isConcurrent: false });
    const row = await m(mid);
    assert.equal(Number(row.user_id), uid);
    assert.ok(row.linked_at);
    assert.equal(Number(row.linked_by), admin);
    const acc = await u(uid);
    assert.ok(acc.first_linked_at, '처음 연결 시각');
    assert.equal(acc.dormant_at, null, '휴면 풀림');
    assert.equal(acc.dormant_reason, null);
    assert.ok((await one(`SELECT revoked_at FROM invite_code WHERE id = $1`, [inv])).revoked_at, '초대 코드 무효');
    assert.ok((await one(`SELECT resolved_at FROM unlinked_account WHERE id = $1`, [ua])).resolved_at, '묶음 줄 닫힘');

    // 처음 연결 시각은 다시 연결해도 안 바뀐다
    const first = acc.first_linked_at.getTime();
    await unlinkAccount(pool, { membershipId: mid, byUserId: admin });
    await linkAccount(pool, { membershipId: mid, userId: uid, byUserId: admin });
    assert.equal((await u(uid)).first_linked_at.getTime(), first);
  });

  await t.test('연결 거절: 찬 줄 · 같은 학교 다른 줄에 이미 있음 · 지운 줄 · 없는 계정 — 바뀌는 것 없음', async () => {
    const uid = await user(`${tag}나`);
    const other = await user(`${tag}다`);
    const m1 = await line(A, `${tag}나`);
    const m2 = await line(A, `${tag}나2`);
    assert.ok((await linkAccount(pool, { membershipId: m1, userId: uid })).ok);
    assert.equal((await linkAccount(pool, { membershipId: m1, userId: uid })).error, 'roster.err.already_linked');
    assert.equal((await linkAccount(pool, { membershipId: m1, userId: other })).error, 'roster.err.line_taken');
    assert.equal((await linkAccount(pool, { membershipId: m2, userId: uid })).error, 'roster.err.account_in_org');
    assert.equal((await m(m2)).user_id, null);
    const del = await line(A, `${tag}지움`);
    await pool.query(`UPDATE membership SET deleted_at = now() WHERE id = $1`, [del]);
    assert.equal((await linkAccount(pool, { membershipId: del, userId: other })).error, 'roster.err.line_not_found');
    assert.equal((await linkAccount(pool, { membershipId: m2, userId: 0 })).error, 'roster.err.account_not_found');
  });

  await t.test('연결: 본 소속이 이미 있으면 겸임 줄로 선다(013 트리거)', async () => {
    const uid = await user(`${tag}겸`);
    assert.ok((await linkAccount(pool, { membershipId: await line(A, `${tag}겸`), userId: uid })).ok);
    const r = await linkAccount(pool, { membershipId: await line(B, `${tag}겸`), userId: uid });
    assert.equal(r.isConcurrent, true);
  });

  await t.test('해제: 계정 칸 비움 · 기관 관리자 → 교직원 · 세션 끊기 · 다른 소속 없으면 휴면(사유)', async () => {
    const uid = await user(`${tag}라`);
    const mid = await line(A, `${tag}라`, ROLE.ORG_ADMIN);
    await linkAccount(pool, { membershipId: mid, userId: uid });
    const inv = await id(`INSERT INTO invite_code (org_id, membership_id, kind, code) VALUES ($1,$2,$3,$4) RETURNING id`, [A, mid, INVITE_KIND.MOVE_IN, `${tag}-c2`]);
    const s1 = await sess(uid, A);
    const keep = await sess(admin, A);
    const r = await unlinkAccount(pool, { membershipId: mid, byUserId: admin, reason: DORMANT_REASON.RETIRED });
    assert.deepEqual(r, { ok: true, membershipId: mid, userId: uid, dormant: true });
    const row = await m(mid);
    assert.equal(row.user_id, null, '계정 칸 비움');
    assert.equal(row.role, ROLE.STAFF, '권한 교직원으로');
    assert.equal(await alive(s1), false, '그 계정 세션 끊김');
    assert.equal(await alive(keep), true, '다른 사람 세션은 그대로');
    const acc = await u(uid);
    assert.ok(acc.dormant_at, '휴면');
    assert.equal(acc.dormant_reason, DORMANT_REASON.RETIRED);
    assert.ok((await one(`SELECT revoked_at FROM invite_code WHERE id = $1`, [inv])).revoked_at, '떼어 낸 줄의 코드도 무효');
    assert.equal((await unlinkAccount(pool, { membershipId: mid })).error, 'roster.err.not_linked');
  });

  await t.test('해제: 다른 소속이 있으면 휴면 아님 · 보기만 권한은 그대로 · 묶음(연결 해제 30일)에 선다', async () => {
    const uid = await user(`${tag}마`);
    const mA = await line(A, `${tag}마`, ROLE.VIEWER);
    const mB = await line(B, `${tag}마`);
    await linkAccount(pool, { membershipId: mA, userId: uid });
    await linkAccount(pool, { membershipId: mB, userId: uid });
    const s1 = await sess(uid, B);
    const r = await unlinkAccount(pool, { membershipId: mA, byUserId: admin, listUnlinked: true });
    assert.equal(r.dormant, false);
    assert.equal((await m(mA)).role, ROLE.VIEWER);
    assert.equal((await u(uid)).dormant_at, null);
    assert.equal(await alive(s1), false, '세션은 다 끊는다(다시 로그인하면 남은 소속으로)');
    const ua = await one(`SELECT reason, membership_id, expires_at - created_at AS span FROM unlinked_account WHERE user_id = $1 AND resolved_at IS NULL`, [uid]);
    assert.equal(ua.reason, UNLINKED_REASON.UNLINKED);
    assert.equal(Number(ua.membership_id), mA);
    assert.equal(ua.span.days, 30);
    // 다시 연결되면 묶음 줄이 닫힌다
    await linkAccount(pool, { membershipId: mA, userId: uid });
    assert.equal((await one(`SELECT count(*)::int AS n FROM unlinked_account WHERE user_id = $1 AND resolved_at IS NULL`, [uid])).n, 0);
  });

  await t.test('대조: 줄 값과 계정 맞춰 보기 · 같은 이름 계정 찾기(생년월일이 다르면 뺌)', async () => {
    const nm = `${tag}바`;
    const u1 = await user(nm, '1990-05-06');
    const u2 = await user(nm, '1991-01-01');
    const u3 = await user(nm);
    const r = await matchPerson(pool, { name: `${tag} 바`, birthDate: '19900506', userId: u1 });
    assert.deepEqual(r.check, { userId: u1, name: true, birth: true });
    assert.deepEqual(r.candidates.map((c) => c.userId), [u1, u3]);
    assert.equal(r.candidates.find((c) => c.userId === u3).birth, null);
    assert.ok(!r.candidates.some((c) => c.userId === u2));
    assert.deepEqual((await matchPerson(pool, { name: '다른이름', userId: u2 })).check, { userId: u2, name: false, birth: null });
  });

  await t.test('알림 보내기: 학교 소식 · 개인 소식 · 총괄관리자', async () => {
    const a = await notify(pool, { orgId: A, kind: 'linked', text: 'x', link: '/roster' });
    const b = await notify(pool, { userId: admin, orgId: A, kind: 'joined', text: 'y' });
    const c = await notify(pool, { sysadmin: true, kind: 'board_new', text: tag });
    assert.deepEqual([a.audience, b.audience, c.audience], ['org_admins', 'user', 'sysadmin']);
    assert.deepEqual(await one(`SELECT org_id::int, user_id, link FROM notification WHERE id = $1`, [a.id]), { org_id: A, user_id: null, link: '/roster' });
    await assert.rejects(notify(pool, { kind: 'k', text: 't' }));
  });
});
