// T-1327a 생성기 뒷손 — 방 때문에 못 놓음 알림(후보 방 하나여도) · 연강 통째 문구 · 정원 안 겹침은 room_overlap 아님
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../web/src/gen/core.js';
import { genNoteTexts } from '../web/src/generate/genNotes.js';
import { findOverlaps } from '../shared/overlap.js';

const classrooms = [1, 2, 3].map((id) => ({ id, grade: 3, class_no: id }));
const mk = (n, rooms, extra = {}) => ({ classrooms: classrooms.slice(0, n), periods: { grades: { 3: { periods: 1, lunchAfter: 0 } } }, days: 1, rooms,
  lines: classrooms.slice(0, n).map((c) => ({ classroom_id: c.id, membership_id: 100 + c.id, subject_id: 1, special_room_id: 10, weekly_hours: 1, ...extra })), pins: [] });

test('방 하나(후보 방 없음)에 못 놓은 수업도 room_pool_full 을 낸다', () => {
  const r = generate(mk(2, [{ id: 10, name: '과학실', capacity: 1 }]), { k: 1, perMs: 300 }).candidates[0];
  assert.equal(r.unplaced.length, 1);
  assert.ok(r.warnings.some((w) => w.rule === 'room_pool_full'));
});

test('정원 2 방에 두 반이 든 시안은 겹침 0 · 정원 3 반이면 room_overlap', () => {
  const r = generate(mk(2, [{ id: 10, name: '과학실', capacity: 2 }]), { k: 1, perMs: 300 }).candidates[0];
  assert.equal(r.unplaced.length, 0);
  assert.equal(r.cells.filter((c) => c.special_room_id === 10).length, 2);
  const ctx = { roomCap: { 10: 2 }, studentOf: {}, capCount: 'classes' };
  assert.deepEqual(findOverlaps(r.cells, ctx), []);
  assert.deepEqual(findOverlaps(r.cells, { ...ctx, capCount: 'students' }), []);
  const three = [1, 2, 3].map((c) => ({ classroom_id: c, weekday: 1, period: 1, special_room_id: 10, membership_id: 100 + c }));
  assert.deepEqual(findOverlaps(three, ctx).map((x) => x.rule).sort(), ['room_capacity', 'room_overlap']);
  assert.deepEqual(findOverlaps(three, { roomCap: {}, studentOf: {} }).map((x) => x.rule), ['room_overlap']); // 정원 없음 = 1
  assert.deepEqual(findOverlaps(three.slice(0, 2), { roomCap: { 10: 0 }, studentOf: {} }).map((x) => x.rule), ['room_overlap']); // 정원 0 = 1
});

test('연강이라 방 사용 시수보다 더 붙이면 room_block_whole 문구가 걸린다', () => {
  const input = { classrooms: [classrooms[0]], periods: { grades: { 3: { periods: 6, lunchAfter: 0 } } }, days: 5, rooms: [{ id: 10, name: '과학실' }],
    lines: [{ classroom_id: 1, membership_id: 101, subject_id: 1, special_room_id: 10, weekly_hours: 2, room_hours: 1, block: 2 }], pins: [] };
  const c = generate(input, { k: 1, perMs: 300 }).candidates[0];
  assert.ok(c.warnings.some((w) => w.rule === 'room_block_whole'));
  const texts = genNoteTexts(c);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /1시간 더 방을 붙였어요/);
  assert.match(genNoteTexts({ warnings: [{ rule: 'room_block_whole', hours: 3, room_hours: 1 }, { rule: 'room_block_whole', hours: 2, room_hours: 1 }] })[0], /3시간 더/);
});
