// 작은 학교 한 바퀴 — 관리자 손으로 학기 → 교시 → 반 → 교과 → 담임 → 시수표 → 생성 → 확정 → 보결 지정까지 (T-1201)
// 막힌 호출(4xx/5xx)이 하나라도 있으면 실패. 앱 코드는 고치지 않고 막히면 그 단계를 보고한다.
process.env.TZ = 'Asia/Seoul';
import test from 'node:test';
import assert from 'node:assert/strict';
import { smallSchool, seedPeople } from './fixtures/schools.js';
import { setupSchoolEnv, HAS_DB } from './fixtures/school-env.js';
import { generate } from '../web/src/gen/core.js';
import { periodsOn } from '../shared/periods.js';
import { teachersOf, isSecondOnly } from '../shared/cellTeachers.js';
import { findOverlaps } from '../server/violations.js';

// periods 를 주면 그 교시 설정으로 돈다(요일별 교시 학교 — T-1205). 돌려준 값으로 시험마다 더 본다.
// second 를 켜면 둘째 교사 줄 하나(3학년 체육: 소전담2 + 둘째 소전담1)를 더 넣고, 보결은 그 둘째 교사의 하루 결강으로 한다(T-1206).
async function walk(t, label, periods, { second = false } = {}) {
  const { pool, orgId, tag, call, blocked, P } = await setupSchoolEnv(t, label);
  const s = smallSchool();
  if (periods) s.periods = periods;
  const mids = await seedPeople(pool, orgId, tag, s);

  const term = await call('GET', `${P}/term`);
  assert.equal(term.status, 200);

  const per = await call('PUT', `${P}/school/periods`, { grades: s.periods });
  assert.equal(per.status, 200);

  const cls = {};
  for (const g of [1, 2, 3, 4, 5, 6]) {
    const r = await call('POST', `${P}/classrooms/bulk`, { grade: g, count: 1 });
    assert.equal(r.status, 201);
    cls[`${g}-1`] = r.json[0].id;
  }
  assert.equal(Object.keys(cls).length, 6);

  // 기본 교과(국어·수학·영어·체육…)는 처음 부를 때 이미 깔린다 — 있으면 쓰고, 없는 것만 새로 만든다
  const have = await call('GET', `${P}/subjects`);
  assert.equal(have.status, 200);
  const subj = Object.fromEntries(have.json.map((x) => [x.name, x.id]));
  for (const name of s.subjects) {
    if (subj[name]) continue;
    const r = await call('POST', `${P}/subjects`, { name });
    assert.equal(r.status, 201);
    subj[name] = r.json.id;
  }

  for (const c of s.classes) {
    const r = await call('PATCH', `${P}/classrooms/${cls[`${c.grade}-${c.class_no}`]}`, { homeroom_membership_id: mids[s.homerooms[`${c.grade}-${c.class_no}`]] });
    assert.equal(r.status, 200);
  }

  for (const l of s.loads) {
    const r = await call('POST', `${P}/loads`, { membership_id: mids[l.teacher], subject_id: subj[l.subject], classroom_id: cls[`${l.grade}-${l.class_no}`], weekly_hours: l.hours });
    assert.equal(r.status, 201);
  }
  if (second) {
    const r = await call('POST', `${P}/loads`, { membership_id: mids.s2, second_membership_id: mids.s1, subject_id: subj['체육'], classroom_id: cls['3-1'], weekly_hours: 1 });
    assert.equal(r.status, 201);
    assert.equal(Number(r.json.second_membership_id), mids.s1, '시수표 줄에 둘째 교사가 저장된다');
  }

  const inp = await call('GET', `${P}/gen/input`);
  assert.equal(inp.status, 200);
  assert.equal(inp.json.classrooms.length, 6);
  assert.ok(inp.json.lines.length >= s.loads.length);

  const gin = { ...inp.json, weekdays: [1, 2, 3, 4, 5], days: 5, maxPeriods: 12 };
  const gen = generate(gin, { k: 1, perMs: 500 });
  const best = gen.candidates[0];
  assert.ok(best.cells.length > 0, '생성 결과 칸이 있다');
  const cells = best.cells.map((c) => ({ classroom_id: c.classroom_id, weekday: c.weekday, period: c.period, subject_id: c.subject_id ?? null, membership_id: c.membership_id ?? null, ...(c.second_membership_id != null ? { second_membership_id: Number(c.second_membership_id) } : {}), special_room_id: c.special_room_id ?? null }));
  const secCell = cells.find((c) => c.second_membership_id);
  if (second) {
    assert.ok(secCell, '생성 결과에 둘째 교사 칸이 있다');
    assert.equal(secCell.second_membership_id, mids.s1);
    const gradeOf = Object.fromEntries(inp.json.classrooms.map((c) => [c.id, c.grade]));
    assert.deepEqual(findOverlaps(cells, { periods: { grades: s.periods }, gradeOf }).filter((f) => f.rule === 'teacher_overlap'), [], '생성기가 두 교사 다 빈 칸에만 놓음');
  }

  const sv = await call('POST', `${P}/timetables/generated`, { name: '한바퀴시안', cells });
  assert.equal(sv.status, 201);

  const cf = await call('POST', `${P}/timetables/${sv.json.id}/confirm`, { starts_on: '2026-11-16' });
  assert.equal(cf.status, 200);

  // 교사가 있는 칸 하나 → 그 요일(2026-11-16 이 월요일 → weekday n 은 11-15+n)
  const cell = second ? secCell : cells.find((c) => c.membership_id);
  assert.ok(cell, '교사 있는 칸이 있다');
  const absentId = second ? cell.second_membership_id : cell.membership_id;
  const onDate = `2026-11-${String(15 + cell.weekday).padStart(2, '0')}`;
  const sub = await call('POST', `${P}/substitutes`, { on_date: onDate, absent_membership_id: absentId, all_day: true });
  assert.equal(sub.status, 201);
  if (second) {
    // 하루 결강: 그날 그 교사가 첫째든 둘째든 든 칸이 전부 들어간다(둘째로만 든 칸 포함)
    const mine = cells.filter((c) => c.weekday === cell.weekday && teachersOf(c).includes(absentId));
    assert.ok(mine.some((c) => isSecondOnly(c, absentId)), '둘째로만 든 칸이 있다');
    assert.equal(sub.json.ids.length, mine.length, '하루 결강 칸 수 = 그날 그 교사 칸 수(둘째 포함)');
  }
  const sid = sub.json.ids[0];

  const cand = await call('GET', `${P}/substitutes/${sid}/candidates`);
  assert.equal(cand.status, 200);
  const pick = cand.json.candidates[0];
  assert.ok(pick, '보결 후보가 있다');

  const as = await call('POST', `${P}/substitutes/${sid}/assign`, { membership_id: pick.membership_id });
  assert.equal(as.status, 200);

  assert.deepEqual(blocked, []);
  return { s, cells, call, P, gin };
}

