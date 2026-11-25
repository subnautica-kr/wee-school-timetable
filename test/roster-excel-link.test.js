// T-1302a① 엑셀 명단 아이디 열 — 연결됨·승인 대기·확인 필요·계정 없음 · 빈 아이디는 연결 유지 · 되돌리기는 줄 값만
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkbook, rosterSpec } from '../server/export/import.js';
import { setupSchoolEnv, HAS_DB } from './fixtures/school-env.js';
import { MEMBER_STATUS } from '../shared/codes.js';

const skip = !HAS_DB && 'DATABASE_URL 없음';
const sheet = (rows) => makeWorkbook([rosterSpec], { roster: rows.map((r) => ({ id: r.id ?? '', text: { name: r.name, duty: '', birth: '', loginId: r.loginId ?? '' } })) });

test('명단 엑셀 아이디 열: 네 갈래 · 빈 칸 유지 · 되돌리기', { skip }, async (tt) => {
  const env = await setupSchoolEnv(tt, 'rx');
  const { pool, orgId, tag, call, P } = env;
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0];
  const user = async (key, name) => Number((await one(
    `INSERT INTO app_user (name, login_id, password_hash, must_change_password) VALUES ($1,$2,'x',FALSE) RETURNING id`, [name, `${tag}-${key}`])).id);
  const other = Number((await one(`INSERT INTO org (name, kind) VALUES ($1, '초') RETURNING id`, [`${tag}-타교`])).id);
  const uLink = await user('ok', '연결샘');
  const uPend = await user('pend', '대기샘');
  await user('chk', '딴사람');
  await pool.query(`INSERT INTO membership (org_id, user_id, role, name, status) VALUES ($1,$2,'교직원','대기샘',$3)`, [other, uPend, MEMBER_STATUS.ACTIVE]);
  const mid = async (name) => (await one(`SELECT id, user_id FROM membership WHERE org_id = $1 AND name = $2 AND deleted_at IS NULL`, [orgId, name]));

  try {
    const rows = [
      { name: '연결샘', loginId: `${tag}-ok` },
      { name: '대기샘', loginId: `${tag}-pend` },
      { name: '확인샘', loginId: `${tag}-chk` },
      { name: '없음샘', loginId: `${tag}-nobody` },
    ];
    const buf = await sheet(rows);
    let batchId;
    await tt.test('미리 보기 → 네 갈래(linked·pending·check·missing) · 아무것도 안 씀', async () => {
      const pv = await call('POST', `${P}/roster/excel/preview`, buf);
      assert.equal(pv.status, 200, JSON.stringify(pv.json));
      assert.deepEqual(pv.json.links.map((l) => l.kind), ['linked', 'pending', 'check', 'missing']);
      assert.ok(pv.json.links.every((l) => l.msg && l.userId === undefined));
      assert.deepEqual(pv.json.links.map((l) => l.group), ['linked', 'pending', 'check', 'check']); // 일괄 연결과 같은 셋(계정 없음은 확인 필요)
      assert.equal((await one(`SELECT count(*)::int AS n FROM membership WHERE org_id = $1 AND name = '연결샘'`, [orgId])).n, 0);
    });

    await tt.test('반영 → 연결됨만 계정이 붙고 · 대기는 전출 요청 · 나머지는 줄만', async () => {
      const ap = await call('POST', `${P}/roster/excel/apply`, buf);
      assert.equal(ap.status, 200, JSON.stringify(ap.json));
      batchId = ap.json.batchId;
      assert.deepEqual(ap.json.links.map((l) => [l.kind, l.done]), [['linked', true], ['pending', true], ['check', false], ['missing', false]]);
      assert.equal(Number((await mid('연결샘')).user_id), uLink);
      for (const n of ['대기샘', '확인샘', '없음샘']) assert.equal((await mid(n)).user_id, null, n);
      assert.equal((await one(`SELECT count(*)::int AS n FROM transfer_request WHERE user_id = $1 AND to_org = $2`, [uPend, orgId])).n, 1);
    });

    await tt.test('아이디 칸을 비워 다시 올려도 연결 유지 · 연결 계획 없음', async () => {
      const m = await mid('연결샘');
      const again = await sheet([{ id: m.id, name: '연결샘', loginId: '' }]);
      const pv = await call('POST', `${P}/roster/excel/preview`, again);
      assert.deepEqual(pv.json.links, []);
      const ap = await call('POST', `${P}/roster/excel/apply`, again);
      assert.equal(ap.status, 200);
      assert.equal(Number((await mid('연결샘')).user_id), uLink);
    });

    await tt.test('되돌리기는 줄 값만 — 계정 붙은 새 줄은 지우지 않고 skipped(linked)', async () => {
      const keep = await mid('연결샘');
      const un = await call('POST', `${P}/roster/excel/undo`, { batchId });
      assert.equal(un.status, 200, JSON.stringify(un.json));
      assert.deepEqual(un.json.skipped.filter((s) => s.linked).map((s) => s.rowId), [Number(keep.id)]);
      assert.equal(Number((await mid('연결샘')).user_id), uLink, '연결 줄 그대로');
      for (const n of ['대기샘', '확인샘', '없음샘']) assert.equal(await mid(n), undefined, `${n} 줄은 지워짐`);
    });
  } finally {
    await pool.query(`DELETE FROM notification WHERE org_id IN (SELECT id FROM org WHERE name LIKE $1)`, [`${tag}-%`]);
    await pool.query(`DELETE FROM transfer_request WHERE to_org IN (SELECT id FROM org WHERE name LIKE $1) OR from_org IN (SELECT id FROM org WHERE name LIKE $1)`, [`${tag}-%`]);
  }
});
