import test from 'node:test';
import assert from 'node:assert/strict';
import { teacherNames, teacherClashes, clashText, isSecondMark } from '../web/src/grid/secondTeacher.js';
import { genNoteTexts } from '../web/src/generate/genNotes.js';

const teachers = [{ id: 1, name: '가' }, { id: 2, name: '나' }, { id: '3', name: '다' }];

test('칸의 이름들 — 첫째·둘째 순서, 둘째 없으면 하나(예전과 같음)', () => {
  assert.deepEqual(teacherNames({ membership_id: 1, second_membership_id: 2 }, teachers), ['가', '나']);
  assert.deepEqual(teacherNames({ membership_id: 1, second_membership_id: null }, teachers), ['가']);
  assert.deepEqual(teacherNames({ membership_id: 3 }, teachers), ['다']);
  assert.deepEqual(teacherNames({ membership_id: 1, second_membership_id: 1 }, teachers), ['가']);
  assert.deepEqual(teacherNames({}, teachers), []);
});

test('같은 시각 다른 반 칸에 든 교사 경고 — 첫째든 둘째든, 같은 칸은 제외', () => {
  const cells = [
    { classroom_id: 10, weekday: 1, period: 2, membership_id: 1 },
    { classroom_id: 11, weekday: 1, period: 2, membership_id: 5, second_membership_id: 2 },
    { classroom_id: 12, weekday: 1, period: 3, membership_id: 2 },
  ];
  const pick = { classroom_id: 20, weekday: 1, period: 2, membership_id: 3, second_membership_id: 2 };
  assert.deepEqual(teacherClashes(cells, pick), [{ membership_id: 2, classroom_id: 11 }]);
  assert.deepEqual(teacherClashes(cells, { ...pick, classroom_id: 10, membership_id: 1, second_membership_id: null }), []);
  assert.deepEqual(teacherClashes(cells, { ...pick, second_membership_id: null, membership_id: 3 }), []);
  assert.equal(clashText(teacherClashes(cells, pick), (id) => teachers.find((t) => t.id === id)?.name, () => '2-1'), '나 선생님은 같은 시각 2-1에 이미 들어 있습니다');
});

test('내 시간표 둘째 표시는 서버 second === true 일 때만', () => {
  assert.equal(isSecondMark({ second: true }), true);
  assert.equal(isSecondMark({ second: false }), false);
  assert.equal(isSecondMark({}), false);
});

test('생성 알림 second_block 문구 — 모르는 코드·없음은 빈 목록', () => {
  assert.equal(genNoteTexts({ warnings: [{ rule: 'second_block' }, { rule: 'second_block' }] }).length, 1);
  assert.match(genNoteTexts({ warnings: [{ rule: 'second_block' }] })[0], /연강 묶음째/);
  assert.deepEqual(genNoteTexts({ warnings: [{ rule: 'x' }], alerts: [{ code: 'second_block' }] }), []);
  assert.deepEqual(genNoteTexts(undefined), []);
});
