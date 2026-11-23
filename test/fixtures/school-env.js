// 가짜 학교 시험 공용 틀 — 기관 하나(초) + 관리자를 만들고 앱을 띄운다. 끝나면 tag 접두사 자료만 지운다.
// sec-helpers.js 의 setup 은 「상위 기관」 기관까지 만들어서, DB 의 org.kind 제약이 옛 값('교육청')인 곳에선 못 쓴다 — 여기선 '초' 기관만 만든다.
import argon2 from 'argon2';
import { cleanupOrgs } from '../sec-helpers.js';
import { fixturePassword } from './schools.js';

export const HAS_DB = !!(process.env.DATABASE_URL || process.env.DATABASE_URL_FILE);

export async function setupSchoolEnv(t, label = 'sch') {
  const { createPool } = await import('../../server/db.js');
  const { migrate } = await import('../../server/migrate.js');
  const { createApp } = await import('../../server/app.js');
  const pool = createPool();
  await migrate(pool);
  const tag = `${label}${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const hash = await argon2.hash(fixturePassword);
  const orgId = (await pool.query(`INSERT INTO org (name, kind) VALUES ($1, '초') RETURNING id`, [`${tag}-학교`])).rows[0].id;
  const uid = (await pool.query(`INSERT INTO app_user (name, login_id, password_hash, must_change_password) VALUES ('가관리자', $1, $2, FALSE) RETURNING id`, [`${tag}-adm`, hash])).rows[0].id;
  const adminMid = Number((await pool.query(`INSERT INTO membership (org_id, user_id, role) VALUES ($1,$2,'기관관리자') RETURNING id`, [orgId, uid])).rows[0].id);
  const app = createApp(pool, { testMode: true, cookieSecure: false, loginLimit: 1000, apiLimit: 100000 });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.close();
    await cleanupOrgs(pool, [orgId], tag);
    await pool.end();
  });
  // 쿠키·CSRF 를 들고 다니는 호출기. 4xx/5xx 는 blocked 에 쌓는다(한 바퀴 시험이 「막힘 0」을 센다). 일부러 보는 거절은 expect 로 뺀다.
  const blocked = [];
  let cookie = ''; let csrf = '';
  const call = async (method, path, body, { expect } = {}) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.getSetCookie?.() ?? [];
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const json = await res.json().catch(() => null);
    if (json?.csrf) csrf = json.csrf;
    if (res.status >= 400 && res.status !== expect) blocked.push(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
    return { status: res.status, json };
  };
  await call('GET', '/api/auth/session');
  const login = await call('POST', '/api/auth/login', { orgId, loginId: `${tag}-adm`, password: fixturePassword });
  if (login.status !== 200) throw new Error(`관리자 로그인 실패 ${login.status}`);
  return { pool, tag, orgId, adminMid, call, blocked, P: `/api/orgs/${orgId}` };
}
