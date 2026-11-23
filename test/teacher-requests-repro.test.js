// 교사 요청 6~11번 재현 — 지금 동작을 그대로 굳힌다(T-1201). 고치는 판이 이 시험의 기대값을 뒤집는다.
// 각 기대값 옆 「고칠 것: T-12xx」 는 그 줄을 바꿀 판. 문서: docs/dev/teacher-requests-6-11.md
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rankCandidates } from '../server/candidates.js';
import { prepare } from '../web/src/gen/core.js';
import { emptyCount } from '../shared/ttConfirm.js';
import { bigSchool, seedPeople, seedStructure } from './fixtures/schools.js';
import { setupSchoolEnv, HAS_DB } from './fixtures/school-env.js';

const src = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const baseCtx = (over = {}) => ({
  weekday: 1, period: 3, periodConfig: { grades: { 1: { periods: 5 } } },
  cells: [], members: [], absentIds: new Set(), pins: [], takenIds: new Set(), ...over,
});

test('(가) 반 없는 담임은 보결 후보에서 빠진다 — 담임을 붙이면 후보', () => {
  const noRoom = rankCandidates(baseCtx({ members: [{ id: 1, name: '가', duty: '담임', homeroom: null }] }));
  assert.deepEqual(noRoom.excluded.map((x) => x.code), ['teaching']); // 고칠 것: T-1203
  assert.equal(noRoom.candidates.length, 0);
  // 대조 — 반을 붙이고 그 반 칸을 전담이 가르치면 A 등급 후보
  const withRoom = rankCandidates(baseCtx({
    members: [{ id: 1, name: '가', duty: '담임', homeroom: { id: 10, grade: 1 } }, { id: 2, name: '나', duty: '전담', homeroom: null }],
    cells: [{ classroom_id: 10, weekday: 1, period: 3, subject_id: 5, membership_id: 2 }],
  }));
  assert.equal(withRoom.candidates.find((c) => c.membership_id === 1)?.grade, 'A');
});

test('(나) 급식지도 경고는 lunch 와 lunchAfter 둘 다 있어야 뜬다', () => {
  const dutyMembers = (grade) => rankCandidates(baseCtx({
    period: 4, periodConfig: { grades: { 1: grade } },
    members: [{ id: 1, name: '가', duty: '담임', homeroom: { id: 10, grade: 1 } }, { id: 2, name: '나', duty: '전담', homeroom: null }],
    cells: [{ classroom_id: 10, weekday: 1, period: 4, subject_id: 5, membership_id: 2 }],
  })).candidates.find((c) => c.membership_id === 1);
  assert.equal(dutyMembers({ periods: 5, lunch: '12:00', lunchAfter: 4 })?.warn?.code, 'lunch');
  assert.equal(dutyMembers({ periods: 5, lunchAfter: 4 })?.warn?.code, 'lunch'); // T-1202: lunchAfter 만 있어도 알린다
  assert.equal(dutyMembers({ periods: 5, lunch: '12:00' })?.warn, undefined); // 점심 시각만 있고 자리가 없으면 경고 없음(설계: 직접 넣기 하나만)
});

test('8번: 점심 시각만 넣은 학년은 생성 재료의 점심 자리(L)가 0 이다', () => {
  const p = prepare({ classrooms: [{ id: 1, grade: 1, class_no: 1 }], lines: [], periods: { grades: { 1: { periods: 5, lunch: '12:00' } } }, pins: [], subjects: [], teachers: [], rooms: [] });
  assert.equal(p.classes[0].L, 0); // 설계: 직접 넣기 하나만 — 시각에서 계산하지 않는다
  const s = src('web/src/gen/core.js');
  assert.match(s, /L: g\.lunchAfter \|\| 0/);
});

