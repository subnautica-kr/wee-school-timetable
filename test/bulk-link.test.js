// T-1322b②-D 일괄 연결 — POST /roster/bulk-link · 줄마다 linked·pending·check · 엑셀 연결 계획의 group 칸
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupSchoolEnv, HAS_DB } from './fixtures/school-env.js';
import { MEMBER_STATUS } from '../shared/codes.js';
import { t } from '../shared/text/index.js';

const skip = !HAS_DB && 'DATABASE_URL 없음';

test('명단 일괄 연결: 셋으로 나눔 · 겸임 · 자동 승인 · 줄마다 따로', { skip }, async (tt) => {
  const env = await setupSchoolEnv(tt, 'bl');
  const { pool, orgId, tag, call, P } = env;
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0];
  const user = async (key, name, birth = null) => Number((await one(
    `INSERT INTO app_user (name, login_id, password_hash, must_change_password, birth_date) VALUES ($1,$2,'x',FALSE,$3) RETURNING id`, [name, `${tag}-${key}`, birth])).id);
  const line = async (name, birth = null) => (await call('POST', `${P}/roster`, { name, birthDate: birth })).json.id;
  const home = async (name, auto = false) => Number((await one(`INSERT INTO org (name, kind, config) VALUES ($1, '초', $2::jsonb) RETURNING id`, [`${tag}-${name}교`, JSON.stringify(auto ? { transferAutoApprove: true } : {})])).id);
  const kim = await user('kim', `${tag}김`);
  const park = await user('park', `${tag}박`);
  const conc = await user('conc', `${tag}겸`);
  const auto = await user('auto', `${tag}자`);
  await user('diff', `${tag}딴`);
  const o1 = await home('가'); const o2 = await home('나'); const o3 = await home('다', true);
  for (const [org, u, nm] of [[o1, park, `${tag}박`], [o2, conc, `${tag}겸`], [o3, auto, `${tag}자`]]) {
    await pool.query(`INSERT INTO membership (org_id, user_id, role, name, status) VALUES ($1,$2,'교직원',$3,$4)`, [org, u, nm, MEMBER_STATUS.ACTIVE]);
  }
  const lKim = await line(`${tag}김`); const lPark = await line(`${tag}박`); const lConc = await line(`${tag}겸`);
  const lAuto = await line(`${tag}자`); const lDiff = await line(`${tag}확인`);
  await line(`${tag}쌍`); await line(`${tag}쌍`);
  const userOf = async (mid) => (await one(`SELECT user_id FROM membership WHERE id = $1`, [mid])).user_id;
  const bulk = (rows, extra = {}) => call('POST', `${P}/roster/bulk-link`, { rows, ...extra });

  try {
  const r = await bulk([
    { membershipId: lKim, loginId: `${tag}-kim` },
    { name: `${tag}박`, loginId: `${tag}-park` },
    { membershipId: lDiff, loginId: `${tag}-diff` },
    { name: `${tag}없음`, loginId: `${tag}-kim` },
    { name: `${tag}쌍`, loginId: `${tag}-kim` },
    { membershipId: lKim, loginId: `${tag}-nobody` },
    { loginId: `${tag}-kim` },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await tt.test('줄마다 linked·pending·check 로 나뉜다', async () => {
    const g = r.json.results.map((x) => x.group);
    assert.deepEqual(g, ['linked', 'pending', 'check', 'check', 'check', 'check', 'check']);
    assert.deepEqual(r.json.results.slice(2).map((x) => x.code), ['name', 'line_not_found', 'line_ambiguous', 'account_not_found', 'bad_input']);
    assert.ok(r.json.results.every((x) => x.msg));
    assert.deepEqual(r.json.counts, { linked: 1, pending: 1, check: 5 });
    assert.equal(Number(await userOf(lKim)), kim);
    assert.equal(await userOf(lDiff), null);
  });
  await tt.test('승인 대기 줄은 전출 요청을 남기고 줄은 아직 안 잇는다', async () => {
    const p = r.json.results[1];
    assert.ok(p.requestId && p.expiresAt && p.msg === t('roster.bulk_link.pending'));
    assert.equal(await userOf(lPark), null);
    assert.equal((await one(`SELECT count(*)::int AS n FROM transfer_request WHERE user_id = $1 AND to_org = $2 AND status = 'waiting'`, [park, orgId])).n, 1);
    assert.ok(await one(`SELECT 1 FROM transfer_request WHERE id = $1 AND from_org = $2`, [p.requestId, o1]));
  });
  await tt.test('겸임 표시면 요청 없이 겸임으로 잇는다', async () => {
    const c = await bulk([{ membershipId: lConc, loginId: `${tag}-conc` }], { concurrent: true });
    assert.equal(c.json.results[0].group, 'linked');
    assert.equal(c.json.results[0].isConcurrent, true);
    assert.equal(Number(await userOf(lConc)), conc);
  });
  await tt.test('보내는 학교가 자동 승인이면 그 자리에서 연결', async () => {
    const a = await bulk([{ membershipId: lAuto, loginId: `${tag}-auto` }]);
    const x = a.json.results[0];
    assert.equal(x.group, 'linked'); assert.equal(x.autoApproved, true); assert.equal(Number(await userOf(lAuto)), auto);
  });
  await tt.test('같은 줄·같은 계정 되풀이는 확인 필요로 막고 거래는 줄마다 따로', async () => {
    const d = await bulk([{ membershipId: lKim, loginId: `${tag}-kim` }, { membershipId: lKim, loginId: `${tag}-park` }]);
    assert.deepEqual(d.json.results.map((x) => x.code), ['already_linked', 'line_taken']);
    const bad = await call('POST', `${P}/roster/bulk-link`, { rows: [] }, { expect: 400 });
    assert.equal(bad.status, 400);
  });
  await tt.test('감사 기록 한 줄', async () => {
    assert.ok(await one(`SELECT 1 FROM audit_log WHERE org_id = $1 AND action = 'roster.bulk-link'`, [orgId]));
  });
  } finally {
    await pool.query(`DELETE FROM notification WHERE org_id IN (SELECT id FROM org WHERE name LIKE $1)`, [`${tag}-%`]);
    await pool.query(`DELETE FROM transfer_request WHERE to_org IN (SELECT id FROM org WHERE name LIKE $1) OR from_org IN (SELECT id FROM org WHERE name LIKE $1)`, [`${tag}-%`]);
  }
});
