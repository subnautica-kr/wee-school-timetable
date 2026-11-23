// 선생님 요청 6번(T-1206) — 한 수업에 교사 둘. 「이 칸의 교사들」(shared/cellTeachers.js)을 거치는 자리를 DB 없이 본다.
// 겹침 경고 · 수정 모드 칸 색 · 보결 후보 · 출력 이름 · 엑셀 「둘째 교사」 열 · 생성기(두 교사 다 빈 칸에만 · 함께 시수 · 연강 통째)
// 하루 결강·생성→확정→보결 경로는 DB 가 필요해 small-school-walk.test.js 에 있다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findOverlaps as serverOverlaps } from '../server/violations.js';
import { findOverlaps as webOverlaps } from '../web/src/gen/overlap.js';
import { currentConflicts, moveConflicts, generate } from '../web/src/gen/core.js';
import { rankCandidates } from '../server/candidates.js';
import { mergeSettings } from '../server/export/settings.js';
import { classSheet, teacherSheet } from '../server/export/data.js';
import { parseLoadRows } from '../server/export/loadsImport.js';
import { teachersOf, isSecondOnly } from '../shared/cellTeachers.js';

test('이 칸의 교사들: 첫째+둘째 · 둘째 없으면 하나 · 같은 사람은 한 번', () => {
  assert.deepEqual(teachersOf({ membership_id: 7, second_membership_id: 8 }), [7, 8]);
  assert.deepEqual(teachersOf({ membership_id: 7 }), [7]);
  assert.deepEqual(teachersOf({ membership_id: 7, second_membership_id: 7 }), [7]);
  assert.deepEqual(teachersOf({ membership_id: null, second_membership_id: 8 }), [8]);
  assert.equal(isSecondOnly({ membership_id: 7, second_membership_id: 8 }, 8), true);
});

// 1반: 교사 7 단독 · 2반: 교사 8 + 둘째 7 — 같은 시각이라 7 이 겹친다
const pair = [
  { classroom_id: 1, weekday: 1, period: 2, subject_id: 4, membership_id: 7 },
  { classroom_id: 2, weekday: 1, period: 2, subject_id: 5, membership_id: 8, second_membership_id: 7 },
];

test('겹침 경고: 둘째 교사로 든 칸도 겹침 · 서버=화면 · 문구에 「둘째 교사」', () => {
  for (const f of [serverOverlaps, webOverlaps]) {
    const out = f(pair, {}).filter((x) => x.rule === 'teacher_overlap');
    assert.equal(out.length, 1, '교사 7 겹침 하나');
    assert.equal(String(out[0].membership_id), '7');
    assert.equal(out[0].second, true);
    assert.match(out[0].detail, /둘째 교사/);
  }
  // 둘째 교사가 없으면 겹침 아님(대조)
  const plain = pair.map(({ second_membership_id, ...c }) => c);
  assert.equal(serverOverlaps(plain, {}).filter((x) => x.rule === 'teacher_overlap').length, 0);
});

test('수정 모드 칸 색: 둘째 교사 겹침(시각 정보 없는 판 · 옮겨서 생기는 겹침)', () => {
  const now = currentConflicts(pair, { 1: { L: 0 }, 2: { L: 0 } });
  assert.deepEqual(now.get('2:1:2'), [{ rule: 'teacher_overlap' }]);
  // 1반 교사 7 칸을 3교시에 두고, 2교시로 옮기면 2반(둘째 7)과 겹친다
  const cells = [{ ...pair[0], period: 3 }, pair[1]];
  const mv = moveConflicts(cells, { 1: { L: 0, P: 6 }, 2: { L: 0, P: 6 } }, { classroom_id: 1, weekday: 1, period: 3 }, { classroom_id: 1, weekday: 1, period: 2 });
  assert.ok(mv.some((x) => x.rule === 'teacher_overlap'));
});

