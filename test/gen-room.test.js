// T-1312 자동 생성기 — 특별실 정원 · 묶음(아무 방) · 방 사용 시수 · 연강 통째
import test from 'node:test';
import assert from 'node:assert/strict';
import { HAS_DB, setup } from './sec-helpers.js';
import { generate } from '../web/src/gen/core.js';

const cls = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, grade: 3, class_no: i + 1 }));
const base = (n, periods, extra) => ({ classrooms: cls(n), periods: { grades: { 3: { periods, lunchAfter: 0 } } }, days: 1, pins: [], ...extra });
const run = (input) => generate(input, { k: 2, perMs: 300 }).candidates[0];
// 한 시각 한 방에 든 수업 수 > 정원 인 칸 수
const overCap = (cells, rooms) => {
  const cap = new Map(rooms.map((r) => [String(r.id), Math.max(1, Number(r.capacity) || 1)]));
  const by = new Map();
  for (const c of cells) if (c.special_room_id != null) { const k = `${c.special_room_id}:${c.weekday}:${c.period}`; by.set(k, (by.get(k) || 0) + 1); }
  return [...by].filter(([k, n]) => n > (cap.get(k.split(':')[0]) ?? 1)).length;
};

test('정원: 정원 1 방을 쓰는 두 교사는 같은 시각에 안 놓이고, 정원 3 방엔 세 반까지', () => {
  const rooms1 = [{ id: 10, name: '강당', capacity: null }];
  const lines = (n, room) => cls(n).map((c) => ({ classroom_id: c.id, membership_id: 100 + c.id, subject_id: 1, special_room_id: room, weekly_hours: 1 }));
  const one = run(base(2, 2, { rooms: rooms1, lines: lines(2, 10) }));
  assert.equal(one.unplaced.length, 0);
  assert.equal(overCap(one.cells, rooms1), 0);
  assert.notEqual(one.cells[0].period, one.cells[1].period);
  // 칸 1 개에 반 넷 · 정원 3 → 셋은 같은 칸, 하나는 못 놓음
  const rooms3 = [{ id: 10, name: '강당', capacity: 3 }];
  const three = run(base(4, 1, { rooms: rooms3, lines: lines(4, 10) }));
  assert.equal(three.cells.filter((c) => c.special_room_id === 10).length, 3);
  assert.equal(three.unplaced.length, 1);
  assert.equal(overCap(three.cells, rooms3), 0);
  // 정원 0 은 1 로 센다
  const zero = run(base(2, 1, { rooms: [{ id: 10, name: '강당', capacity: 0 }], lines: lines(2, 10) }));
  assert.equal(zero.unplaced.length, 1);
  // 특별실 금지 칸은 정원 자리 모두 막는다
  const pinned = run(base(2, 1, { rooms: rooms3, lines: lines(2, 10), pins: [{ target_kind: '특별실', target_id: 10, weekday: 1, period: 1, kind: '금지' }] }));
  assert.equal(pinned.unplaced.length, 2);
});

test('묶음: 묶음 방 중 하나에 들어가고, 묶음 전체 자리 = 정원 합 · 지운 방은 안 고른다 · 방이 이긴다', () => {
  const rooms = [{ id: 20, name: '과학실', capacity: 1 }, { id: 21, name: '실험실', capacity: 2 }, { id: 22, name: '음악실' }];
  const room_groups = [{ id: 5, room_ids: [20, 21, 99] }]; // 99 = 지워진 방(rooms 에 없음)
  const lines = cls(4).map((c) => ({ classroom_id: c.id, membership_id: 100 + c.id, subject_id: 2, room_group_id: 5, weekly_hours: 1 }));
  const r = run(base(4, 1, { rooms, room_groups, lines }));
  assert.equal(r.cells.length, 3); // 자리 1 + 2
  assert.equal(r.unplaced.length, 1);
  assert.ok(r.cells.every((c) => [20, 21].includes(c.special_room_id)));
  assert.equal(overCap(r.cells, rooms), 0);
  assert.ok(r.warnings.some((w) => w.rule === 'room_pool_full'));
  // 방과 묶음을 같이 보내면 방
  const both = run(base(1, 1, { rooms, room_groups, lines: [{ classroom_id: 1, membership_id: 1, subject_id: 2, special_room_id: 22, room_group_id: 5, weekly_hours: 1 }] }));
  assert.equal(both.cells[0].special_room_id, 22);
  // 빈 묶음이면 방 없이 놓는다
  const empty = run(base(1, 1, { rooms, room_groups: [{ id: 6, room_ids: [99] }], lines: [{ classroom_id: 1, membership_id: 1, subject_id: 2, room_group_id: 6, weekly_hours: 1 }] }));
  assert.equal(empty.cells[0].special_room_id, null);
});

