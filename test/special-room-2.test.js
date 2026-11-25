// 특별실 2차(T-1311) — 정원 비우기 · 묶음 저장 한 바퀴 · 시수표 줄의 묶음·방 사용 시수 · 「받을 수 있는 수업」 세기 · 예약 정원 · 015 두 번 돌리기
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { HAS_DB, setup } from './sec-helpers.js';
import { roomWarnings } from '../server/routes/loads.js';

const skip = !HAS_DB && 'DB 없음 — 건너뜀';
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');

test('방 사용 시수 알림(순수): 주당 초과 · 연강 안 맞음 · 방+묶음 동시', () => {
  assert.deepEqual(roomWarnings({ weekly_hours: 3, room_hours: 2, block: 1 }), []);
  assert.deepEqual(roomWarnings({ weekly_hours: 3, room_hours: null, block: 2 }), []);
  assert.deepEqual(roomWarnings({ weekly_hours: 3, room_hours: 5, block: 1 }).map((w) => w.key), ['room_hours_over']);
  assert.deepEqual(roomWarnings({ weekly_hours: 2, room_hours: 1, block: 2 }).map((w) => w.key), ['room_block_whole']);
  assert.deepEqual(roomWarnings({ weekly_hours: 4, room_hours: 2, block: 2 }), []); // 연강 한 덩이 = 사용 시수와 맞음
  assert.deepEqual(roomWarnings({ weekly_hours: 1 }, { special_room_id: 1, room_group_id: 2 }).map((w) => w.key), ['room_both']);
});

