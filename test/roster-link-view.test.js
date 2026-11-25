// T-1302b② 명단 계정 연결 화면의 순수 계산
import test from 'node:test';
import assert from 'node:assert/strict';
import { accountColumnShown, freeLineOptions, warningLines, needsConfirm, daysLeft, dateText } from '../web/src/admin/linkView.js';

test('계정 열은 연결된 계정이 둘 이상일 때만', () => {
  assert.equal(accountColumnShown([]), false);
  assert.equal(accountColumnShown([{ hasAccount: true }, { hasAccount: false }]), false);
  assert.equal(accountColumnShown([{ hasAccount: true }, { hasAccount: true }]), true);
});
test('연결할 줄은 계정 없는 줄만', () => {
  assert.deepEqual(freeLineOptions([{ id: 1, name: 'a', hasAccount: true }, { id: 2, name: 'b', hasAccount: false }]), [{ value: '2', label: 'b' }]);
});
test('경고 글과 409 판별', () => {
  assert.deepEqual(warningLines({ warnings: [{ code: 'name', text: 'x' }, { code: 'birth', text: 'y' }] }), ['x', 'y']);
  assert.deepEqual(warningLines(null), []);
  assert.equal(needsConfirm({ status: 409, body: { needConfirm: true } }), true);
  assert.equal(needsConfirm({ status: 409, body: { code: 'roster.err.line_taken' } }), false);
  assert.equal(needsConfirm({ status: 400, body: { needConfirm: true } }), false);
});
test('남은 날은 올림 · 0 아래로 안 내려감', () => {
  const now = Date.parse('2026-11-25T00:00:00Z');
  assert.equal(daysLeft('2026-12-25T00:00:00Z', now), 30);
  assert.equal(daysLeft('2026-11-25T01:00:00Z', now), 1);
  assert.equal(daysLeft('2026-11-01T00:00:00Z', now), 0);
});
test('날짜 글자', () => {
  assert.equal(dateText(new Date(2026, 11, 5, 12).toISOString()), '2026-12-05');
});