test('방 사용 시수: 주 3·사용 2 면 칸 셋 중 둘에만 방 · 연강은 안 갈리고 통째 + room_block_whole', () => {
  const rooms = [{ id: 30, name: '과학실' }];
  const part = run(base(1, 5, { rooms, lines: [{ classroom_id: 1, membership_id: 1, subject_id: 3, special_room_id: 30, room_hours: 2, weekly_hours: 3 }] }));
  assert.equal(part.cells.length, 3);
  assert.equal(part.cells.filter((c) => c.special_room_id === 30).length, 2);
  assert.ok(!part.warnings.some((w) => w.rule === 'room_block_whole'));
  // 연강 2 · 사용 1 → 연강 두 칸 모두 방 + 알림
  const blk = run(base(1, 5, { rooms, lines: [{ classroom_id: 1, membership_id: 1, subject_id: 3, special_room_id: 30, room_hours: 1, weekly_hours: 2, block: 2 }] }));
  assert.equal(blk.cells.length, 2);
  assert.equal(blk.cells[1].period - blk.cells[0].period, 1); // 연강 붙음
  assert.deepEqual(blk.cells.map((c) => c.special_room_id), [30, 30]);
  assert.ok(blk.warnings.some((w) => w.rule === 'room_block_whole' && w.hours === 2 && w.room_hours === 1));
  // 사용 0 이면 방 없음
  const none = run(base(1, 5, { rooms, lines: [{ classroom_id: 1, membership_id: 1, subject_id: 3, special_room_id: 30, room_hours: 0, weekly_hours: 2 }] }));
  assert.ok(none.cells.every((c) => c.special_room_id === null));
});

test('작은 학교 한 바퀴: 특별실 섞인 재료로 생성 성공 · 정원 넘는 배치 0 · 특별실 안 넣은 기관은 그대로', () => {
  const rooms = [{ id: 40, name: '과학실', capacity: 1 }, { id: 41, name: '강당', capacity: 2 }, { id: 42, name: '컴퓨터실', capacity: 1 }];
  const room_groups = [{ id: 7, room_ids: [40, 42] }];
  const lines = [];
  for (const c of cls(4)) {
    lines.push({ classroom_id: c.id, membership_id: 100 + c.id, subject_id: 1, weekly_hours: 12 });
    lines.push({ classroom_id: c.id, membership_id: 200, subject_id: 2, special_room_id: 40, room_hours: 2, weekly_hours: 3 });
    lines.push({ classroom_id: c.id, membership_id: 201, subject_id: 3, special_room_id: 41, weekly_hours: 2, block: 2 });
    lines.push({ classroom_id: c.id, membership_id: 202, subject_id: 4, room_group_id: 7, weekly_hours: 2 });
  }
  const input = { classrooms: cls(4), periods: { grades: { 3: { periods: 5, lunchAfter: 0 } } }, rooms, room_groups, lines, pins: [] };
  const r = run(input);
  assert.equal(r.unplaced.length, 0);
  assert.equal(r.cells.length, 4 * 19);
  assert.equal(overCap(r.cells, rooms), 0);
  assert.equal(r.cells.filter((c) => c.subject_id === 2 && c.special_room_id === 40).length, 8);
  // 특별실 없는 기관: 방 칸 모두 비움
  const plain = run({ ...input, rooms: [], room_groups: [], lines: lines.map(({ special_room_id, room_group_id, room_hours, ...l }) => l) });
  assert.equal(plain.unplaced.length, 0);
  assert.ok(plain.cells.every((c) => c.special_room_id === null));
});

test('API: 생성 재료에 묶음(살아 있는 방만)·방 사용 시수가 실린다', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const f = await setup(t);
  const c = await f.as('adminA');
  const P = `/api/orgs/${f.orgA}`;
  const a = (await c.call('POST', `${P}/special-rooms`, { name: '과학1실', capacity: 2 })).json;
  const b = (await c.call('POST', `${P}/special-rooms`, { name: '과학2실' })).json;
  const g = await c.call('POST', `${P}/special-room-groups`, { name: '과학실 아무 방', room_ids: [Number(a.id), Number(b.id)] });
  assert.equal(g.status, 201);
  assert.equal((await c.call('DELETE', `${P}/special-rooms/${b.id}`)).status, 200);
  const cl = (await c.call('GET', `${P}/classrooms`)).json[0];
  const ld = await c.call('POST', `${P}/loads`, { classroom_id: Number(cl.id), room_group_id: g.json.id, room_hours: 1, weekly_hours: 3 });
  assert.equal(ld.status, 201);
  const gi = (await c.call('GET', `${P}/gen/input`)).json;
  const grp = gi.room_groups.find((x) => String(x.id) === String(g.json.id));
  assert.deepEqual(grp.room_ids.map(String), [String(a.id)]);
  const line = gi.lines.find((l) => String(l.id) === String(ld.json.id));
  assert.equal(line.room_hours, 1);
  assert.equal(String(line.room_group_id), String(g.json.id));
  assert.equal(gi.rooms.find((r) => String(r.id) === String(a.id)).capacity, 2);
});