test('보결 후보: 그 시간 둘째 교사로 수업 중이면 빠진다(전담·담임 둘 다)', () => {
  const members = [
    { id: 7, name: '가전담', duty: '전담', homeroom: null },
    { id: 9, name: '나담임', duty: '담임', homeroom: { id: 3, grade: 3 } },
    { id: 8, name: '다전담', duty: '전담', homeroom: null }, // 나담임 반에서 그 시간 수업 중(늘 빠짐)
  ];
  const ctx = (cells) => ({ weekday: 1, period: 2, periodConfig: { grades: { 3: { periods: 6 } } }, cells, members, absentIds: new Set(), pins: [], takenIds: new Set(), exclude: new Set() });
  const base = [{ classroom_id: 3, weekday: 1, period: 2, subject_id: 5, membership_id: 8 }]; // 나담임 반에 전담 8 수업 중 → 나담임 A
  const before = rankCandidates(ctx([...base, { classroom_id: 1, weekday: 1, period: 1, subject_id: 4, membership_id: 7 }]));
  assert.deepEqual(before.candidates.map((c) => c.membership_id).sort(), [7, 9], '둘째 교사 칸이 없으면 둘 다 후보');
  const after = rankCandidates(ctx([...base, { classroom_id: 1, weekday: 1, period: 2, subject_id: 4, membership_id: 8, second_membership_id: 7 }, { classroom_id: 2, weekday: 1, period: 2, subject_id: 4, membership_id: 6, second_membership_id: 9 }]));
  assert.deepEqual(after.candidates.map((c) => c.membership_id), [], '둘째로 수업 중인 두 분 다 빠짐');
  assert.deepEqual(after.excluded.filter((x) => x.membership_id !== 8).map((x) => [x.membership_id, x.code]), [[7, 'teaching'], [9, 'teaching']]);
});

test('출력: 칸에 이름 둘(첫째·둘째) · 둘째 교사 시간표에도 그 칸', () => {
  const data = {
    tt: { id: 1, term_id: 1, name: '확정', status: '확정' },
    classrooms: [{ id: 1, grade: 3, class_no: 1 }],
    subjects: [{ id: 2, name: '영어', short_name: '영' }],
    teachers: [{ id: 1, name: '김영어', duty: '전담' }, { id: 2, name: '박원어민', duty: '전담' }],
    rooms: [],
    cells: [{ classroom_id: 1, weekday: 1, period: 1, subject_id: 2, membership_id: 1, second_membership_id: 2, special_room_id: null }],
    periodConfig: { grades: { 3: { periods: 6 } } },
  };
  const st = mergeSettings({});
  const text = JSON.stringify(classSheet(data, st, data.classrooms[0]).rows[0][1]);
  assert.match(text, /김영어·박원어민/);
  const sec = JSON.stringify(teacherSheet(data, st, data.teachers[1]).rows[0][1]);
  assert.match(sec, /영/, '둘째 교사 시간표에 그 칸이 든다');
});

test('엑셀 읽기: 「둘째 교사」·「함께 시수」 열 · 못 찾음·같은 분·시수 넘침은 사유', () => {
  const classrooms = [{ id: 1, grade: 3, class_no: 1 }];
  const subjects = [{ id: 7, name: '영어', short_name: null }];
  const people = [{ membership_id: 5, name: '김영어', login_id: 'k' }, { membership_id: 6, name: '박원어민', login_id: 'p' }];
  const HEAD = ['교사', '교과', '학년', '반', '주당 시수', '연강', '둘째 교사', '함께 시수'];
  const r = parseLoadRows([HEAD,
    ['김영어', '영어', '3', '1', '3', '', '박원어민', '2'],
    ['김영어', '영어', '3', '1', '3', '', '박원어민', ''],
    ['김영어', '영어', '3', '1', '3', '', '없는분', ''],
    ['김영어', '영어', '3', '1', '3', '', '김영어', ''],
    ['김영어', '영어', '3', '1', '3', '', '박원어민', '9'],
    ['김영어', '영어', '3', '1', '3', '', '', ''],
  ], { people, classrooms, subjects });
  assert.deepEqual([r[0].ok, r[0].membership_id, r[0].second_membership_id, r[0].second_hours], [true, 5, 6, 2]);
  assert.deepEqual([r[1].second_membership_id, r[1].second_hours], [6, null], '함께 시수 비우면 전부(null)');
  assert.match(r[2].reason, /둘째 교사를 찾지 못함/);
  assert.match(r[3].reason, /첫째 교사와 같음/);
  assert.match(r[4].reason, /함께 시수가 주당 시수보다 큼/);
  assert.equal(r[5].second_membership_id, undefined, '둘째 칸이 비면 그 키가 없다');
  // 둘째 교사 열이 없는 옛 파일도 그대로 읽힌다
  const old = parseLoadRows([['교사', '교과', '학년', '반', '시수'], ['김영어', '영어', '3', '1', '2']], { people, classrooms, subjects });
  assert.deepEqual([old[0].ok, old[0].membership_id, old[0].second_membership_id], [true, 5, undefined]);
});

