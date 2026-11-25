// 줄 독립 읽기(T-1320a②) 지키는 시험 — 사람 이름은 줄 이름(membership.name)에서 읽는다.
// ① 정적: 명단 줄을 읽는 SQL 에서 계정 표(app_user) 별칭의 name 을 0건 · 이전 도구는 줄 이름을 먼저 본다
// ② DB: 계정 없는 줄 하나를 심고 그 줄이 길목마다 이름째 나오는지 본다(안쪽 조인으로 돌아가면 빠진다)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { HAS_DB, setup } from './sec-helpers.js';

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));

// 명단 줄(membership)과 계정(app_user)을 함께 읽는 SQL 에서 계정 별칭의 name 을 찾는다
export function accountNameHits(src) {
  const hits = [];
  for (const m of src.matchAll(/`[^`]*`/g)) {
    const sql = m[0];
    if (!/\bmembership\b/.test(sql)) continue;
    for (const a of sql.matchAll(/\bapp_user\s+(?:AS\s+)?([a-z_][a-z0-9_]*)\b/gi)) {
      if (/^(WHERE|ON|SET|JOIN|LEFT|INNER)$/i.test(a[1])) continue;
      if (new RegExp(`\\b${a[1]}\\.name\\b`).test(sql)) hits.push(sql.slice(0, 80).replace(/\s+/g, ' '));
    }
  }
  return hits;
}

test('정적: 명단 줄을 읽는 SQL 은 계정 이름(app_user 별칭.name)을 안 읽는다 — 로그인만 빼고', () => {
  // 검사기 검산: 옛 꼴은 잡고 새 꼴은 놓아준다
  assert.equal(accountNameHits('q(`SELECT m.id, u.name FROM membership m JOIN app_user u ON u.id = m.user_id`)').length, 1);
  assert.equal(accountNameHits('q(`SELECT m.id, m.name, u.login_id FROM membership m LEFT JOIN app_user u ON u.id = m.user_id`)').length, 0);
  const files = [...walk('server'), ...walk('tools/migrate')].filter((f) => !f.endsWith(path.join('routes', 'auth.js')));
  assert.ok(files.length > 20);
  const bad = files.flatMap((f) => accountNameHits(fs.readFileSync(f, 'utf8')).map((h) => `${f}: ${h}`));
  assert.deepEqual(bad, []);
});

test('정적: 이전 도구는 줄 이름(m.name)을 먼저 읽고 없을 때만 계정 이름', () => {
  for (const f of ['tools/migrate/migrate.js', 'tools/migrate/sources.js']) {
    assert.match(fs.readFileSync(f, 'utf8'), /\bm\.name \?\?/, f);
  }
});

const xlsx = async (rows) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('a');
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
};

test('DB: 계정 없는 줄이 길목마다 이름째 나온다', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const f = await setup(t);
  const { pool, orgA, A } = f;
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0];
  const NAME = `${f.tag}-무계정`;
  const mid = String((await one(`INSERT INTO membership (org_id, user_id, role, duty, name) VALUES ($1, NULL, '기관관리자', '전담', $2) RETURNING id`, [orgA, NAME])).id);
  const adminMid = f.users.adminA.mid;
  // 딸린 자료: 근태 · 예약 · 보결(맡은 사람 · 빠진 사람) · 감사 로그
  await pool.query(`INSERT INTO attendance (org_id, term_id, membership_id, on_date, hours) VALUES ($1,$2,$3,'2026-11-03',1)`, [orgA, A.term, mid]);
  await pool.query(`INSERT INTO booking (org_id, special_room_id, on_date, period, membership_id) VALUES ($1,$2,'2026-11-16',1,$3)`, [orgA, A.room, mid]);
  await pool.query(`INSERT INTO substitute (org_id, term_id, absent_membership_id, on_date, period, status, taken_membership_id) VALUES ($1,$2,$3,'2026-11-17',2,'맡음',$4)`, [orgA, A.term, adminMid, mid]);
  await pool.query(`INSERT INTO substitute (org_id, term_id, absent_membership_id, on_date, period) VALUES ($1,$2,$3,'2026-11-18',3)`, [orgA, A.term, mid]);
  await pool.query(`INSERT INTO audit_log (org_id, user_id, action, table_name, row_id, after) VALUES ($1,$2,'substitute.take','substitute',$3,$4)`, [orgA, f.users.adminA.uid, A.sub, JSON.stringify({ taken: Number(mid) })]);
  await pool.query(`UPDATE term SET status = '진행' WHERE id = $1`, [A.term]);

  const c = await f.as('adminA');
  const P = `/api/orgs/${orgA}`;
  const get = async (p) => {
    const r = await c.call('GET', P + p);
    assert.equal(r.status, 200, `${p} ${r.status} ${r.text.slice(0, 200)}`);
    return r.json;
  };
  const has = (list, p, key = 'name') => assert.ok(list.some((x) => x[key] === NAME), `${p}: 계정 없는 줄 이름이 없다`);

  // 명단
  const roster = await get('/roster');
  const line = roster.find((x) => String(x.id) === mid);
  assert.ok(line, '명단에 계정 없는 줄이 없다');
  assert.deepEqual([line.name, line.loginId, line.duty], [NAME, null, '전담']);
  // 근태
  has((await get('/attendance/summary?ym=2026-11')).people, 'attendance/summary');
  // 감사 로그 — 맡은 사람 번호가 줄 이름으로
  const au = (await get('/audit')).items.find((x) => x.action === 'substitute.take' && x.after?.taken !== undefined);
  assert.equal(au?.after.taken, NAME, 'audit: 맡은 사람 이름');
  // 예약
  const free = await get('/rooms/free?on_date=2026-11-16&period=1');
  assert.ok(free.find((x) => String(x.id) === String(A.room)).busy.includes(`${NAME} 예약`), 'rooms/free busy');
  has((await get('/bookings')).rows, 'bookings', 'who');
  // 생성·시수
  has((await get('/gen/input')).teachers, 'gen/input teachers');
  const loads = await get('/loads');
  const miss = loads.alerts.find((x) => x.rule === 'load_missing_teacher');
  assert.ok(miss, 'loads: 빠진 교사 알림이 없다');
  has(miss.detail.people, 'loads 알림 사람 목록');
  const file = await xlsx([['교사', '교과', '학년', '반', '주당 시수', '연강'], [NAME, 'A과목', 1, 1, 2, '']]);
  const pv = await c.call('POST', `${P}/loads/preview`, file, { 'content-type': 'application/octet-stream' });
  assert.equal(pv.status, 200, pv.text.slice(0, 200));
  assert.equal(pv.json.ok, 1, JSON.stringify(pv.json.rows));
  assert.equal(String(pv.json.rows[0].membership_id), mid, 'loads/preview: 이름으로 줄을 찾는다');
  // 전담
  has(await get('/specialists'), 'specialists');
  // 보결
  const subs = (await get('/substitutes')).rows;
  assert.ok(subs.some((x) => x.taken_name === NAME), 'substitutes: 맡은 사람 이름');
  assert.ok(subs.some((x) => x.absent_name === NAME), 'substitutes: 빠진 사람 이름');
  const cand = await get(`/substitutes/${A.sub}/candidates`);
  has([...cand.candidates, ...cand.excluded], 'substitutes/candidates');
  const fair = (await get('/substitutes/fairness')).rows;
  assert.equal(fair.find((x) => x.name === NAME)?.count, 1, `fairness: ${JSON.stringify(fair)}`);
  // 시간표 · 출력
  has((await get(`/timetables/${A.tt}`)).teachers, 'timetables/:tid teachers');
  const { loadSheetData } = await import('../server/export/data.js');
  has((await loadSheetData(pool, orgA, A.tt)).teachers, 'loadSheetData teachers');
  // 관리자 목록(시스템 관리자)
  const sys = await f.as('sys');
  const adm = await sys.call('GET', `/api/admin/orgs/${orgA}/admins`);
  assert.equal(adm.status, 200, adm.text.slice(0, 200));
  has(adm.json, 'admin/orgs/:id/admins');

  // 이름 고치기 — 줄만 바뀐다
  const NEW = `${f.tag}-새이름`;
  const pa = await c.call('PATCH', `${P}/roster/${mid}`, { name: NEW });
  assert.equal(pa.status, 200, pa.text.slice(0, 200));
  assert.equal((await one(`SELECT name FROM membership WHERE id = $1`, [mid])).name, NEW);
  assert.ok((await get('/roster')).some((x) => x.name === NEW));
  // 계정 없는 줄의 계정 일(잠그기)은 없는 것으로 본다(앞 판 판정)
  assert.equal((await c.call('POST', `${P}/roster/${mid}/lock`, {})).status, 404);

  // 떼기 — 휴지통 묶음 이름표가 줄 이름
  const del = await c.call('DELETE', `${P}/roster/${mid}`);
  assert.equal(del.status, 200, del.text.slice(0, 200));
  assert.equal((await one(`SELECT label FROM delete_batch WHERE id = $1`, [del.json.batchId])).label, NEW);
});