test('9번: 하교 판정은 요일을 안 본다 · 확정 전 빈칸 수도 요일별 교시를 모른다', () => {
  const cfg = { grades: { 1: { periods: 5 } } };
  const members = [{ id: 1, name: '가', duty: '담임', homeroom: { id: 10, grade: 1 } }];
  const grade = (weekday) => rankCandidates(baseCtx({ weekday, period: 6, periodConfig: cfg, members })).candidates[0]?.grade;
  assert.equal(grade(1), 'B');
  assert.equal(grade(3), 'B'); // 수요일에 일찍 끝나는 학교도 같은 판정 — 고칠 것: T-1205
  assert.match(src('server/candidates.js'), /period > g\.periods/);
  // 빈칸 수: 학년 교시 수 × 5 고정
  assert.equal(emptyCount([{ grade: 1 }], cfg, []), 25); // 고칠 것: T-1205 (요일별 교시 수)
});

test('7번: 큰 학교를 담임 시수 없이 심으면 빠진 교사 알림이 사람마다 하나(56)', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const { pool, orgId, tag, call, P } = await setupSchoolEnv(t, 'rep');
  const s = bigSchool();
  const mids = await seedPeople(pool, orgId, tag, s);
  await seedStructure(pool, orgId, s, mids);
  const r = await call('GET', `${P}/loads`);
  assert.equal(r.status, 200);
  const miss = r.json.alerts.filter((a) => a.rule === 'load_missing_teacher');
  assert.equal(miss.length, 56); // 담임 51 + 비교과 5 — 한 줄로 묶어야. 고칠 것: T-1203
});

test('6번: 시수표·칸에는 둘째 교사를 담을 열이 없다', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const { pool } = await setupSchoolEnv(t, 'rep');
  for (const table of ['teaching_load', 'cell']) {
    const { rows } = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name LIKE '%membership%'`, [table]);
    assert.deepEqual(rows.map((x) => x.column_name), ['membership_id']); // 고칠 것: T-1206
  }
});

test('10번: 시수표를 한꺼번에 올리는 라우트가 없다', () => {
  const s = src('server/routes/loads.js');
  assert.doesNotMatch(s, /\/loads\/(import|upload|bulk)/); // 고칠 것: T-1204
  const verbs = [...s.matchAll(/r\.(get|post|patch|delete|put)\('([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(verbs, ['get /loads', 'get /loads/effective', 'post /loads', 'patch /loads/:id', 'delete /loads/:id']);
});

test('8번(T-1202): 점심 자리(lunchAfter)만 넣어도 생성 재료 L 이 채워지고 급식지도 제외·경고가 돈다', () => {
  const p = prepare({ classrooms: [{ id: 1, grade: 1, class_no: 1 }], lines: [], periods: { grades: { 1: { periods: 5, lunchAfter: 4 } } }, pins: [], subjects: [], teachers: [], rooms: [] });
  assert.equal(p.classes[0].L, 4);
  const members = [{ id: 1, name: '가', duty: '담임', homeroom: { id: 10, grade: 1 } }, { id: 2, name: '나', duty: '전담', homeroom: null }];
  const cells = [{ classroom_id: 10, weekday: 1, period: 4, subject_id: 5, membership_id: 2 }];
  const periodConfig = { grades: { 1: { periods: 5, lunchAfter: 4 } } };
  const ex = rankCandidates(baseCtx({ period: 4, periodConfig, members, cells, config: { substitute: { lunchDuty: 'exclude' } } }));
  assert.ok(ex.excluded.some((x) => x.code === 'lunch'), JSON.stringify(ex.excluded));
  // 점심 자리를 안 넣은 학교는 결과 불변
  const none = rankCandidates(baseCtx({ period: 4, members, cells, config: { substitute: { lunchDuty: 'exclude' } } }));
  assert.ok(!none.excluded.some((x) => x.code === 'lunch'));
});

test('8번(T-1202): 학교 화면에 점심 자리 칸 · 접힌 교시 시각 · 생성 화면 알림이 있다', () => {
  const sp = src('web/src/school/SchoolPage.jsx');
  assert.match(sp, /점심은 몇 교시 뒤/);
  assert.match(sp, /setG\(g, \{ lunchAfter: v \}\)/);
  assert.match(sp, /교시 시각 넣기/);
  assert.match(src('web/src/generate/AutoGen.jsx'), /점심 자리가 비어 점심 규칙을 건너뜁니다/);
  assert.match(src('server/routes/school.js'), /lunchAfter: z\.number\(\)\.int\(\)\.min\(0\)/);
});
