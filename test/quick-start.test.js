// 빠른 시작 — 빈 기관에 학급·교시틀·시안 한 번에 · 두 번째 409 · 교직원 403 · 교사 없이 과목만으로 칸 저장
import { test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';

const HAS_DB = !!process.env.DATABASE_URL;

test('빠른 시작 경로', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const { createPool } = await import('../server/db.js');
  const { migrate } = await import('../server/migrate.js');
  const { createApp } = await import('../server/app.js');
  const { cleanupOrgs } = await import('./sec-helpers.js');
  const pool = createPool();
  await migrate(pool);
  const tag = `f12${Date.now()}`;
  const hash = await argon2.hash('pw-test-1234');
  const org = (await pool.query(`INSERT INTO org (name, kind) VALUES ($1, '초') RETURNING id`, [`${tag}-O`])).rows[0].id;
  for (const [n, role] of [['adm', '기관관리자'], ['stf', '교직원']]) {
    const u = (await pool.query(`INSERT INTO app_user (name, login_id, password_hash, must_change_password) VALUES ($1,$2,$3,FALSE) RETURNING id`, [n, `${tag}-${n}`, hash])).rows[0].id;
    await pool.query(`INSERT INTO membership (org_id, user_id, role) VALUES ($1,$2,$3)`, [org, u, role]);
  }
  const app = createApp(pool, { testMode: true, cookieSecure: false, loginLimit: 1000, apiLimit: 10000 });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await cleanupOrgs(pool, [org, ...extra], tag); await pool.end(); });
  const extra = [];
  const mk = () => {
    const st = { cookie: '', csrf: '' };
    return async (method, path, body) => {
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: st.cookie, 'x-csrf-token': st.csrf }, body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.getSetCookie?.() ?? [];
      if (sc.length) st.cookie = sc.map((c) => c.split(';')[0]).join('; ');
      let json = null; try { json = await res.json(); } catch { /* 본문 없음 */ }
      if (json?.csrf) st.csrf = json.csrf;
      return { status: res.status, json };
    };
  };
  const login = async (n) => {
    const call = mk();
    await call('GET', '/api/auth/session');
    assert.equal((await call('POST', '/api/auth/login', { orgId: org, loginId: `${tag}-${n}`, password: 'pw-test-1234' })).status, 200);
    return call;
  };
  const adm = await login('adm');
  const stf = await login('stf');
  const P = `/api/orgs/${org}`;
  const body = { classes: { 1: 2, 2: 1 }, periods: { 1: 5, 2: 4 } };

  await t.test('교직원은 막힘(이 앱은 권한 없음을 404 로 숨김)', async () => assert.equal((await stf('POST', `${P}/quick-start`, body)).status, 404));
  let ttId;
  await t.test('빈 기관: 학급 3 · 교시틀 · 시안 1', async () => {
    assert.equal((await adm('POST', `${P}/quick-start`, { classes: { 1: 0 } })).status, 400);
    const r = await adm('POST', `${P}/quick-start`, body);
    assert.equal(r.status, 201);
    ttId = r.json.timetable.id;
    const d = (await adm('GET', `${P}/timetables/${ttId}`)).json;
    assert.equal(d.classrooms.length, 3);
    assert.equal(d.periods.grades[1].periods, 5);
    assert.equal(d.periods.grades[2].periods, 4);
    assert.ok(d.subjects.length > 0);
    assert.equal((await adm('GET', `${P}/timetables`)).json.length, 1);
    assert.equal((await pool.query(`SELECT 1 FROM audit_log WHERE org_id = $1 AND action = 'school.quick_start'`, [org])).rowCount, 1);
  });
  await t.test('두 번째는 409 · 아무것도 안 늘어남', async () => {
    assert.equal((await adm('POST', `${P}/quick-start`, body)).status, 409);
    assert.equal((await adm('GET', `${P}/timetables`)).json.length, 1);
  });
  await t.test('교사 없이 새 과목만으로 칸 저장', async () => {
    const s = await adm('POST', `${P}/subjects`, { name: '창체' });
    assert.equal(s.status, 201);
    const d = (await adm('GET', `${P}/timetables/${ttId}`)).json;
    const r = await adm('PUT', `${P}/timetables/${ttId}/cells`, { classroom_id: d.classrooms[0].id, weekday: 1, period: 1, subject_id: s.json.id, membership_id: null, special_room_id: null });
    assert.equal(r.status, 200);
    const d2 = (await adm('GET', `${P}/timetables/${ttId}`)).json;
    assert.equal(d2.cells.length, 1);
    assert.equal(d2.cells[0].membership_id, null);
  });
  // 학교 기본 교시 수가 이미 저장돼 있으면 그 값을 쓴다(상자 값·고정 기본값이 덮지 않음) · 없는 학년은 상자 값 → 기존 기본값
  const qsOrg = async (n, cfg) => {
    const o = (await pool.query(`INSERT INTO org (name, kind, period_config) VALUES ($1, '초', $2) RETURNING id`, [`${tag}-${n}`, JSON.stringify(cfg)])).rows[0].id;
    const u = (await pool.query(`INSERT INTO app_user (name, login_id, password_hash, must_change_password) VALUES ($1,$2,$3,FALSE) RETURNING id`, [n, `${tag}-${n}`, hash])).rows[0].id;
    await pool.query(`INSERT INTO membership (org_id, user_id, role) VALUES ($1,$2,'기관관리자')`, [o, u]);
    extra.push(o);
    const call = mk();
    await call('GET', '/api/auth/session');
    assert.equal((await call('POST', '/api/auth/login', { orgId: o, loginId: `${tag}-${n}`, password: 'pw-test-1234' })).status, 200);
    return { call, o };
  };
  await t.test('학교 기본 교시 수가 있으면 그 값을 쓴다(상자 값이 안 덮음)', async () => {
    const { call, o } = await qsOrg('qa', { grades: { 1: { periods: 4 } } });
    assert.equal((await call('POST', `/api/orgs/${o}/quick-start`, { classes: { 1: 1, 3: 1 }, periods: { 1: 6, 3: 5 } })).status, 201);
    const pc = (await pool.query(`SELECT period_config FROM org WHERE id = $1`, [o])).rows[0].period_config;
    assert.equal(pc.grades[1].periods, 4);
    assert.equal(pc.grades[3].periods, 5);
  });
  await t.test('학교 기본이 없고 상자 값도 없으면 기존 기본값(1·2학년 5, 그 위 6)', async () => {
    const { call, o } = await qsOrg('qb', {});
    assert.equal((await call('POST', `/api/orgs/${o}/quick-start`, { classes: { 1: 1, 4: 1 } })).status, 201);
    const pc = (await pool.query(`SELECT period_config FROM org WHERE id = $1`, [o])).rows[0].period_config;
    assert.equal(pc.grades[1].periods, 5);
    assert.equal(pc.grades[4].periods, 6);
  });
  // T-1305: 학교 기본에 반이 있으면 상자 값 없이 불러도 그 반·교시로 빈 시안이 선다 · 반이 없으면 400 · 상자 값이 있으면 기존대로 409
  await t.test('상자 값 없이 부르면 학교 기본의 반·교시로 빈 시안', async () => {
    const { call, o } = await qsOrg('qc', {});
    assert.equal((await call('POST', `/api/orgs/${o}/quick-start`, {})).status, 400); // 반도 상자도 없음
    assert.equal((await call('POST', `/api/orgs/${o}/classrooms/bulk`, { grade: 1, count: 2 })).status < 300, true);
    await pool.query(`UPDATE org SET period_config = $2 WHERE id = $1`, [o, JSON.stringify({ grades: { 1: { periods: 4 } } })]);
    const r = await call('POST', `/api/orgs/${o}/quick-start`, {});
    assert.equal(r.status, 201);
    const d = (await call('GET', `/api/orgs/${o}/timetables/${r.json.timetable.id}`)).json;
    assert.equal(d.classrooms.length, 2);
    assert.equal(d.periods.grades[1].periods, 4);
    assert.equal((await call('POST', `/api/orgs/${o}/quick-start`, { classes: { 1: 1 } })).status, 409); // 상자 값이 있으면 막힘
  });
});
