// 기관 설정 secondTeacher(T-1216) — 둘째 교사를 학교가 어떻게 다룰지 두 스위치. DB 없이 본다.
// inSubstitute: 하루 결강에 둘째 교사 칸을 넣나(기본 켬) · inSoftScore: 자동 생성 권장 점수가 둘째 교사 칸을 세나(기본 끔)
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, mergeConfig } from '../server/orgConfig.js';
import { DEFAULTS as WEB_DEFAULTS, mergeConfig as webMerge } from '../web/src/orgConfig.js';
import { readFileSync } from 'node:fs';
import { makeSoftScore } from '../web/src/gen/soft-adapter.js';

test('기본값은 지금 동작 그대로: 보결 켬 · 점수 끔 · 서버=화면', () => {
  assert.deepEqual(DEFAULTS.secondTeacher, { inSubstitute: true, inSoftScore: false });
  assert.deepEqual(WEB_DEFAULTS.secondTeacher, DEFAULTS.secondTeacher);
  assert.deepEqual(mergeConfig({}).secondTeacher, DEFAULTS.secondTeacher);
  assert.deepEqual(mergeConfig({ secondTeacher: { inSoftScore: true } }).secondTeacher, { inSubstitute: true, inSoftScore: true });
  assert.deepEqual(webMerge({ secondTeacher: { inSubstitute: false } }).secondTeacher, { inSubstitute: false, inSoftScore: false });
  assert.deepEqual(webMerge(null).secondTeacher, DEFAULTS.secondTeacher);
});

test('보결: 하루 결강 질의가 설정(둘째 교사 포함 여부)을 값으로 받는다 · 기본은 켬(옛 질의와 같은 범위)', () => {
  // DB 없이는 질의를 못 돌려 글을 본다 — 켬이면 `OR (true AND 둘째)` = 옛 `OR 둘째`, 끔이면 둘째 항이 꺼진다. 실제 DB 경로는 small-school-walk 몫
  const src = readFileSync(new URL('../server/routes/substitute.js', import.meta.url), 'utf8');
  assert.match(src, /c\.membership_id = \$3 OR \(\$5::boolean AND c\.second_membership_id = \$3\)/);
  assert.match(src, /secondTeacher\.inSubstitute !== false/);
});

// 교사 10 이 월요일 1·2·3교시를 둘째 교사로만 든다(연강 3). 첫째 교사는 11.
const input = (extra = {}) => ({
  classrooms: [{ id: 1, grade: 1 }], periods: { grades: { 1: { periods: 6, lunchAfter: 4 } } },
  params: { maxConsec: 1 }, ...extra,
});
const cells = [1, 2, 3].map((p) => ({ classroom_id: 1, weekday: 1, period: p, subject_id: 5, membership_id: 11, second_membership_id: 10 }));
const alone = [1, 2, 3].map((p) => ({ classroom_id: 1, weekday: 1, period: p, subject_id: 5, membership_id: 11 }));

test('권장 점수: 끄면(기본) 둘째 교사 칸이 점수에 안 들어간다 · 켜면 점수가 달라진다', () => {
  const off = makeSoftScore(input())({ cells });
  const on = makeSoftScore(input({ secondInSoft: true }))({ cells });
  assert.equal(off, makeSoftScore(input())({ cells: alone }), '기본 = 둘째 교사가 없는 것과 같은 점수');
  assert.equal(off, makeSoftScore(input({ secondInSoft: false }))({ cells }));
  assert.ok(on > off, `켜면 점수가 달라진다(켬 ${on} > 끔 ${off})`);
  assert.equal(makeSoftScore(input({ secondInSoft: true }))({ cells: alone }), off, '둘째 교사가 없으면 켜도 같다');
});