test('특별실 정원·묶음·시수표 줄·세기·예약 한 바퀴', { skip }, async (t) => {
  const f = await setup(t);
  const o = `/api/orgs/${f.orgA}`;
  const a = await f.as('adminA');
  const mk = async (name, capacity) => (await a.call('POST', `${o}/special-rooms`, { name, capacity })).json;

  const r1 = await mk('과학실1', 1);
  const r2 = await mk('과학실2', 2);
  assert.equal(r2.capacity, 2);
  // 정원 비우기(null) · 고치기
  let p = await a.call('PATCH', `${o}/special-rooms/${r2.id}`, { capacity: null });
  assert.equal(p.status, 200);
  assert.equal(p.json.capacity, null);
  p = await a.call('PATCH', `${o}/special-rooms/${r2.id}`, { capacity: 3 });
  assert.equal(p.json.capacity, 3);
  p = await a.call('PATCH', `${o}/special-rooms/${r2.id}`, { name: '과학실2' }); // 정원을 안 보내면 그대로
  assert.equal(p.json.capacity, 3);

  // 묶음 — 만들기·고치기·목록
  const g = await a.call('POST', `${o}/special-room-groups`, { name: '과학실 아무 방', room_ids: [r1.id, r2.id, 999999999] });
  assert.equal(g.status, 201, JSON.stringify(g.json));
  assert.deepEqual(g.json.room_ids, [Number(r1.id), Number(r2.id)]);
  assert.ok(g.json.warnings.some((w) => w.key === 'group_missing'));
  assert.equal((await a.call('POST', `${o}/special-room-groups`, { name: '과학실 아무 방', room_ids: [] })).status, 409);
  const one = await a.call('PATCH', `${o}/special-room-groups/${g.json.id}`, { room_ids: [r1.id] });
  assert.ok(one.json.warnings.some((w) => w.key === 'group_one'));
  await a.call('PATCH', `${o}/special-room-groups/${g.json.id}`, { room_ids: [r1.id, r2.id] });
  const list = await a.call('GET', `${o}/special-room-groups`);
  assert.equal(list.json.find((x) => x.id === g.json.id).room_ids.length, 2);
  // 지워진 방은 읽을 때 빠진다
  const r3 = await mk('임시실', 1);
  await a.call('PATCH', `${o}/special-room-groups/${g.json.id}`, { room_ids: [r1.id, r2.id, r3.id] });
  assert.equal((await a.call('DELETE', `${o}/special-rooms/${r3.id}`)).status, 200);
  assert.equal((await a.call('GET', `${o}/special-room-groups`)).json.find((x) => x.id === g.json.id).room_ids.length, 2);

  // 시수표 줄 — 묶음 · 방 사용 시수 · 알림
  const L = await a.call('POST', `${o}/loads`, { classroom_id: f.A.class, subject_id: f.A.subject, weekly_hours: 3, room_group_id: g.json.id, room_hours: 2 });
  assert.equal(L.status, 201, JSON.stringify(L.json));
  assert.equal(Number(L.json.room_group_id), Number(g.json.id));
  assert.equal(L.json.room_hours, 2);
  assert.equal(L.json.warnings, undefined);
  // 방을 보내면 묶음이 비고(하나만), 사용 시수 초과는 알림
  const L2 = await a.call('PATCH', `${o}/loads/${L.json.id}`, { special_room_id: r1.id, room_hours: 9 });
  assert.equal(L2.status, 200);
  assert.equal(L2.json.room_group_id, null);
  assert.equal(Number(L2.json.special_room_id), Number(r1.id));
  assert.ok(L2.json.warnings.some((w) => w.key === 'room_hours_over'));
  // 남의 묶음 번호는 404
  assert.equal((await a.call('POST', `${o}/loads`, { room_group_id: f.B.group })).status, 404);
  // 다시 묶음으로 · 비움(NULL = 전부)
  const L3 = await a.call('PATCH', `${o}/loads/${L.json.id}`, { room_group_id: g.json.id, room_hours: null });
  assert.equal(L3.json.special_room_id, null);
  assert.equal(L3.json.room_hours, null);

  // 「받을 수 있는 수업」 — 묶음 합 (정원 합 × 주 칸 수)
  const issue = async () => (await a.call('GET', `${o}/school-setup/status`)).json.checks.find((c) => c.key === 'over_room');
  await a.call('PATCH', `${o}/special-rooms/${r2.id}`, { capacity: 1 });
  const big = await a.call('PATCH', `${o}/loads/${L.json.id}`, { weekly_hours: 100 });
  assert.equal(big.status, 200);
  const grp = (await issue()).items.find((x) => x.group);
  assert.ok(grp, '묶음 줄로 견줌');
  assert.equal(grp.name, '과학실 아무 방');
  assert.equal(grp.hours, 100);
  assert.equal((await issue()).items.some((x) => !x.group), false, '묶음 구성원 방은 따로 안 센다');
  const slots = grp.cap / 2; // 정원 1 + 1 = 2반 × 주 칸 수
  assert.ok(Number.isInteger(slots) && slots > 0 && slots < 100);
  // 정원을 3 으로 키우면 받는 수업이 (1+3)×주 칸 수로 늘어 안에 든다
  await a.call('PATCH', `${o}/special-rooms/${r2.id}`, { capacity: 3 });
  assert.equal((await issue()).count, slots * 4 >= 100 ? 0 : 1);
  await a.call('PATCH', `${o}/special-rooms/${r2.id}`, { capacity: 1 });
  // 방 사용 시수 10 이면 받는 수업 안에 든다
  await a.call('PATCH', `${o}/loads/${L.json.id}`, { room_hours: 10 });
  assert.equal((await issue()).count, 0);
  await a.call('PATCH', `${o}/special-rooms/${r2.id}`, { capacity: 3 });

  // 예약 — 정원 3 방은 한 반이 수업 중이어도 비는 방, 정원 1 방은 한 건이면 닫힘
  const day = '2026-11-23';
  const book = await a.call('POST', `${o}/bookings`, { special_room_id: r1.id, on_date: day, period: 3 });
  assert.equal(book.status, 201, JSON.stringify(book.json));
  const free = (await a.call('GET', `${o}/rooms/free?on_date=${day}&period=3`)).json;
  const fr1 = free.find((x) => String(x.id) === String(r1.id));
  assert.equal(fr1.free, false);
  assert.equal(fr1.used, 1);
  const fr2 = free.find((x) => String(x.id) === String(r2.id));
  assert.equal(fr2.slots, 3);
  assert.equal(fr2.free, true);
  const book2 = await a.call('POST', `${o}/bookings`, { special_room_id: r2.id, on_date: day, period: 3 });
  assert.equal(book2.status, 201);
  assert.equal(book2.json.warnings?.length ?? 0, 0, '정원 3 방에 첫 예약은 겹침이 아니다');

  // 묶음 지우기 — 줄은 남고 묶음 칸만 빈다
  await a.call('PATCH', `${o}/loads/${L.json.id}`, { room_group_id: g.json.id });
  const del = await a.call('DELETE', `${o}/special-room-groups/${g.json.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.json.loads, 1);
  assert.equal((await f.pool.query(`SELECT room_group_id FROM teaching_load WHERE id = $1`, [L.json.id])).rows[0].room_group_id, null);
  assert.equal((await a.call('GET', `${o}/special-room-groups`)).json.length, 0);
});

test('015: 두 번 돌려도 같은 끝 · 014 까지만 돈 DB 에서도 들어간다', { skip }, async (t) => {
  const { databaseUrl } = await import('../server/db.js');
  const base = new URL(databaseUrl());
  const name = `${base.pathname.slice(1)}_m015`.toLowerCase();
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(base); u.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: u.toString(), max: 2 });
  t.after(async () => {
    await pool.end();
    const c = new pg.Client({ connectionString: base.toString() });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await c.end();
  });
  const mdir = path.join(SERVER, 'migrations');
  const apply = async (upto) => {
    await pool.query(fs.readFileSync(path.join(SERVER, 'schema.sql'), 'utf8'));
    for (const f of fs.readdirSync(mdir).filter((n) => n.endsWith('.sql') && (!upto || n < upto)).sort()) await pool.query(fs.readFileSync(path.join(mdir, f), 'utf8'));
  };
  const snap = async () => JSON.stringify([
    (await pool.query(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('room_group_id','room_hours') ORDER BY 1,2`)).rows,
    (await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename='special_room_group' ORDER BY 1`)).rows,
  ]);
  await apply('015');
  assert.ok(!(await snap()).includes('room_hours'), '015 전엔 없음');
  await apply();
  const one = await snap();
  assert.ok(one.includes('room_hours') && one.includes('room_group_id') && one.includes('special_room_group_uq'));
  await apply();
  assert.equal(await snap(), one);
});
