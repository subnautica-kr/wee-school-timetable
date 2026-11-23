// T-1204f — 화면 눈 확인에서 깨진 셋: 접미사 숫자 칸 변환 · 시수 PATCH 입력 오류 코드 · 명단 「반」 열/담임 빠짐 계산
import test from 'node:test';
import assert from 'node:assert/strict';
import { numOfText } from '../web/src/school/numberText.js';
import { homeroomView } from '../web/src/admin/homeroomView.js';
import { smallSchool, seedPeople, seedStructure } from './fixtures/schools.js';
import { setupSchoolEnv, HAS_DB } from './fixtures/school-env.js';

test('접미사가 붙은 칸 글자 → 숫자: 「4교시 뒤」는 4(NaN·null 이 아니다) · 빈 칸은 null', () => {
  assert.equal(numOfText('4교시 뒤'), 4);
  assert.equal(numOfText('2시수'), 2);
  assert.equal(numOfText('0교시 뒤'), 0);
  assert.equal(numOfText(' 12 '), 12);
  assert.equal(numOfText(''), null);
  assert.equal(numOfText('교시 뒤'), null);
  assert.equal(numOfText(undefined), null);
});

test('명단 반 열·담임 빠짐: 한 사람 두 반 · 반 없는 담임 · 담임 없는 반', () => {
  const rows = [{ id: 1, name: '가', duty: '담임' }, { id: 2, name: '나', duty: '담임' }, { id: 3, name: '다', duty: '전담' }, { id: '4', name: '라', duty: '담임', listStatus: '숨김' }];
  const classes = [{ grade: 1, class_no: 1, homeroom_membership_id: '1' }, { grade: 2, class_no: 1, homeroom_membership_id: 1 }, { grade: 3, class_no: 1, homeroom_membership_id: null }];
  const v = homeroomView(rows, classes);
  assert.equal(v.byMember[1], '1-1·2-1');
  assert.deepEqual(v.noClass, ['나']); // 전담·숨김은 제외
  assert.deepEqual(v.noTeacher, ['3-1']);
  assert.deepEqual(homeroomView([], []), { byMember: {}, noClass: [], noTeacher: [] });
});

test('시수 PATCH: 숫자가 오면 200 으로 바뀐다 · null 은 「없습니다」 404 가 아니라 입력 오류 400 · 없는 줄은 404', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const { pool, orgId, tag, call, P } = await setupSchoolEnv(t, 'sf');
  const s = smallSchool();
  const mids = await seedPeople(pool, orgId, tag, s);
  await seedStructure(pool, orgId, s, mids);
  const line = (await call('GET', `${P}/loads`)).json.lines[0];
  const r = await call('PATCH', `${P}/loads/${line.id}`, { weekly_hours: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.json.weekly_hours, 2);
  assert.equal((await call('PATCH', `${P}/loads/${line.id}`, { weekly_hours: null })).status, 400);
  assert.equal((await call('PATCH', `${P}/loads/999999999`, { weekly_hours: 2 })).status, 404);
});
