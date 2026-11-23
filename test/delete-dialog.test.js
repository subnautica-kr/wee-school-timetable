// 지우기 창 — 확인 글자가 틀리면 단추가 꺼져 있다 · 수 0 인 줄은 숨긴다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmReady, effectLines } from '../web/src/deleteDialog.js';

test('확인 글자: 같을 때만 켜진다(앞뒤 공백은 봐줌)', () => {
  assert.equal(confirmReady('', '2026년 1학기'), false);
  assert.equal(confirmReady('2026년 2학기', '2026년 1학기'), false);
  assert.equal(confirmReady(' 2026년 1학기 ', '2026년 1학기'), true);
  assert.equal(confirmReady('아무거나', ''), false); // 비교할 글자가 없으면 켜지 않는다
});
test('영향 줄: 수 0 은 숨기고 기관 삭제 counts 도 읽는다', () => {
  assert.deepEqual(effectLines({ effects: [{ label: '시간표 칸', count: 12 }, { label: '보결', count: 0 }] }), ['시간표 칸 12개']);
  const l = effectLines({ counts: { accounts: 3, concurrentKept: 1, classrooms: 0, terms: 2 } });
  assert.ok(l.includes('이 기관에서만 쓰던 계정 3개') && l.includes('학기 2개') && l.length === 3);
});

import { deleteOrgBlock, kindTag } from '../web/src/deleteDialog.js';
test('기관 지우기: 사용 중이면 먼저 중지하라고 알리고 중지된 기관은 통과', () => {
  assert.match(deleteOrgBlock({ name: 'A초', status: '사용' }), /먼저 「중지」/);
  assert.equal(deleteOrgBlock({ name: 'A초', status: '중지' }), null);
});
test('보관함 종류 글자: 이름이 이미 반으로 끝나면 겹치지 않는다', () => {
  assert.equal(kindTag('1학년 1반', 'classroom'), '');
  assert.equal(kindTag('수학', 'subject'), '교과');
});
