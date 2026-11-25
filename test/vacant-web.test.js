import test from 'node:test';
import assert from 'node:assert/strict';
import { findPerson, withCurrent } from '../web/src/grid/vacant.js';
import { teacherNames } from '../web/src/grid/secondTeacher.js';
import { t } from '../shared/text/index.js';

const teachers = [{ id: 1, name: '가' }, { id: 2, name: '나' }];
const inactive = [{ id: 9, name: '휴직자', status: '휴직' }];

test('이름 찾기 — teachers 에 없으면 inactive_teachers 에서 찾는다', () => {
  assert.deepEqual(findPerson(1, teachers, inactive), { name: '가', vacant: false });
  assert.deepEqual(findPerson('9', teachers, inactive), { name: '휴직자', status: '휴직', vacant: true });
  assert.equal(findPerson(77, teachers, inactive), null);
  assert.equal(findPerson(null, teachers, inactive), null);
  assert.equal(findPerson(9, teachers, undefined), null);
});

test('칸 이름 — 재직 아닌 선생님은 「이름 (담당 비었음)」, 둘째도 같다', () => {
  const mark = t('grid.vacant.mark');
  assert.equal(mark, '담당 비었음');
  assert.deepEqual(teacherNames({ membership_id: 9 }, teachers, inactive, mark), ['휴직자 (담당 비었음)']);
  assert.deepEqual(teacherNames({ membership_id: 1, second_membership_id: 9 }, teachers, inactive, mark), ['가', '휴직자 (담당 비었음)']);
  assert.deepEqual(teacherNames({ membership_id: 9 }, teachers), []); // 예전 호출은 그대로
});

test('고르는 목록 — 현재 값이 재직 아닌 선생님일 때만 비활성 항목 하나, 그 밖엔 그대로', () => {
  const opts = teachers.map((x) => ({ value: String(x.id), label: x.name }));
  const lab = (x) => `${x.name}!`;
  const got = withCurrent(opts, 9, inactive, lab);
  assert.deepEqual(got.at(-1), { value: '9', label: '휴직자!', disabled: true });
  assert.equal(got.length, 3);
  assert.equal(withCurrent(opts, 1, inactive, lab), opts);
  assert.equal(withCurrent(opts, null, inactive, lab), opts);
  assert.equal(withCurrent(opts, 55, inactive, lab), opts);
});
