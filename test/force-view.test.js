// T-1322b③ 전출·일괄 연결·마지막 관리자 경고 화면의 순수 계산
import test from 'node:test';
import assert from 'node:assert/strict';
import { isLastAdminErr, lastAdminText, withForce, forcePath, flaggedRows, bulkGroups, bulkRowsOf, transferNote, mergeBulkStatus } from '../web/src/admin/forceView.js';

const lastErr = { status: 409, body: { needConfirm: true, lastAdmin: true, warnings: [{ text: 'w1' }] } };

test('마지막 관리자 409 판별과 경고 글', () => {
  assert.equal(isLastAdminErr(lastErr), true);
  assert.equal(isLastAdminErr({ status: 409, body: { needConfirm: true } }), false);
  assert.equal(isLastAdminErr({ status: 400, body: { needConfirm: true, lastAdmin: true } }), false);
  assert.equal(lastAdminText(lastErr.body), 'w1');
  assert.equal(lastAdminText(null), '');
});
test('withForce: 경고면 묻고 확인하면 force 로 다시 · 거절이면 안 보냄', async () => {
  const calls = [];
  const fn = (force) => { calls.push(force); if (!force) throw lastErr; return 'ok'; };
  assert.equal(await withForce(async () => true, fn), 'ok');
  assert.deepEqual(calls, [false, true]);
  calls.length = 0;
  assert.equal(await withForce(async () => false, fn), undefined);
  assert.deepEqual(calls, [false]);
  await assert.rejects(withForce(async () => true, () => { throw new Error('x'); }), /x/);
  assert.equal(await withForce(async () => { throw new Error('no ask'); }, () => 'fine'), 'fine');
});
test('force 경로', () => {
  assert.equal(forcePath('/a', false), '/a');
  assert.equal(forcePath('/a', true), '/a?force=1');
  assert.equal(forcePath('/a?x=1', true), '/a?x=1&force=1');
});
test('여러 줄 결과의 깃발 줄과 합치기', () => {
  const first = { results: [{ ok: true, id: 1 }, { ok: false, id: 2, needConfirm: true, lastAdmin: true, warnings: [{ text: 'w' }] }, { ok: false, id: 3, error: 'e' }], changed: 1, failed: 2, homeroom: 1, classes: 0 };
  assert.deepEqual(flaggedRows(first.results), [{ id: 2, text: 'w' }]);
  const m = mergeBulkStatus(first, { results: [{ ok: true, id: 2 }], changed: 1, failed: 0, homeroom: 0, classes: 2 });
  assert.equal(m.changed, 2); assert.equal(m.failed, 1); assert.equal(m.classes, 2); assert.equal(m.results.length, 3);
});
test('일괄 연결 묶음·보낼 줄', () => {
  const g = bulkGroups([{ group: 'linked', index: 0 }, { group: 'pending', index: 1 }, { group: 'check', index: 2 }, { group: 'check', index: 3 }]);
  assert.deepEqual([g.linked.length, g.pending.length, g.check.length], [1, 1, 2]);
  assert.deepEqual(bulkRowsOf({ 5: ' abc ', 6: '', 7: '  ' }), [{ membershipId: 5, loginId: 'abc' }]);
});
test('학교 옮기기 안내', () => {
  assert.deepEqual(transferNote({ transferRequested: true, loginId: 'a', expiresAt: 'z' }), { kind: 'sent', loginId: 'a', expiresAt: 'z' });
  assert.equal(transferNote({ ok: true, autoApproved: true, loginId: 'a' }).kind, 'auto');
  assert.equal(transferNote({ ok: true }), null);
});
