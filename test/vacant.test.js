// T-1327a 담당 비었음 — 재직 아닌(전출·휴직·퇴직) 소속의 수업·담임을 이름·상태와 함께 내려 주고, 기존 목록 꼴은 그대로 둔다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HAS_DB, setup } from './sec-helpers.js';

test('담당 비었음: 전출 줄의 수업이 이름·상태와 함께 나오고 기존 목록은 그대로', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const f = await setup(t);
  const { pool } = f;
  const P = `/api/orgs/${f.orgA}`;
  const c = f.client();
  await c.login('adminA');
  const mid = f.users.staffA.mid;
  const before = (await c.call('GET', `${P}/loads`)).json;
  assert.equal(before.vacant.count, 0);
  assert.deepEqual(before.inactive_teachers, []);

  await pool.query(`INSERT INTO teaching_load (org_id, term_id, membership_id, classroom_id, subject_id, weekly_hours) VALUES ($1,$2,$3,$4,$5,2)`, [f.orgA, f.A.term, mid, f.A.class, f.A.subject]);
  await pool.query(`UPDATE classroom SET homeroom_membership_id = $2 WHERE id = $1`, [f.A.class, mid]);
  await pool.query(`UPDATE membership SET status = '전출' WHERE id = $1`, [mid]);

  const l = (await c.call('GET', `${P}/loads`)).json;
  assert.equal(l.vacant.count, 1);
  assert.equal(l.vacant.homerooms, 1);
  assert.deepEqual(l.inactive_teachers.filter((x) => String(x.id) === String(mid)).map((x) => [x.name, x.status]), [['staffA', '전출']]);
  assert.ok(Array.isArray(l.lines) && Array.isArray(l.alerts) && l.term, '기존 칸 그대로');

  const v = (await c.call('GET', `${P}/loads/vacant`)).json;
  assert.equal(v.count, 1);
  assert.equal(v.loads[0].name, 'staffA');
  assert.equal(v.loads[0].status, '전출');
  assert.equal(v.loads[0].subject_name, 'A과목');
  assert.equal(v.homerooms[0].status, '전출');

  const g = (await c.call('GET', `${P}/timetables/${f.A.tt}`)).json;
  assert.ok(!g.teachers.some((x) => String(x.id) === String(mid)), '재직 목록에는 안 나옴');
  assert.ok(g.inactive_teachers.some((x) => String(x.id) === String(mid) && x.status === '전출'));

  const gi = (await c.call('GET', `${P}/gen/input`)).json;
  assert.equal(gi.vacant.count, 1);
  assert.ok(gi.inactive_teachers.some((x) => String(x.id) === String(mid)));
  assert.ok(!gi.teachers.some((x) => String(x.id) === String(mid)));

  await pool.query(`UPDATE membership SET status = '사용' WHERE id = $1`, [mid]);
  assert.equal((await c.call('GET', `${P}/loads/vacant`)).json.count, 0);
});