// 생성기: 하루 5교시 × 5일 = 25칸, 점심 없음
const genBase = (lines, pins = []) => ({
  classrooms: [{ id: 1, grade: 1 }, { id: 2, grade: 1 }], periods: { grades: { 1: { periods: 5, lunchAfter: 0 } } }, days: 5, lines, pins,
});
const teacherClash = (cells) => serverOverlaps(cells, {}).filter((x) => x.rule === 'teacher_overlap');

test('생성기: 두 교사 다 빈 칸에만 놓는다(둘째 교사가 다른 반을 20시간 가르침)', () => {
  const r = generate(genBase([
    { classroom_id: 2, membership_id: 'B', subject_id: 'X', weekly_hours: 20 },
    { classroom_id: 1, membership_id: 'A', second_membership_id: 'B', subject_id: 'E', weekly_hours: 5 },
  ]), { k: 2, perMs: 500 }).candidates[0];
  assert.equal(r.hard, 0, '다 놓임');
  const two = r.cells.filter((c) => c.classroom_id === 1);
  assert.equal(two.length, 5);
  assert.ok(two.every((c) => c.second_membership_id === 'B'), '함께 시수 비면 전부 둘째 교사');
  assert.deepEqual(teacherClash(r.cells), [], '교사 B 가 같은 시각 두 반에 없다');
});

test('생성기: 둘째 교사 금지 칸에 안 놓음 · 함께 시수만큼만 붙음', () => {
  const pins = [1, 2, 3, 4, 5].map((p) => ({ target_kind: '교사', target_id: 'B', kind: '금지', weekday: 1, period: p })); // B 는 월요일 전부 안 됨
  const r = generate(genBase([{ classroom_id: 1, membership_id: 'A', second_membership_id: 'B', second_hours: 2, subject_id: 'E', weekly_hours: 4 }], pins), { k: 1, perMs: 300 }).candidates[0];
  assert.equal(r.hard, 0);
  const sec = r.cells.filter((c) => c.second_membership_id === 'B');
  assert.equal(sec.length, 2, '함께 시수 2만큼만');
  assert.ok(sec.every((c) => c.weekday !== 1), '둘째 교사 금지 칸(월)에 둘째로 든 칸 없음');
  assert.deepEqual(r.warnings.filter((w) => w.rule === 'second_block'), []);
});

test('생성기: 연강은 쪼개지 않고 통째로 둘째 교사를 붙이고 second_block 알림(막지 않음)', () => {
  const r = generate(genBase([{ classroom_id: 1, membership_id: 'A', second_membership_id: 'B', second_hours: 1, subject_id: 'E', weekly_hours: 4, block: 2 }]), { k: 1, perMs: 300 }).candidates[0];
  assert.equal(r.hard, 0);
  const sec = r.cells.filter((c) => c.second_membership_id === 'B');
  assert.equal(sec.length, 2, '함께 시수 1 이어도 2연강 한 묶음 통째');
  assert.equal(sec[0].weekday, sec[1].weekday);
  assert.equal(Math.abs(sec[0].period - sec[1].period), 1);
  const w = r.warnings.filter((x) => x.rule === 'second_block');
  assert.equal(w.length, 1);
  assert.deepEqual([w[0].hours, w[0].second_hours], [2, 1]);
});