test('작은 학교 한 바퀴: 설정 → 생성 → 확정 → 보결 지정, 막힘 0', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  await walk(t, 'walk');
});

test('작은 학교 한 바퀴(둘째 교사 한 줄): 시수표 → 생성 → 확정 → 둘째 교사 하루 결강 → 보결 지정, 막힘 0', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  await walk(t, 'walksec', null, { second: true });
});

// 요일별 교시 학교: 1·2학년 월·수·금 5교시 / 화·목 4교시 · 3~6학년 수요일만 4교시 (선생님 요청 9번)
test('작은 학교 한 바퀴(요일별 교시 수): 저장 → 생성이 그날 교시 수 안에만 놓는다 → 확정 → 보결, 막힘 0', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const periods = Object.fromEntries([1, 2, 3, 4, 5, 6].map((g) => [g, g <= 2
    ? { periods: 5, lunch: '12:00', lunchAfter: 4, byDay: { 2: 4, 4: 4 } }
    : { periods: 6, lunch: '12:00', lunchAfter: 4, byDay: { 3: 4 } }]));
  const { cells, call, P, gin } = await walk(t, 'walkday', periods);
  const saved = await call('GET', `${P}/school/periods`);
  assert.deepEqual(saved.json.grades['1'].byDay, { 2: 4, 4: 4 }, '요일별 값이 저장된다(스키마가 버리지 않는다)');
  const gradeOf = Object.fromEntries(gin.classrooms.map((c) => [c.id, c.grade]));
  const out = cells.filter((c) => c.period > periodsOn(gin.periods, gradeOf[c.classroom_id], c.weekday));
  assert.deepEqual(out, [], '그날 교시 수 밖 칸이 없다');});
