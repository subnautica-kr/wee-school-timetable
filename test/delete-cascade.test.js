// 지우기 뼈대(T-1211) — 관계표대로 딸린 것까지 지우고, 묶음 번호로 되살린다. 보관 학기·감사 기록·남의 기관은 안 건드린다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HAS_DB, setup } from './sec-helpers.js';
import { inTx, preview, removeWithCascade, restoreBatch } from '../server/cascade.js';

const skip = !HAS_DB && 'DB 없음 — 건너뜀';

// 기관 A 의 반 하나(A.class)에 딸린 것을 한 벌 깐다: 시수 줄 1 · 칸 2 · 고정 1 · 보결 1(앞날) · 예약 1(앞날)
async function seed(f) {
  const { pool, A, orgA } = f;
  const q = async (sql, args) => (await pool.query(sql, args)).rows[0]?.id;
  const staff = f.users.staffA.mid;
  const dual = f.users.dual.mid;
  const s = {};
  s.load = await q(`INSERT INTO teaching_load (org_id, term_id, classroom_id, subject_id, membership_id, second_membership_id, weekly_hours) VALUES ($1,$2,$3,$4,$5,$6,3) RETURNING id`, [orgA, A.term, A.class, A.subject, staff, dual]);
  s.cell1 = await q(`INSERT INTO cell (org_id, timetable_id, classroom_id, weekday, period, subject_id, membership_id, special_room_id) VALUES ($1,$2,$3,1,1,$4,$5,$6) RETURNING id`, [orgA, A.tt, A.class, A.subject, staff, A.room]);
  s.cell2 = await q(`INSERT INTO cell (org_id, timetable_id, classroom_id, weekday, period, subject_id, membership_id, second_membership_id) VALUES ($1,$2,$3,1,2,$4,$5,$6) RETURNING id`, [orgA, A.tt, A.class, A.subject, staff, dual]);
  s.pin = await q(`INSERT INTO pin (org_id, term_id, target_kind, target_id, weekday, period, kind) VALUES ($1,$2,'반',$3,2,1,'금지') RETURNING id`, [orgA, A.term, A.class]);
  s.sub = await q(`INSERT INTO substitute (org_id, term_id, absent_membership_id, on_date, period, classroom_id) VALUES ($1,$2,$3,'2099-03-02',1,$4) RETURNING id`, [orgA, A.term, f.users.adminA.mid, A.class]);
  s.booking = await q(`INSERT INTO booking (org_id, special_room_id, on_date, period, membership_id, classroom_id) VALUES ($1,$2,'2099-03-02',2,$3,$4) RETURNING id`, [orgA, A.room, staff, A.class]);
  await pool.query(`UPDATE classroom SET homeroom_membership_id = $2 WHERE id = $1`, [A.class, staff]);
  return s;
}

const live = async (pool, table, where, args) => (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE deleted_at IS NULL AND ${where}`, args)).rows[0].n;

test('반 지우기: 영향 수 → 지움(같은 묶음) → 되살리면 원래 수 · 두 번 되살리기 409', { skip }, async (t) => {
  const f = await setup(t);
  const { pool, A } = f;
  await seed(f);
  const c = await f.as('adminA');
  const P = `/api/orgs/${f.orgA}`;

  const pv = await c.call('GET', `${P}/delete-preview?kind=classroom&id=${A.class}`);
  assert.equal(pv.status, 200);
  assert.equal(pv.json.target.label, '1학년 1반');
  const n = Object.fromEntries(pv.json.effects.map((e) => [e.table, e.count]));
  assert.deepEqual(n, { teaching_load: 1, cell: 2, pin: 1, substitute: 1, booking: 1 });
  assert.equal(pv.json.effects.find((e) => e.table === 'cell').label, '시간표 칸');
  assert.deepEqual(pv.json.warnings, []);

  const before = { load: await live(pool, 'teaching_load', 'classroom_id = $1', [A.class]), cell: await live(pool, 'cell', 'classroom_id = $1', [A.class]) };
  const del = await c.call('DELETE', `${P}/classrooms/${A.class}`);
  assert.equal(del.status, 200);
  assert.equal(del.json.ok, true);
  assert.ok(del.json.batchId > 0);
  for (const [tb, w] of [['classroom', 'id = $1'], ['teaching_load', 'classroom_id = $1'], ['cell', 'classroom_id = $1'], ['substitute', 'classroom_id = $1'], ['booking', 'classroom_id = $1'], ['pin', `target_kind = '반' AND target_id = $1`]]) {
    assert.equal(await live(pool, tb, w, [A.class]), 0, `${tb} 남음`);
  }
  // 같은 묶음 번호 — 대상 1 + 딸린 것 6
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM delete_batch_item WHERE batch_id = $1`, [del.json.batchId])).rows[0].n, 7);

  const trash = await c.call('GET', `${P}/trash`);
  assert.equal(trash.status, 200);
  assert.equal(trash.json[0].id, del.json.batchId);
  assert.equal(trash.json[0].label, '1학년 1반');
  assert.equal(trash.json[0].restored_at, null);

  const rs = await c.call('POST', `${P}/trash/${del.json.batchId}/restore`, {});
  assert.equal(rs.status, 200);
  assert.equal(await live(pool, 'classroom', 'id = $1', [A.class]), 1);
  assert.equal(await live(pool, 'teaching_load', 'classroom_id = $1', [A.class]), before.load);
  assert.equal(await live(pool, 'cell', 'classroom_id = $1', [A.class]), before.cell);
  assert.equal(await live(pool, 'booking', 'classroom_id = $1', [A.class]), 1);
  assert.equal((await c.call('POST', `${P}/trash/${del.json.batchId}/restore`, {})).status, 409); // 이미 되살림
  // 감사 기록: 지움 · 되살림
  const acts = (await pool.query(`SELECT action FROM audit_log WHERE org_id = $1 ORDER BY id`, [f.orgA])).rows.map((r) => r.action);
  assert.ok(acts.includes('classroom.delete') && acts.includes('trash.restore'));
  // 교직원은 휴지통을 못 본다
  assert.equal((await (await f.as('staffA')).call('GET', `${P}/trash`)).status, 404);
});

