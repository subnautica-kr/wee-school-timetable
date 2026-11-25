// T-1323 알림(종) — 받는 사람 표 · 사람별 읽음 · 90일 정리 · 할 일 건수 · 남의 것 404
import test from 'node:test';
import assert from 'node:assert/strict';
import { HAS_DB, setup } from './sec-helpers.js';
import { notify } from '../server/notify.js';
import { runCleanups, cleanupNames } from '../server/cleanup.js';

test('90일 정리가 정리 틀에 등록돼 있다', () => {
  assert.ok(cleanupNames().includes('notification-90d'));
});

test('알림 길목 — DB', { skip: !HAS_DB && 'DB 없음' }, async (t) => {
  const f = await setup(t);
  const { pool, tag, users: u } = f;
  const made = [];
  const sent = async (o) => { const r = await notify(pool, { kind: 't1323', ...o }); made.push(r.id); return r.id; };
  try {
    const toA = await sent({ orgId: f.orgA, text: `${tag}-A학교` });
    const toB = await sent({ orgId: f.orgB, text: `${tag}-B학교` });
    const toStaff = await sent({ userId: u.staffA.uid, orgId: f.orgA, text: `${tag}-staff개인` });
    const toSys = await sent({ sysadmin: true, text: `${tag}-총괄` });
    const ids = async (c) => (await c.call('GET', '/api/notifications')).json.items.filter((x) => x.kind === 't1323').map((x) => x.id).sort((a, b) => a - b);

    await t.test('받는 사람 표: 각자 자기 것만 보인다', async () => {
      const un = f.client();
      assert.equal((await un.call('GET', '/api/notifications')).status, 401, '로그인 안 하면 앱 가드대로');
      const adminA = f.client(); await adminA.login('adminA');
      const staffA = f.client(); await staffA.login('staffA');
      const adminB = f.client(); await adminB.login('adminB');
      const sys = f.client(); await sys.login('sys');
      assert.deepEqual(await ids(adminA), [toA], '학교 관리자는 우리 학교 소식');
      assert.deepEqual(await ids(adminB), [toB]);
      assert.deepEqual(await ids(staffA), [toStaff], '교직원은 학교 소식을 못 보고 개인 소식만');
      assert.deepEqual(await ids(sys), [toSys], '총괄관리자는 총괄 소식만');
      const dual = f.client(); await dual.login('dual', f.orgA);
      assert.deepEqual(await ids(dual), [toB], '겸임: A 에선 교직원이지만 B 관리자라 B 학교 소식이 온다');
    });

    await t.test('사람별 읽음: 한 사람이 읽어도 다른 관리자는 그대로 · 모두 읽음', async () => {
      const second = await pool.query(`INSERT INTO app_user (name, login_id, password_hash, must_change_password) VALUES ($1,$2,'x',FALSE) RETURNING id`, [`${tag}-2관리`, `${tag}-admin2`]);
      const uid2 = Number(second.rows[0].id);
      await pool.query(`INSERT INTO membership (org_id, user_id, role) VALUES ($1,$2,'기관관리자')`, [f.orgA, uid2]);
      try {
        const a1 = f.client(); await a1.login('adminA');
        const before = (await a1.call('GET', '/api/notifications')).json;
        assert.equal(before.items.find((x) => x.id === toA).read, false);
        assert.equal((await a1.call('POST', '/api/notifications/read', { ids: [toA] })).status, 200);
        const after = (await a1.call('GET', '/api/notifications')).json;
        assert.equal(after.items.find((x) => x.id === toA).read, true);
        assert.equal(after.unread, before.unread - 1);
        const rows = (await pool.query(`SELECT user_id FROM notification_read WHERE notification_id = $1`, [toA])).rows.map((x) => Number(x.user_id));
        assert.deepEqual(rows, [u.adminA.uid], '둘째 관리자의 읽음 표는 따로다');
        assert.equal((await a1.call('POST', '/api/notifications/read', { ids: [toA] })).status, 200, '같은 것을 또 읽어도 괜찮다');
        await sent({ orgId: f.orgA, text: `${tag}-A학교2` });
        assert.equal((await a1.call('POST', '/api/notifications/read', { all: true })).status, 200);
        assert.equal((await a1.call('GET', '/api/notifications')).json.unread, 0);
        const reads2 = (await pool.query(`SELECT count(*)::int AS n FROM notification_read WHERE user_id = $1`, [uid2])).rows[0].n;
        assert.equal(reads2, 0, '모두 읽음도 내 표에만');
      } finally {
        await pool.query(`DELETE FROM notification_read WHERE user_id = $1`, [uid2]);
        await pool.query(`DELETE FROM membership WHERE user_id = $1`, [uid2]);
        await pool.query(`DELETE FROM app_user WHERE id = $1`, [uid2]);
      }
    });

    await t.test('권한 없는 읽음: 남의 소식 id 는 404 · 읽음 표가 안 생긴다 · 엉뚱한 본문은 400', async () => {
      const adminA = f.client(); await adminA.login('adminA');
      for (const bad of [toB, toSys, toStaff]) {
        assert.equal((await adminA.call('POST', '/api/notifications/read', { ids: [bad] })).status, 404, `id ${bad}`);
      }
      assert.equal((await adminA.call('POST', '/api/notifications/read', { ids: [toA, toB] })).status, 404, '하나라도 남의 것이면 전부 거절');
      const n = (await pool.query(`SELECT count(*)::int AS n FROM notification_read WHERE notification_id = ANY($1::bigint[]) AND user_id = $2`, [[toB, toSys, toStaff], u.adminA.uid])).rows[0].n;
      assert.equal(n, 0);
      assert.equal((await adminA.call('POST', '/api/notifications/read', { ids: [] })).status, 400);
    });

    await t.test('할 일: 가입 승인 대기·전출 요청은 건수로 · 처리하면 사라진다 · 다른 학교·교직원은 안 보임', async () => {
      const ux = Number((await pool.query(`INSERT INTO app_user (name, login_id, password_hash, must_change_password) VALUES ($1,$2,'x',FALSE) RETURNING id`, [`${tag}-대기`, `${tag}-wait`])).rows[0].id);
      const ua = Number((await pool.query(`INSERT INTO unlinked_account (org_id, user_id, reason, expires_at) VALUES ($1,$2,'pending_approval', now() + interval '7 days') RETURNING id`, [f.orgA, ux])).rows[0].id);
      const tr = Number((await pool.query(`INSERT INTO transfer_request (from_org, to_org, user_id) VALUES ($1,$2,$3) RETURNING id`, [f.orgA, f.orgB, ux])).rows[0].id);
      try {
        const a = f.client(); await a.login('adminA');
        const d = (await a.call('GET', '/api/notifications')).json;
        assert.deepEqual(d.todos.map((x) => [x.kind, x.count]), [['signup', 1], ['transfer', 1]]);
        assert.match(d.todos[0].text, /1건/);
        assert.equal(d.badge, d.unread + 2);
        const b = f.client(); await b.login('adminB');
        assert.deepEqual((await b.call('GET', '/api/notifications')).json.todos, []);
        const s = f.client(); await s.login('staffA');
        assert.deepEqual((await s.call('GET', '/api/notifications')).json.todos, []);
        await pool.query(`UPDATE unlinked_account SET resolved_at = now() WHERE id = $1`, [ua]);
        await pool.query(`UPDATE transfer_request SET status = 'approved', decided_at = now() WHERE id = $1`, [tr]);
        assert.deepEqual((await a.call('GET', '/api/notifications')).json.todos, [], '처리되면 사라짐');
      } finally {
        await pool.query(`DELETE FROM transfer_request WHERE id = $1`, [tr]);
        await pool.query(`DELETE FROM unlinked_account WHERE id = $1`, [ua]);
        await pool.query(`DELETE FROM app_user WHERE id = $1`, [ux]);
      }
    });

    await t.test('90일 정리: 90일 지난 소식만 지우고 읽음 표도 같이 간다 (now 로 시계를 옮긴다)', async () => {
      const old = await sent({ orgId: f.orgA, text: `${tag}-옛` });
      await pool.query(`UPDATE notification SET created_at = now() - interval '91 days' WHERE id = $1`, [old]);
      const edge = await sent({ orgId: f.orgA, text: `${tag}-경계` });
      await pool.query(`UPDATE notification SET created_at = now() - interval '89 days' WHERE id = $1`, [edge]);
      await pool.query(`INSERT INTO notification_read (notification_id, user_id) VALUES ($1,$2)`, [old, u.adminA.uid]);
      const a = f.client(); await a.login('adminA');
      assert.ok(!(await ids(a)).includes(old), '91일 된 것은 읽을 때도 이미 안 보인다');
      const alive = async (id) => !!(await pool.query(`SELECT 1 FROM notification WHERE id = $1`, [id])).rows[0];
      const r1 = await runCleanups(pool, { now: new Date() });
      assert.equal(r1.find((x) => x.name === 'notification-90d').ok, true);
      assert.equal(await alive(old), false);
      assert.equal(await alive(edge), true, '89일 된 것은 남는다');
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM notification_read WHERE notification_id = $1`, [old])).rows[0].n, 0, '읽음 표도 같이');
      const r2 = await runCleanups(pool, { now: new Date(Date.now() + 2 * 24 * 3600 * 1000) });
      assert.ok(r2.find((x) => x.name === 'notification-90d').count >= 1);
      assert.equal(await alive(edge), false, '시계를 이틀 옮기니 91일째라 지워진다');
    });
  } finally {
    await pool.query(`DELETE FROM notification WHERE id = ANY($1::bigint[]) OR text LIKE $2`, [made, `${tag}-%`]);
  }
});
