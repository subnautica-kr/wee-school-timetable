// T-1321② 생년월일 숫자 8자리 꼴 함수
import test from 'node:test';
import assert from 'node:assert/strict';
import { digitsOnly, isBirth8, showBirth } from '../web/src/signup/birth.js';

const today = new Date(2026, 10, 25);

test('8자리 숫자만 통과', () => {
  assert.equal(isBirth8('19900101', today), true);
  for (const bad of ['1990-01-01', '1990010', '199001011', '', 'abcdefgh', null, undefined, 19900101]) assert.equal(isBirth8(bad, today), false, String(bad));
});
test('없는 날짜·범위 밖은 거절', () => {
  for (const bad of ['19900230', '19901301', '19900001', '19900100', '18991231', '20261126', '20230229']) assert.equal(isBirth8(bad, today), false, bad);
  assert.equal(isBirth8('20000229', today), true);
  assert.equal(isBirth8('20261125', today), true);
});
test('digitsOnly 는 숫자만 남기고 8자리로 자른다', () => {
  assert.equal(digitsOnly('1990-01-01'), '19900101');
  assert.equal(digitsOnly('１９９００１０１'), '19900101');
  assert.equal(digitsOnly('199001011234'), '19900101');
  assert.equal(digitsOnly(null), '');
});
test('showBirth', () => {
  assert.equal(showBirth('19900101'), '1990-01-01');
  assert.equal(showBirth('123'), '123');
});