test('교사 지우기: 칸·시수 줄의 교사 칸만 비움(줄은 남김) · 지난 보결은 남김 · 되살리면 교사 복귀', { skip }, async (t) => {
  const f = await setup(t);
  const { pool, A, orgA } = f;
  const s = await seed(f);
  const staff = f.users.staffA.mid;
  const dual = f.users.dual.mid;
  const past = (await pool.query(`INSERT INTO booking (org_id, special_room_id, on_date, period, membership_id) VALUES ($1,$2,'2020-03-02',1,$3) RETURNING id`, [orgA, A.room, staff])).rows[0].id;

  const pv = await preview(pool, orgA, 'membership', staff);
  const n = Object.fromEntries(pv.effects.map((e) => [`${e.table}.${e.action}`, e.count]));
  assert.equal(n['cell.null'], 2);
  assert.equal(n['teaching_load.null'], 1);
  assert.equal(n['classroom.null'], 1);
  assert.equal(n['booking.delete'], 1); // 앞날 예약만(지난 예약은 기록)

  const out = await inTx(pool, (c) => removeWithCascade(c, orgA, 'membership', staff, f.users.adminA.uid));
  const cell = async (id) => (await pool.query(`SELECT membership_id, second_membership_id, deleted_at FROM cell WHERE id = $1`, [id])).rows[0];
  assert.deepEqual(await cell(s.cell1), { membership_id: null, second_membership_id: null, deleted_at: null });
  assert.equal((await cell(s.cell2)).second_membership_id, dual); // 다른 교사는 그대로
  const load = (await pool.query(`SELECT membership_id, second_membership_id, deleted_at FROM teaching_load WHERE id = $1`, [s.load])).rows[0];
  assert.deepEqual(load, { membership_id: null, second_membership_id: dual, deleted_at: null });
  assert.equal((await pool.query(`SELECT homeroom_membership_id FROM classroom WHERE id = $1`, [A.class])).rows[0].homeroom_membership_id, null);
  assert.equal(await live(pool, 'booking', 'id = $1', [s.booking]), 0);
  assert.equal(await live(pool, 'booking', 'id = $1', [past]), 1);
  assert.equal(await live(pool, 'membership', 'id = $1', [staff]), 0);

  await inTx(pool, (c) => restoreBatch(c, orgA, out.batchId));
  assert.equal((await cell(s.cell1)).membership_id, staff);
  assert.equal((await cell(s.cell2)).membership_id, staff);
  assert.equal((await pool.query(`SELECT membership_id FROM teaching_load WHERE id = $1`, [s.load])).rows[0].membership_id, staff);
  assert.equal((await pool.query(`SELECT homeroom_membership_id FROM classroom WHERE id = $1`, [A.class])).rows[0].homeroom_membership_id, staff);
  assert.equal(await live(pool, 'booking', 'id = $1', [s.booking]), 1);
  assert.equal(await live(pool, 'membership', 'id = $1', [staff]), 1);
});

