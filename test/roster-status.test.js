// T-1302a① 명단 서버 — 계정 없는 줄 넣기 · 재직 상태 넷(옛 hidden 도) · 여러 줄 한 번에 · 퇴직이면 해제 · 담임·수업 수와 소식 · 정렬
// 엑셀 명단 시트 아이디 열 · 다시 올리기 규칙 셋(빈 아이디는 연결 유지 · 셋 분류 · 되돌리기는 줄 값만)
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { setupSchoolEnv, HAS_DB } from './fixtures/school-env.js';
import { MEMBER_STATUS, ROLE } from '../shared/codes.js';
import { t } from '../shared/text/index.js';

const skip = !HAS_DB && 'DATABASE_URL 없음';

test('명단 서버: 계정 없는 줄 · 재직 상태 · 엑셀 아이디', { skip }, async (tt) => {
  const env = await setupSchoolEnv(tt, 'rs');
  const { pool, orgId, tag, call, P, adminMid } = env;
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0];
  const user = async (key, name, birth = null) => Number((await one(
    `INSERT INTO app_user (name, login_id, password_hash, must_change_password, birth_date) VALUES ($1,$2,'x',FALSE,$3) RETURNING id`, [name, `${tag}-${key}`, birth])).id);
  const term = Number((await one(`INSERT INTO term (org_id, year, semester) VALUES ($1, 2026, 2) RETURNING id`, [orgId])).id);

  try {
    let bare;
    await tt.test('계정 없는 줄 넣기 → 「계정 없음」 · 잠그기(걷은 길)·비밀번호 초기화 404', async () => {
      const r = await call('POST', `${P}/roster`, { name: '줄만', duty: '전담', birthDate: '1980-01-02' });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      assert.equal(r.json.loginId, null);
      assert.equal(r.json.temp, null);
      bare = r.json.id;
      const row = (await call('GET', `${P}/roster`)).json.find((x) => x.id == bare);
      assert.equal(row.state, t('roster.state.none'));
      assert.equal(row.hasAccount, false);
      assert.equal(row.birthDate, '1980-01-02');
      assert.equal((await call('POST', `${P}/roster/${bare}/lock`, {}, { expect: 404 })).status, 404);
      assert.equal((await call('POST', `${P}/roster/${bare}/reset-password`, {}, { expect: 404 })).status, 404);
      assert.equal((await call('POST', `${P}/roster`, { name: 'x', birthDate: '2001-02-30' }, { expect: 400 })).status, 400);
    });

    await tt.test('아이디를 주면 옛 길(계정 + 임시 비밀번호)', async () => {
      const r = await call('POST', `${P}/roster`, { name: '계정줄', loginId: `${tag}-acc` });
      assert.equal(r.status, 201);
      assert.ok(r.json.temp);
    });

    await tt.test('휴직: 맡은 담임·수업 수 + 학교 소식 한 줄 · 자료는 그대로', async () => {
      const cls = Number((await one(`INSERT INTO classroom (org_id, term_id, grade, class_no, homeroom_membership_id) VALUES ($1,$2,3,1,$3) RETURNING id`, [orgId, term, bare])).id);
      await pool.query(`INSERT INTO teaching_load (org_id, term_id, membership_id, classroom_id, weekly_hours) VALUES ($1,$2,$3,$4,2), ($1,$2,$3,$4,3)`, [orgId, term, bare, cls]);
      const r = await call('PATCH', `${P}/roster/${bare}`, { status: MEMBER_STATUS.LEAVE });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual([r.json.status.homeroom, r.json.status.classes, r.json.status.unlinked], [1, 2, false]);
      const n = await one(`SELECT text FROM notification WHERE id = $1 AND org_id = $2`, [r.json.status.notice, orgId]);
      assert.match(n.text, /담임 1건·수업 2건/);
      assert.equal(Number((await one(`SELECT homeroom_membership_id AS h FROM classroom WHERE id = $1`, [cls])).h), bare, '담당이 비었다 ≠ 자료 지움');
      // 재직으로 되돌리면 소식 없음
      const back = await call('PATCH', `${P}/roster/${bare}`, { status: MEMBER_STATUS.ACTIVE });
      assert.equal(back.json.status.notice, null);
    });

    let linked; let linkedUser;
    await tt.test('옛 hidden:true = 퇴직 → 공용 해제(계정 칸 비움 · 휴면 retired)', async () => {
      linkedUser = await user('ret', '퇴직샘');
      linked = Number((await one(`INSERT INTO membership (org_id, user_id, role, name) VALUES ($1,$2,'교직원','퇴직샘') RETURNING id`, [orgId, linkedUser])).id);
      const r = await call('PATCH', `${P}/roster/${linked}`, { hidden: true });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.status.unlinked, true);
      const m = await one(`SELECT status, user_id FROM membership WHERE id = $1`, [linked]);
      assert.deepEqual([m.status, m.user_id], [MEMBER_STATUS.RETIRED, null]);
      assert.equal((await one(`SELECT dormant_reason FROM app_user WHERE id = $1`, [linkedUser])).dormant_reason, 'retired');
    });

    await tt.test('내 줄 퇴직 409 · 마지막 기관 관리자 퇴직 409', async () => {
      const r = await call('PATCH', `${P}/roster/${adminMid}`, { status: MEMBER_STATUS.TRANSFERRED }, { expect: 409 });
      assert.equal(r.json.code, 'roster.err.self_status');
      const u2 = await user('adm2', '둘째관리');
      const m2 = Number((await one(`INSERT INTO membership (org_id, user_id, role, name, status) VALUES ($1,$2,$3,'둘째관리',$4) RETURNING id`, [orgId, u2, ROLE.ORG_ADMIN, MEMBER_STATUS.ACTIVE])).id);
      // 관리자 둘 → 하나 퇴직은 되고, 그다음 남은 하나(나)는 self 로 막힘. 남이 마지막이면 last_admin.
      await pool.query(`UPDATE membership SET role = $2 WHERE id = $1`, [adminMid, ROLE.STAFF]);
      const last = await call('PATCH', `${P}/roster/${m2}`, { status: MEMBER_STATUS.RETIRED }, { expect: 409 });
      await pool.query(`UPDATE membership SET role = $2 WHERE id = $1`, [adminMid, ROLE.ORG_ADMIN]);
      assert.equal(last.json.code, 'roster.err.last_admin');
      const ok = await call('PATCH', `${P}/roster/${m2}`, { status: MEMBER_STATUS.RETIRED });
      assert.equal(ok.status, 200);
    });

    await tt.test('여러 줄 한 번에 — 남의 줄은 그 줄만 실패 · 소식 한 줄', async () => {
      const a = (await call('POST', `${P}/roster`, { name: '몰림1' })).json.id;
      const b = (await call('POST', `${P}/roster`, { name: '몰림2' })).json.id;
      const cls = Number((await one(`INSERT INTO classroom (org_id, term_id, grade, class_no, homeroom_membership_id) VALUES ($1,$2,4,1,$3) RETURNING id`, [orgId, term, a])).id);
      await pool.query(`INSERT INTO teaching_load (org_id, term_id, membership_id, second_membership_id, classroom_id) VALUES ($1,$2,$3,$4,$5)`, [orgId, term, a, b, cls]);
      const r = await call('POST', `${P}/roster/status`, { ids: [a, b, 999999999], status: MEMBER_STATUS.TRANSFERRED });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual([r.json.changed, r.json.failed, r.json.homeroom, r.json.classes], [2, 1, 1, 2]);
      assert.equal(r.json.results[2].code, 'roster.err.line_not_found');
      assert.match((await one(`SELECT text FROM notification WHERE id = $1`, [r.json.notice])).text, /2명/);
      assert.equal((await call('POST', `${P}/roster/status`, { ids: [a], status: '없는상태' }, { expect: 400 })).status, 400);
    });

    await tt.test('정렬: 재직 → 휴직 → 전출 → 퇴직', async () => {
      const rows = (await call('GET', `${P}/roster`)).json;
      const order = [MEMBER_STATUS.ACTIVE, MEMBER_STATUS.LEAVE, MEMBER_STATUS.TRANSFERRED, MEMBER_STATUS.RETIRED];
      const idx = rows.map((x) => order.indexOf(x.listStatus));
      assert.deepEqual(idx, [...idx].sort((x, y) => x - y));
      assert.ok(idx.includes(2) && idx.includes(3));
    });

  } finally {
    await pool.query(`DELETE FROM notification WHERE org_id IN (SELECT id FROM org WHERE name LIKE $1)`, [`${tag}-%`]);
    await pool.query(`DELETE FROM transfer_request WHERE to_org IN (SELECT id FROM org WHERE name LIKE $1) OR from_org IN (SELECT id FROM org WHERE name LIKE $1)`, [`${tag}-%`]);
    await pool.query(`DELETE FROM unlinked_account WHERE org_id IN (SELECT id FROM org WHERE name LIKE $1)`, [`${tag}-%`]);
    await pool.query(`DELETE FROM invite_code WHERE org_id IN (SELECT id FROM org WHERE name LIKE $1)`, [`${tag}-%`]);
  }
});
