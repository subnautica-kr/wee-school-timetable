// T-1302b① 계정 연결 서버 — 「계정 연결」 세 갈래(아이디로 연결 · 계정 만들어 주기 · 초대 코드) · 단건도 경고 둘
// 연결 해제 → 「연결 안 된 계정」 묶음(목록 · 명단에 연결 · 학교에서 내보내기 · 30일 자동) · 줄 지우기도 해제 · 잠금 길 걷음
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupSchoolEnv, HAS_DB } from './fixtures/school-env.js';
import { runCleanups, DAY_MS } from '../server/cleanup.js';
import { INVITE_RE } from '../server/invite.js';
import { t } from '../shared/text/index.js';

const skip = !HAS_DB && 'DATABASE_URL 없음';

test('명단 계정 연결: 세 갈래 · 해제 · 묶음 · 30일 · 초대 코드', { skip }, async (tt) => {
  const env = await setupSchoolEnv(tt, 'rl');
  const { pool, orgId, tag, call, P } = env;
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0];
  const user = async (key, name, birth = null) => Number((await one(
    `INSERT INTO app_user (name, login_id, password_hash, must_change_password, birth_date) VALUES ($1,$2,'x',FALSE,$3) RETURNING id`,
    [name, `${tag}-${key}`, birth])).id);
  const line = async (name, birth = null) => (await call('POST', `${P}/roster`, { name, birthDate: birth })).json.id;
  const userIds = [];

  try {
    const kim = await user('kim', `${tag}김`, '1980-01-02'); userIds.push(kim);
    const lee = await user('lee', `${tag}이`, '1981-02-03'); userIds.push(lee);
    const leeTwin = await user('lee2', `${tag}이`, null); userIds.push(leeTwin); // 같은 이름 · 생년월일 모름 → 「같은 사람 계정이 또 있음」
    const lKim = await line(`${tag}김`, '1980-01-02');
    const lLee = await line(`${tag}이`, '1981-02-03');
    const lMiss = await line(`${tag}박`, '1990-05-05');

    await tt.test('갈래 ① 아이디로 연결 — 경고가 없으면 바로 연결', async () => {
      const r = await call('POST', `${P}/roster/${lKim}/link`, { loginId: `${tag}-kim` });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.userId, kim);
      assert.equal(r.json.loginId, `${tag}-kim`);
      const row = (await call('GET', `${P}/roster`)).json.find((x) => x.id == lKim);
      assert.equal(row.hasAccount, true);
      // 이미 연결된 줄에 또
      const again = await call('POST', `${P}/roster/${lKim}/link`, { loginId: `${tag}-lee` }, { expect: 409 });
      assert.equal(again.json.code, 'roster.err.line_taken');
    });

    await tt.test('갈래 ① 경고 둘 — 이름·생년월일 다름 / 같은 사람 계정이 또 있음 → 「그래도 연결」', async () => {
      const diff = await call('POST', `${P}/roster/${lMiss}/link`, { loginId: `${tag}-lee` }, { expect: 409 });
      assert.equal(diff.json.needConfirm, true);
      assert.deepEqual(diff.json.warnings.map((w) => w.code).sort(), ['birth', 'name']);
      const dup = await call('POST', `${P}/roster/${lLee}/link`, { loginId: `${tag}-lee` }, { expect: 409 });
      assert.equal(dup.json.needConfirm, true);
      const other = dup.json.warnings.find((w) => w.code === 'other');
      assert.ok(other, JSON.stringify(dup.json));
      assert.deepEqual(other.accounts.map((a) => a.loginId), [`${tag}-lee2`]);
      assert.equal(other.text, t('roster.link_warn.other', { 아이디: `${tag}-lee2` }));
      assert.equal((await one(`SELECT user_id FROM membership WHERE id = $1`, [lLee])).user_id, null); // 경고 단계에선 안 잇는다
      const ok = await call('POST', `${P}/roster/${lLee}/link`, { loginId: `${tag}-lee`, force: true });
      assert.equal(ok.status, 200);
      assert.equal(Number((await one(`SELECT user_id FROM membership WHERE id = $1`, [lLee])).user_id), lee);
      const none = await call('POST', `${P}/roster/${lMiss}/link`, { loginId: `${tag}-nobody` }, { expect: 404 });
      assert.equal(none.json.code, 'roster.err.account_not_found');
    });

    await tt.test('갈래 ② 계정 만들어 주기 — 임시 비밀번호 한 번 · 줄 이름·생년월일로 계정', async () => {
      const r = await call('POST', `${P}/roster/${lMiss}/account`, { loginId: `${tag}-park` });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      assert.ok(r.json.temp);
      userIds.push(r.json.userId);
      const u = await one(`SELECT name, to_char(birth_date,'YYYY-MM-DD') AS b, must_change_password FROM app_user WHERE id = $1`, [r.json.userId]);
      assert.equal(u.name, `${tag}박`);
      assert.equal(u.b, '1990-05-05');
      assert.equal(u.must_change_password, true);
      const dupId = await line(`${tag}최`);
      const taken = await call('POST', `${P}/roster/${dupId}/account`, { loginId: `${tag}-park` }, { expect: 409 });
      assert.equal(taken.json.code, 'roster.err.login_taken');
      assert.equal((await one(`SELECT user_id FROM membership WHERE id = $1`, [dupId])).user_id, null);
    });

    await tt.test('갈래 ③ 초대 코드 발급·재발급(앞 코드 무효) · 연결되면 무효 · 연결된 줄엔 못 냄', async () => {
      const lc = await line(`${tag}정`);
      const a = await call('POST', `${P}/roster/${lc}/invite`);
      assert.equal(a.status, 201, JSON.stringify(a.json));
      assert.match(a.json.code, INVITE_RE);
      assert.equal(a.json.first, true);
      const b = await call('POST', `${P}/roster/${lc}/invite`);
      assert.equal(b.json.first, false);
      assert.notEqual(a.json.code, b.json.code);
      const codes = (await pool.query(`SELECT code, revoked_at, used_at FROM invite_code WHERE membership_id = $1 ORDER BY id`, [lc])).rows;
      assert.equal(codes.length, 2);
      assert.ok(codes[0].revoked_at, '재발급하면 앞 코드는 무효');
      assert.equal(codes[1].revoked_at, null);
      const exp = await one(`SELECT expires_at - created_at AS d FROM invite_code WHERE code = $1`, [b.json.code]);
      assert.equal(exp.d.days, 7);
      // 연결(아이디로)되면 살아 있던 코드도 무효
      const jung = await user('jung', `${tag}정`); userIds.push(jung);
      assert.equal((await call('POST', `${P}/roster/${lc}/link`, { loginId: `${tag}-jung` })).status, 200);
      const live = await one(`SELECT count(*)::int AS n FROM invite_code WHERE membership_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [lc]);
      assert.equal(live.n, 0);
      const no = await call('POST', `${P}/roster/${lc}/invite`, undefined, { expect: 409 });
      assert.equal(no.json.code, 'roster.err.invite_linked');
    });

    await tt.test('연결 → 해제 → 묶음 → 명단에 연결(다시)', async () => {
      const d = await call('DELETE', `${P}/roster/${lKim}/link`);
      assert.equal(d.status, 200, JSON.stringify(d.json));
      assert.equal((await one(`SELECT user_id FROM membership WHERE id = $1`, [lKim])).user_id, null);
      const list = (await call('GET', `${P}/roster/unlinked`)).json;
      const it = list.find((x) => x.userId === kim);
      assert.ok(it, JSON.stringify(list));
      assert.equal(it.loginId, `${tag}-kim`);
      assert.equal(it.fromLineId, Number(lKim));
      assert.equal(it.fromLineName, `${tag}김`);
      const again = await call('DELETE', `${P}/roster/${lKim}/link`, undefined, { expect: 409 });
      assert.equal(again.json.code, 'roster.err.not_linked');
      // 묶음에서 명단에 연결 — 같은 줄로
      const r = await call('POST', `${P}/roster/unlinked/${kim}/link`, { membershipId: Number(lKim) });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(Number((await one(`SELECT user_id FROM membership WHERE id = $1`, [lKim])).user_id), kim);
      assert.equal((await call('GET', `${P}/roster/unlinked`)).json.some((x) => x.userId === kim), false, '연결되면 묶음 줄이 닫힌다');
      assert.equal((await call('POST', `${P}/roster/unlinked/${kim}/link`, { membershipId: Number(lKim) }, { expect: 404 })).status, 404);
    });

    await tt.test('내 줄은 해제 못 함', async () => {
      const r = await call('DELETE', `${P}/roster/${env.adminMid}/link`, undefined, { expect: 409 });
      assert.equal(r.json.code, 'roster.err.self_unlink');
    });

    await tt.test('학교에서 내보내기 — 다른 소속이 없으면 휴면', async () => {
      assert.equal((await call('DELETE', `${P}/roster/${lLee}/link`)).status, 200);
      const r = await call('POST', `${P}/roster/unlinked/${lee}/release`);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.dormant, true);
      assert.ok((await one(`SELECT dormant_at FROM app_user WHERE id = $1`, [lee])).dormant_at);
      assert.equal((await call('GET', `${P}/roster/unlinked`)).json.some((x) => x.userId === lee), false);
      // 내보낸 계정도 아이디로 다시 연결된다(휴면 풀림)
      assert.equal((await call('POST', `${P}/roster/${lLee}/link`, { loginId: `${tag}-lee`, force: true })).status, 200);
      assert.equal((await one(`SELECT dormant_at FROM app_user WHERE id = $1`, [lee])).dormant_at, null);
    });

    await tt.test('30일 자동 내보내기(now 를 옮긴다) + 학교 소식 한 줄', async () => {
      assert.equal((await call('DELETE', `${P}/roster/${lLee}/link`)).status, 200);
      const before = await runCleanups(pool, { now: new Date(Date.now() + 29 * DAY_MS) });
      assert.equal(before.find((x) => x.name === 'unlinked-30d').ok, true);
      assert.equal((await call('GET', `${P}/roster/unlinked`)).json.some((x) => x.userId === lee), true, '29일째는 그대로');
      const out = await runCleanups(pool, { now: new Date(Date.now() + 31 * DAY_MS) });
      const job = out.find((x) => x.name === 'unlinked-30d');
      assert.equal(job.ok, true, JSON.stringify(job));
      assert.ok(job.count >= 1);
      assert.equal((await call('GET', `${P}/roster/unlinked`)).json.some((x) => x.userId === lee), false);
      const news = await one(`SELECT text FROM notification WHERE org_id = $1 AND kind = 'roster_unlinked_released' ORDER BY id DESC LIMIT 1`, [orgId]);
      assert.equal(news.text, t('roster.notice_unlinked.released', { 이름: `${tag}이` }));
    });

    await tt.test('줄 지우기 — 연결된 줄이면 해제가 같이 되어 묶음에 선다', async () => {
      const r = await call('DELETE', `${P}/roster/${lKim}`);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.unlinked, true);
      assert.equal((await call('GET', `${P}/roster/unlinked`)).json.some((x) => x.userId === kim), true);
    });

    await tt.test('잠금·잠금 풂 길은 걷었다', async () => {
      assert.equal((await call('POST', `${P}/roster/${lMiss}/lock`, {}, { expect: 404 })).status, 404);
      assert.equal((await call('POST', `${P}/roster/${lMiss}/unlock`, {}, { expect: 404 })).status, 404);
    });

    assert.deepEqual(env.blocked, []);
  } finally {
    await pool.query(`DELETE FROM notification WHERE org_id = $1`, [orgId]);
    await pool.query(`DELETE FROM unlinked_account WHERE org_id = $1`, [orgId]);
    await pool.query(`DELETE FROM invite_code WHERE org_id = $1`, [orgId]);
  }
});
