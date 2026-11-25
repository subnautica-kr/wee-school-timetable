// 빠른 시작 상자 첫 값 — 학교 기본 교시 수가 먼저, 없으면 예전 고정값 (T-1305) · 정적 시험(웹 시험 틀 없음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { quickPeriods } from '../web/src/grid/quickDefaults.js';

test('학교 값이 있으면 그 값, 없는 학년은 고정값', () => {
  assert.deepEqual(quickPeriods(null), { 1: 5, 2: 5, 3: 6, 4: 6, 5: 6, 6: 6 });
  assert.deepEqual(quickPeriods({}), { 1: 5, 2: 5, 3: 6, 4: 6, 5: 6, 6: 6 });
  const r = quickPeriods({ grades: { 1: { periods: 4 }, 3: { periods: 7 }, 6: { periods: 99 } } });
  assert.deepEqual(r, { 1: 4, 2: 5, 3: 7, 4: 6, 5: 6, 6: 6 });
});

test('QuickStart 가 학교 기본을 읽어 상자를 채운다', () => {
  const src = readFileSync(new URL('../web/src/grid/Grid.jsx', import.meta.url), 'utf8');
  const q = src.slice(src.indexOf('function QuickStart'), src.indexOf('export default function Grid'));
  assert.match(q, /school\/periods/);
  assert.match(q, /setPer\(quickPeriods\(/);
});
