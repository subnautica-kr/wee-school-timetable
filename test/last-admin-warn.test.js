// T-1322b②b 마지막 기관 관리자 — 막지 않고 「경고 뒤 허용」(409 needConfirm → force 로 진행). 명단 네 길 + 세는 규칙. DB 필요.
// 관리자로 세는 줄 = 계정이 연결된 재직·휴직 기관 관리자. 총괄·나가기 길은 delete-admin · leave-org 시험이 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupSchoolEnv, HAS_DB } from './fixtures/school-env.js';
import { MEMBER_STATUS, ROLE } from '../shared/codes.js';

const skip = !HAS_DB && 'DATABASE_URL 없음';

test('마지막 기관 관리자: 명단 길(권한 내림·재직 바꾸기·한꺼번에·지우기·연결 해제)은 경고 뒤 force 로 된다', { skip }, async (tt) => {
  const env = await setupSchoolEnv(tt, 'la');
  const { pool, orgId, tag, call, P, adminMid } = env;
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0];
  let n = 0;
  // 계정이 연결된 관리자 줄 하나 더
  const mkAdmin = async (status = MEMBER_STATUS.ACTIVE) => {
    const uid = Number((await one(`INSERT INTO app_user (name, login_id, password_hash, must_change_password) VALUES ($1,$2,'x',FALSE) RETURNING id`, [`관리${++n}`, `${tag}-la${n}`])).id);
    return Number((await one(`INSERT INTO membership (org_id, user_id, role, name, status) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [orgId, uid, ROLE.ORG_ADMIN, `관리${n}`, status])).id);
  };
  // 호출하는 나(adminMid)를 잠시 교직원으로 내려 「남이 마지막」 꼴을 만든다(roster-status 시험과 같은 수)
  const asStaff = async (fn) => {
    await pool.query(`UPDATE membership SET role = $2 WHERE id = $1`, [adminMid, ROLE.STAFF]);
    try { return await fn(); } finally { await pool.query(`UPDATE membership SET role = $2 WHERE id = $1`, [adminMid, ROLE.ORG_ADMIN]); }
  };
  const warned = (r) => { assert.equal(r.status, 409, JSON.stringify(r.json)); assert.equal(r.json.code, 'roster.err.last_admin_warn'); assert.equal(r.json.needConfirm, true); assert.equal(r.json.lastAdmin, true); assert.ok(r.json.warnings[0].text); };
  // 계정 없는 관리자 줄은 안 센다 — 이 줄이 있어도 아래는 전부 「마지막」이다
  await pool.query(`INSERT INTO membership (org_id, role, name) VALUES ($1,$2,'빈관리줄')`, [orgId, ROLE.ORG_ADMIN]);

  await tt.test('권한 내림', async () => {
    const m = await mkAdmin();
    await asStaff(async () => {
      warned(await call('PATCH', `${P}/roster/${m}`, { role: ROLE.STAFF }, { expect: 409 }));
      assert.equal((await one(`SELECT role FROM membership WHERE id = $1`, [m])).role, ROLE.ORG_ADMIN);
      assert.equal((await call('PATCH', `${P}/roster/${m}`, { role: ROLE.STAFF, force: true })).status, 200);
      assert.equal((await one(`SELECT role FROM membership WHERE id = $1`, [m])).role, ROLE.STAFF);
    });
  });

  await tt.test('재직 상태 바꾸기(퇴직)', async () => {
    const m = await mkAdmin();
    await asStaff(async () => {
      warned(await call('PATCH', `${P}/roster/${m}`, { status: MEMBER_STATUS.RETIRED }, { expect: 409 }));
      assert.equal((await one(`SELECT status FROM membership WHERE id = $1`, [m])).status, MEMBER_STATUS.ACTIVE);
      assert.equal((await call('PATCH', `${P}/roster/${m}`, { status: MEMBER_STATUS.RETIRED, force: true })).status, 200);
      assert.equal((await one(`SELECT status FROM membership WHERE id = $1`, [m])).status, MEMBER_STATUS.RETIRED);
    });
  });

  await tt.test('여러 줄 한 번에 — 줄마다 경고 · force 면 진행', async () => {
    const m = await mkAdmin();
    await asStaff(async () => {
      const w = await call('POST', `${P}/roster/status`, { ids: [m], status: MEMBER_STATUS.TRANSFERRED });
      assert.equal(w.status, 200);
      assert.deepEqual([w.json.changed, w.json.failed, w.json.results[0].code, w.json.results[0].needConfirm], [0, 1, 'roster.err.last_admin_warn', true]);
      const ok = await call('POST', `${P}/roster/status`, { ids: [m], status: MEMBER_STATUS.TRANSFERRED, force: true });
      assert.deepEqual([ok.json.changed, ok.json.failed], [1, 0]);
    });
  });

  await tt.test('지우기 · 연결 해제', async () => {
    const m = await mkAdmin();
    await asStaff(async () => {
      warned(await call('DELETE', `${P}/roster/${m}/link`, undefined, { expect: 409 }));
      assert.ok((await one(`SELECT user_id FROM membership WHERE id = $1`, [m])).user_id);
      assert.equal((await call('DELETE', `${P}/roster/${m}/link?force=1`)).status, 200);
      const m2 = await mkAdmin();
      warned(await call('DELETE', `${P}/roster/${m2}`, undefined, { expect: 409 }));
      assert.equal((await call('DELETE', `${P}/roster/${m2}`, { force: true })).status, 200);
      assert.equal((await one(`SELECT deleted_at FROM membership WHERE id = $1`, [m2])).deleted_at !== null, true);
    });
  });

  await tt.test('다른 재직·휴직 관리자가 하나라도 있으면 경고 없이 된다(휴직도 센다)', async () => {
    const a = await mkAdmin();
    await mkAdmin(MEMBER_STATUS.LEAVE);
    await asStaff(async () => {
      assert.equal((await call('PATCH', `${P}/roster/${a}`, { role: ROLE.STAFF })).status, 200);
    });
  });
});
