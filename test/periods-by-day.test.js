// 요일별 교시 수(T-1205 · 선생님 요청 9번) — 한 함수 periodsOn 을 거치는지, 옛 자료는 그대로인지
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { periodsOn, periodsMax, weekPeriods, overHours, outsideCells } from '../shared/periods.js';
import { prepare, moveConflicts } from '../web/src/gen/core.js';
import { periodsOf } from '../server/orgConfig.js';
import { emptyCount, confirmText } from '../shared/ttConfirm.js';

const src = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const cfg = { grades: { 1: { periods: 5, byDay: { 2: 4, 4: 4 } }, 3: { periods: 6, byDay: { 3: 4 } }, 5: { periods: 6 } } };

test('periodsOn: 요일별 값 → 학년 값 → fallback · 옛 자료는 그대로', () => {
  assert.equal(periodsOn(cfg, 1, 1), 5);
  assert.equal(periodsOn(cfg, 1, 2), 4);
  assert.equal(periodsOn(cfg, '1', '4'), 4); // 키가 글자여도
  assert.equal(periodsOn(cfg, 3, 3), 4);
  assert.equal(periodsOn(cfg, 5, 3), 6); // byDay 없는 학년
  assert.equal(periodsOn(cfg, 1, null), 5); // 요일 모르면 학년 값
  assert.equal(periodsOn({}, 2, 1), 5);
  assert.equal(periodsOn(null, 2, 1, 0), 0);
  assert.equal(periodsMax(cfg, 3), 6);
  assert.equal(periodsMax({ grades: { 1: { periods: 4, byDay: { 1: 6 } } } }, 1), 6); // 한 날만 긴 학교
  assert.equal(weekPeriods(cfg, 1), 23);
  assert.equal(weekPeriods(cfg, 3, ['월', '화', '수', '목', '금']), 28);
  assert.equal(periodsOf(cfg, 1, 6), 5);
  assert.equal(periodsOf({ grades: { 1: { periods: 4, byDay: { 1: 6 } } } }, 1, 9), 6); // 출력물 줄 수 = 가장 긴 날
});

test('생성 재료: 반마다 요일별 교시(PD) · 없으면 다섯 날 같은 값', () => {
  const p = prepare({ classrooms: [{ id: 1, grade: 1 }, { id: 2, grade: 5 }], lines: [], periods: cfg, pins: [], subjects: [], teachers: [], rooms: [] });
  assert.deepEqual(p.classes[0].PD, [5, 4, 5, 4, 5]);
  assert.equal(p.classes[0].P, 5);
  assert.deepEqual(p.classes[1].PD, [6, 6, 6, 6, 6]);
  assert.match(src('web/src/gen/core.js'), /k\.PD\[d\]/); // 칸 판정은 그날 값
});

test('수정 격자: 그날 교시 수 밖으로 옮기면 범위 밖 알림', () => {
  const info = { 1: { L: 0, P: 5, PW: { 1: 5, 2: 4 } } };
  const cells = [{ classroom_id: 1, weekday: 1, period: 5, subject_id: 1 }];
  assert.ok(moveConflicts(cells, info, { classroom_id: 1, weekday: 1, period: 5 }, { classroom_id: 1, weekday: 2, period: 5 }).some((x) => x.rule === 'out_of_range'));
  assert.ok(!moveConflicts(cells, info, { classroom_id: 1, weekday: 1, period: 5 }, { classroom_id: 1, weekday: 3, period: 5 }).some((x) => x.rule === 'out_of_range'));
});

test('시수 합 > 요일별 교시 합은 알림만(막지 않음) · 교시 수 밖 칸은 세어 알린다', () => {
  const cls = [{ id: 1, grade: 1, class_no: 1 }, { id: 2, grade: 5, class_no: 1 }];
  const over = overHours(cls, [{ classroom_id: 1, weekly_hours: 20 }, { classroom_id: 1, weekly_hours: 4 }, { classroom_id: 2, weekly_hours: 30 }], cfg);
  assert.deepEqual(over, [{ classroom_id: 1, grade: 1, class_no: 1, hours: 24, cap: 23 }]);
  const cells = [{ classroom_id: 1, weekday: 2, period: 5, subject_id: 1 }, { classroom_id: 1, weekday: 1, period: 5, subject_id: 1 }];
  assert.equal(outsideCells(cls, cfg, cells).length, 1);
  assert.equal(emptyCount([cls[0]], cfg, cells), 22); // 23 칸 - 안쪽 채운 1
  assert.match(confirmText('A', '2026-03-02', 0, 22, 1), /교시 수 밖에 있는 칸 1칸/);
});

test('교시 수를 묻는 곳은 periodsOn/periodsMax 를 거친다(직접 읽기 0)', () => {
  for (const f of ['server/candidates.js', 'shared/ttConfirm.js', 'web/src/gen/core.js', 'web/src/generate/AutoGen.jsx', 'web/src/grid/Grid.jsx', 'web/src/school/SchoolPage.jsx', 'server/export/data.js', 'server/routes/school.js']) {
    assert.doesNotMatch(src(f), /grades\??\.\[[^\]]+\]\??\.periods\b|g\.periods\b|\bx\?\.periods\b/, f);
  }
  assert.match(src('server/routes/school.js'), /byDay: z\.record/); // 스키마가 버리지 않는다
});