test('같은 반 번호를 다시 만든 뒤 되살리기 → 409(이유 한국어) · 지운 시간표 되살리기', { skip }, async (t) => {
  const f = await setup(t);
  const { pool, A } = f;
  await seed(f);
  const c = await f.as('adminA');
  const P = `/api/orgs/${f.orgA}`;
  const del = await c.call('DELETE', `${P}/classrooms/${A.class}`);
  await pool.query(`INSERT INTO classroom (org_id, term_id, grade, class_no) VALUES ($1, $2, 1, 1)`, [f.orgA, A.term]);
  const rs = await c.call('POST', `${P}/trash/${del.json.batchId}/restore`, {});
  assert.equal(rs.status, 409);
  assert.match(rs.json.error, /1학년 1반/);
  assert.equal(await live(pool, 'classroom', 'id = $1', [A.class]), 0); // 하나도 안 풀림(트랜잭션)

  // 시간표: 지우면 칸 같이 · 되살리면 칸 같이
  const tt = await c.call('DELETE', `${P}/timetables/${A.tt}`);
  assert.equal(tt.status, 200);
  assert.ok(tt.json.batchId > 0);
  assert.equal(await live(pool, 'timetable', 'id = $1', [A.tt]), 0);
  assert.equal((await c.call('POST', `${P}/trash/${tt.json.batchId}/restore`, {})).status, 200);
  assert.equal(await live(pool, 'timetable', 'id = $1', [A.tt]), 1);
  // 반 묶음이 지운 칸은 반 묶음 몫이라 시간표 되살리기로 안 풀린다
  assert.equal(await live(pool, 'cell', 'timetable_id = $1', [A.tt]), 0);
});

test('남의 기관 id 는 404 · 보관 학기와 감사 기록은 그대로 · 확정 시간표 경고', { skip }, async (t) => {
  const f = await setup(t);
  const { pool, A, B, orgA, orgB } = f;
  await seed(f);
  const c = await f.as('adminA');
  const P = `/api/orgs/${orgA}`;
  assert.equal((await c.call('GET', `${P}/delete-preview?kind=classroom&id=${B.class}`)).status, 404);
  assert.equal((await c.call('GET', `${P}/delete-preview?kind=nope&id=${A.class}`)).status, 404);
  assert.equal((await c.call('GET', `/api/orgs/${orgB}/delete-preview?kind=classroom&id=${B.class}`)).status, 404);
  const bBatch = await inTx(pool, (x) => removeWithCascade(x, orgB, 'subject', B.subject, null));
  assert.equal((await c.call('POST', `${P}/trash/${bBatch.batchId}/restore`, {})).status, 404);
  assert.equal(await inTx(pool, (x) => removeWithCascade(x, orgA, 'classroom', B.class, null)), null);
  assert.equal((await c.call('GET', `${P}/trash`)).json.length, 0); // B 묶음은 안 보인다

  // 보관 학기: 그 학기의 시수 줄은 교사를 지워도 그대로 · 보관 학기 반은 지우기 거부
  const old = (await pool.query(`INSERT INTO term (org_id, year, semester, status) VALUES ($1, 2025, 1, '보관') RETURNING id`, [orgA])).rows[0].id;
  const oldClass = (await pool.query(`INSERT INTO classroom (org_id, term_id, grade, class_no, homeroom_membership_id) VALUES ($1,$2,1,1,$3) RETURNING id`, [orgA, old, f.users.staffA.mid])).rows[0].id;
  const oldLoad = (await pool.query(`INSERT INTO teaching_load (org_id, term_id, classroom_id, subject_id, membership_id, weekly_hours) VALUES ($1,$2,$3,$4,$5,2) RETURNING id`, [orgA, old, oldClass, A.subject, f.users.staffA.mid])).rows[0].id;
  const auditBefore = (await pool.query(`SELECT id, action, deleted_at FROM audit_log WHERE org_id = $1 ORDER BY id`, [orgA])).rows;
  await inTx(pool, (x) => removeWithCascade(x, orgA, 'membership', f.users.staffA.mid, null));
  await inTx(pool, (x) => removeWithCascade(x, orgA, 'subject', A.subject, null));
  const ol = (await pool.query(`SELECT membership_id, deleted_at FROM teaching_load WHERE id = $1`, [oldLoad])).rows[0];
  assert.deepEqual(ol, { membership_id: f.users.staffA.mid, deleted_at: null });
  assert.equal((await pool.query(`SELECT homeroom_membership_id FROM classroom WHERE id = $1`, [oldClass])).rows[0].homeroom_membership_id, f.users.staffA.mid);
  await assert.rejects(inTx(pool, (x) => removeWithCascade(x, orgA, 'classroom', oldClass, null)), { status: 409 });
  assert.equal((await c.call('DELETE', `${P}/classrooms/${oldClass}`)).status, 409);
  const auditAfter = (await pool.query(`SELECT id, action, deleted_at FROM audit_log WHERE org_id = $1 AND id <= $2 ORDER BY id`, [orgA, auditBefore.at(-1)?.id ?? 0])).rows;
  assert.deepEqual(auditAfter, auditBefore);

  // 확정 시간표에 걸리면 경고 한 줄
  await pool.query(`UPDATE timetable SET status = '확정', starts_on = '2026-09-01' WHERE id = $1`, [A.tt]);
  const pv = await c.call('GET', `${P}/delete-preview?kind=classroom&id=${A.class}`);
  assert.equal(pv.json.warnings.length, 1);
  assert.match(pv.json.warnings[0], /확정된 시간표 1개/);
});
