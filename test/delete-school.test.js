// 학교 자료 지우기(T-1212) — 소속 떼기 · 학기 비우기 3단계 · 방금 연 학기 되돌리기. 보관 학기·감사 기록·남의 기관은 안 건드린다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HAS_DB, setup } from './sec-helpers.js';
import { ACTION_LABEL } from '../shared/audit-labels.js';

const skip = !HAS_DB && 'DB 없음 — 건너뜀';

const live = async (pool, table, where, args) => (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE deleted_at IS NULL AND ${where}`, args)).rows[0].n;

// 기관 A 학기(A.term)에 시수 줄 1 · 칸 1 · 고정 1 을 더한다(반·시간표·교과는 setup 이 이미 깔았다)
async function seed(f) {
  const { pool, A, orgA } = f;
  const q = async (sql, args) => (await pool.query(sql, args)).rows[0].id;
  return {
    load: await q(`INSERT INTO teaching_load (org_id, term_id, classroom_id, subject_id, membership_id, weekly_hours) VALUES ($1,$2,$3,$4,$5,3) RETURNING id`, [orgA, A.term, A.class, A.subject, f.users.staffA.mid]),
    cell: await q(`INSERT INTO cell (org_id, timetable_id, classroom_id, weekday, period, subject_id, membership_id) VALUES ($1,$2,$3,1,1,$4,$5) RETURNING id`, [orgA, A.tt, A.class, A.subject, f.users.staffA.mid]),
    pin: await q(`INSERT INTO pin (org_id, term_id, target_kind, target_id, weekday, period, kind) VALUES ($1,$2,'반',$3,2,1,'금지') RETURNING id`, [orgA, A.term, A.class]),
  };
}

const auditIds = async (pool, orgId) => (await pool.query(`SELECT id, action, after FROM audit_log WHERE org_id = $1 ORDER BY id`, [orgId])).rows;

test('1 소속 떼기: 이 기관 멤버십만 지움(계정·다른 기관 소속 남김) · 되살리기 왕복 · 내 소속·교직원 거부', { skip }, async (t) => {
  const f = await setup(t);
  const { pool, orgA } = f;
  const P = `/api/orgs/${orgA}`;
  await seed(f);
  const c = await f.as('adminA');
  const dual = f.users.dual;

  const pv = await c.call('GET', `${P}/delete-preview?kind=membership&id=${dual.mid}`);
  assert.equal(pv.status, 200);
  const del = await c.call('DELETE', `${P}/roster/${dual.mid}`);
  assert.equal(del.status, 200);
  assert.ok(del.json.batchId > 0);
  assert.equal(await live(pool, 'membership', 'id = $1', [dual.mid]), 0);
  assert.equal(await live(pool, 'membership', 'id = $1', [dual.midB]), 1); // 다른 기관 겸임은 그대로
  assert.equal(await live(pool, 'app_user', 'id = $1', [dual.uid]), 1); // 계정은 그대로

  assert.equal((await c.call('POST', `${P}/trash/${del.json.batchId}/restore`, {})).status, 200);
  assert.equal(await live(pool, 'membership', 'id = $1', [dual.mid]), 1);

  assert.equal((await c.call('DELETE', `${P}/roster/${f.users.adminA.mid}`)).status, 409); // 내 소속
  assert.equal((await c.call('DELETE', `${P}/roster/${f.users.adminB.mid}`)).status, 404); // 남의 기관 줄
  const acts = (await auditIds(pool, orgA)).map((r) => r.action);
  assert.ok(acts.includes('membership.delete') && acts.includes('trash.restore'));
  assert.equal((await (await f.as('staffA')).call('DELETE', `${P}/roster/${dual.mid}`)).status, 404);
});

test('1 반·교과·특별실 지우기: 미리보기 → 지움 → 휴지통 되살리기', { skip }, async (t) => {
  const f = await setup(t);
  const { pool, A, orgA } = f;
  const P = `/api/orgs/${orgA}`;
  await seed(f);
  const c = await f.as('adminA');
  for (const [kind, url, id, table] of [['subject', 'subjects', A.subject, 'subject'], ['special_room', 'special-rooms', A.room, 'special_room'], ['classroom', 'classrooms', A.class, 'classroom']]) {
    assert.equal((await c.call('GET', `${P}/delete-preview?kind=${kind}&id=${id}`)).status, 200, kind);
    const del = await c.call('DELETE', `${P}/${url}/${id}`);
    assert.equal(del.status, 200, kind);
    assert.equal(await live(pool, table, 'id = $1', [id]), 0, kind);
    assert.equal((await c.call('POST', `${P}/trash/${del.json.batchId}/restore`, {})).status, 200, kind);
    assert.equal(await live(pool, table, 'id = $1', [id]), 1, kind);
  }
});

test('2 학기 비우기: 3단계 · 확인 글자 · 되살리기 왕복 · 학기와 감사 기록은 남김', { skip }, async (t) => {
  const f = await setup(t);
  const { pool, A, orgA } = f;
  const P = `/api/orgs/${orgA}`;
  const s = await seed(f);
  const c = await f.as('adminA');
  const name = '2026년 2학기';
  const state = async () => ({
    tt: await live(pool, 'timetable', 'term_id = $1', [A.term]), cell: await live(pool, 'cell', 'id = $1', [s.cell]),
    load: await live(pool, 'teaching_load', 'term_id = $1', [A.term]), pin: await live(pool, 'pin', 'term_id = $1', [A.term]),
    cls: await live(pool, 'classroom', 'term_id = $1', [A.term]),
  });
  const before = await state();
  const auditBefore = await auditIds(pool, orgA);

  // 미리보기는 단계마다 영향이 커진다 · 단계 이름이 틀리면 404
  const pv = async (level) => c.call('GET', `${P}/terms/${A.term}/clear-preview?level=${level}`);
  const tables = async (level) => (await pv(level)).json.effects.map((e) => e.table).sort();
  assert.deepEqual(await tables('timetable'), ['cell', 'timetable']);
  assert.deepEqual(await tables('hours'), ['cell', 'pin', 'teaching_load', 'timetable']);
  assert.ok((await tables('classes')).includes('classroom'));
  assert.equal((await pv('nope')).status, 404);
  assert.equal((await pv('timetable')).json.confirmText, name);

  // 확인 글자가 틀리면 400 이고 아무것도 안 지운다
  const body = (level, confirm) => ({ level, confirm });
  assert.equal((await c.call('POST', `${P}/terms/${A.term}/clear`, body('timetable', '2026년 1학기'))).status, 400);
  assert.equal((await c.call('POST', `${P}/terms/${A.term}/clear`, { level: 'timetable' })).status, 400);
  assert.deepEqual(await state(), before);

  // timetable: 시간표·칸만
  const r1 = await c.call('POST', `${P}/terms/${A.term}/clear`, body('timetable', name));
  assert.equal(r1.status, 200);
  assert.deepEqual(await state(), { ...before, tt: 0, cell: 0 });
  assert.equal((await c.call('POST', `${P}/terms/${A.term}/clear`, body('timetable', name))).status, 409); // 비울 것 없음
  assert.equal((await c.call('POST', `${P}/trash/${r1.json.batchId}/restore`, {})).status, 200);
  assert.deepEqual(await state(), before);

  // hours: +시수표·고정(반은 남음)
  const r2 = await c.call('POST', `${P}/terms/${A.term}/clear`, body('hours', name));
  assert.equal(r2.status, 200);
  assert.deepEqual(await state(), { ...before, tt: 0, cell: 0, load: 0, pin: 0 });
  assert.equal((await c.call('POST', `${P}/trash/${r2.json.batchId}/restore`, {})).status, 200);
  assert.deepEqual(await state(), before);

  // classes: +반까지. 학기·교과·명단은 남는다
  const r3 = await c.call('POST', `${P}/terms/${A.term}/clear`, body('classes', name));
  assert.equal(r3.status, 200);
  assert.equal((await state()).cls, 0);
  assert.equal(await live(pool, 'term', 'id = $1', [A.term]), 1);
  assert.equal(await live(pool, 'subject', 'id = $1', [A.subject]), 1);
  assert.equal((await c.call('GET', `${P}/trash`)).json[0].label, `${name} 비우기(시간표·시수표·고정·반까지)`);
  assert.equal((await c.call('POST', `${P}/trash/${r3.json.batchId}/restore`, {})).status, 200);
  assert.deepEqual(await state(), before);

  // 감사 기록은 하나도 안 지워지고 새 동작이 남는다
  const auditAfter = await auditIds(pool, orgA);
  assert.deepEqual(auditAfter.slice(0, auditBefore.length), auditBefore);
  const acts = new Set(auditAfter.map((r) => r.action));
  assert.ok(acts.has('term.clear') && acts.has('trash.restore'));
  assert.ok(ACTION_LABEL['term.clear'] && ACTION_LABEL['term.undo_new_semester'] && ACTION_LABEL['membership.delete']);
});

test('2 학기 비우기: 보관 학기 409 · 남의 기관 학기·교직원 404', { skip }, async (t) => {
  const f = await setup(t);
  const { pool, A, B, orgA } = f;
  const P = `/api/orgs/${orgA}`;
  await seed(f);
  const old = (await pool.query(`INSERT INTO term (org_id, year, semester, status) VALUES ($1, 2025, 1, '보관') RETURNING id`, [orgA])).rows[0].id;
  const oldClass = (await pool.query(`INSERT INTO classroom (org_id, term_id, grade, class_no) VALUES ($1,$2,1,1) RETURNING id`, [orgA, old])).rows[0].id;
  const c = await f.as('adminA');
  const r = await c.call('POST', `${P}/terms/${old}/clear`, { level: 'classes', confirm: '2025년 1학기' });
  assert.equal(r.status, 409);
  assert.equal(await live(pool, 'classroom', 'id = $1', [oldClass]), 1);
  assert.equal((await c.call('POST', `${P}/terms/${B.term}/clear`, { level: 'classes', confirm: '2026년 2학기' })).status, 404);
  assert.equal((await c.call('GET', `${P}/terms/${B.term}/clear-preview?level=hours`)).status, 404);
  assert.equal(await live(pool, 'classroom', 'id = $1', [B.class]), 1);
  const st = await f.as('staffA');
  assert.equal((await st.call('POST', `${P}/terms/${A.term}/clear`, { level: 'timetable', confirm: '2026년 2학기' })).status, 404);
  assert.equal((await st.call('GET', `${P}/terms/${A.term}/clear-preview?level=timetable`)).status, 404);
  assert.equal(await live(pool, 'timetable', 'id = $1', [A.tt]), 1);
});

test('3 방금 연 학기 되돌리기: 새 학기 지움 + 지난 학기 보관 풂 · 휴지통 되살리기는 409 · 감사 기록 남김', { skip }, async (t) => {
  const f = await setup(t);
  const { pool, A, orgA } = f;
  const P = `/api/orgs/${orgA}`;
  await seed(f);
  const c = await f.as('adminA');
  const chk0 = (await c.call('GET', `${P}/terms/undo-new-semester`)).json;
  assert.equal(chk0.ok, false); // 새 학기를 연 적 없음
  assert.match(chk0.reason, /되돌릴 학기가 없습니다 — .*「새 학기 시작」 직후에만/);
  assert.equal((await c.call('POST', `${P}/terms/undo-new-semester`, {})).status, 409);

  const ns = await c.call('POST', `${P}/terms/new-semester`, { confirm: true });
  assert.equal(ns.status, 200);
  const nt = ns.json.term.id;
  const status = async (id) => (await pool.query(`SELECT status, deleted_at FROM term WHERE id = $1`, [id])).rows[0];
  assert.equal((await status(A.term)).status, '보관');
  // 새 학기에 시안 하나·반 하나 — 확정본·보결 기록은 없다
  await pool.query(`INSERT INTO classroom (org_id, term_id, grade, class_no) VALUES ($1,$2,2,1)`, [orgA, nt]);
  const tt = (await pool.query(`INSERT INTO timetable (org_id, term_id, name) VALUES ($1,$2,'새 시안') RETURNING id`, [orgA, nt])).rows[0].id;
  const heldBefore = await live(pool, 'teaching_load', 'term_id = $1', [A.term]);

  // 확정본이 생기면 못 되돌린다(이유 한국어)
  await pool.query(`UPDATE timetable SET status = '확정', starts_on = '2027-03-02' WHERE id = $1`, [tt]);
  const blocked = await c.call('POST', `${P}/terms/undo-new-semester`, {});
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.error, /확정/);
  assert.equal((await status(nt)).deleted_at, null);
  await pool.query(`UPDATE timetable SET status = '시안', starts_on = NULL WHERE id = $1`, [tt]);

  const auditBefore = await auditIds(pool, orgA);
  const ok = await c.call('POST', `${P}/terms/undo-new-semester`, {});
  assert.equal(ok.status, 200);
  assert.equal((await status(A.term)).status, '진행');
  assert.notEqual((await status(nt)).deleted_at, null);
  assert.equal(await live(pool, 'timetable', 'term_id = $1', [nt]), 0);
  assert.equal(await live(pool, 'classroom', 'term_id = $1', [nt]), 0);
  assert.equal(await live(pool, 'teaching_load', 'term_id = $1', [A.term]), heldBefore); // 지난 학기 자료는 그대로
  const auditAfter = await auditIds(pool, orgA);
  assert.deepEqual(auditAfter.slice(0, auditBefore.length), auditBefore);
  assert.ok(auditAfter.some((r) => r.action === 'term.undo_new_semester'));
  // 지금 학기는 새 학기로 연 학기가 아니라 다시 되돌릴 수 없다
  assert.equal((await c.call('POST', `${P}/terms/undo-new-semester`, {})).status, 409);
  // 되돌려 진행 중인 학기가 있으니 새 학기 묶음 되살리기는 막힌다
  const rs = await c.call('POST', `${P}/trash/${ok.json.batchId}/restore`, {});
  assert.equal(rs.status, 409);
  assert.match(rs.json.error, /진행 중/);
  assert.equal((await status(nt)).deleted_at !== null, true);
});

test('3 되돌리기: 보결 기록이 있으면 409 · 교직원·남의 기관 404', { skip }, async (t) => {
  const f = await setup(t);
  const { pool, orgA, orgB } = f;
  const P = `/api/orgs/${orgA}`;
  const c = await f.as('adminA');
  const nt = (await c.call('POST', `${P}/terms/new-semester`, { confirm: true })).json.term.id;
  await pool.query(`INSERT INTO substitute (org_id, term_id, absent_membership_id, on_date, period) VALUES ($1,$2,$3,'2099-03-02',1)`, [orgA, nt, f.users.adminA.mid]);
  const r = await c.call('POST', `${P}/terms/undo-new-semester`, {});
  assert.equal(r.status, 409);
  assert.match(r.json.error, /보결/);
  assert.equal((await (await f.as('staffA')).call('POST', `${P}/terms/undo-new-semester`, {})).status, 404);
  // B 기관 관리자는 A 기관 경로로 못 온다
  const b = await f.as('adminB', orgB);
  assert.equal((await b.call('POST', `${P}/terms/undo-new-semester`, {})).status, 404);
  assert.equal((await pool.query(`SELECT deleted_at FROM term WHERE id = $1`, [nt])).rows[0].deleted_at, null);
});
