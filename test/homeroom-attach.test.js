// 반에 담임 붙이기(T-1203) — 보결 후보 사유 · 명단 「반」 열(있음/없음/못 찾음) · 두 반 담임 · 교사 빈 줄 채우기
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rankCandidates } from '../server/candidates.js';
import { smallSchool, seedPeople, seedStructure } from './fixtures/schools.js';
import { setupSchoolEnv, HAS_DB } from './fixtures/school-env.js';

const ctx = (members) => ({ weekday: 1, period: 3, periodConfig: { grades: { 1: { periods: 5 } } }, cells: [], members, absentIds: new Set(), pins: [], takenIds: new Set() });

test('보결 후보: 반이 안 붙은 담임은 후보로 남고 D 등급에 경고 no-homeroom(T-1204 보정)', () => {
  const r = rankCandidates(ctx([{ id: 1, name: '가', duty: '담임', homeroom: null }, { id: 2, name: '나', duty: '전담', homeroom: null }]));
  assert.deepEqual(r.excluded, []);
  assert.deepEqual(r.candidates.map((x) => [x.name, x.grade, x.warn?.code]), [['나', 'D', undefined], ['가', 'D', 'no-homeroom']]); // 경고 달린 쪽이 뒤
  assert.match(r.candidates[1].warn.detail, /수업 중인지 모름/);
  // 담임을 한 번도 안 붙인 작은 학교: 담임 전원이 후보에 남는다
  const small = rankCandidates(ctx([{ id: 1, name: '가', duty: '담임', homeroom: null }, { id: 2, name: '나', duty: '담임', homeroom: null }]));
  assert.equal(small.candidates.length, 2);
});

test('담임 붙이기: PATCH 로 붙이고 비우기 · 한 사람이 두 반이어도 막지 않음 · 빈 줄은 PATCH /loads 로 채움', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const { pool, orgId, tag, call, P } = await setupSchoolEnv(t, 'hr');
  const s = smallSchool();
  const mids = await seedPeople(pool, orgId, tag, s);
  const st = await seedStructure(pool, orgId, s, mids, { withHomerooms: false });
  const list = async () => (await call('GET', `${P}/classrooms`)).json;
  assert.ok((await list()).every((c) => c.homeroom_membership_id === null));
  const c1 = st.classrooms['1-1'];
  const c2 = st.classrooms['2-1'];
  assert.equal((await call('PATCH', `${P}/classrooms/${c1}`, { homeroom_membership_id: mids.h1 })).status, 200);
  assert.equal((await call('PATCH', `${P}/classrooms/${c2}`, { homeroom_membership_id: mids.h1 })).status, 200); // 두 반 담임: 막지 않는다
  assert.equal((await list()).filter((c) => c.homeroom_membership_id === mids.h1).length, 2);
  assert.equal((await call('PATCH', `${P}/classrooms/${c2}`, { homeroom_membership_id: null })).status, 200); // 비우기
  assert.equal((await list()).find((c) => c.id === c2).homeroom_membership_id, null);
  // 교사 빈 줄 채우기
  const subj = Object.values(st.subjects)[0];
  const blank = (await call('POST', `${P}/loads`, { classroom_id: c1, subject_id: subj, weekly_hours: 2 })).json;
  assert.equal(blank.membership_id, null);
  const lines = (await call('GET', `${P}/loads`)).json.lines.filter((l) => l.classroom_id === c1 && !l.membership_id);
  assert.equal(lines.length, 1);
  for (const l of lines) assert.equal((await call('PATCH', `${P}/loads/${l.id}`, { membership_id: mids.h1 })).status, 200);
  assert.equal((await call('GET', `${P}/loads`)).json.lines.filter((l) => l.classroom_id === c1 && !l.membership_id).length, 0);
});

test('명단 엑셀 「반」 열: 있는 반은 담임으로 · 없는 반은 사람만 받고 못 찾음 목록 · 열이 없으면 지금처럼', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const { pool, orgId, tag, call, P } = await setupSchoolEnv(t, 'hr');
  const s = smallSchool();
  const mids = await seedPeople(pool, orgId, tag, s);
  const st = await seedStructure(pool, orgId, s, mids, { withHomerooms: false });
  const rows = [
    { name: '나담임', loginId: `${tag}-a`, duty: '담임', classroom: '1-1' },
    { name: '다담임', loginId: `${tag}-b`, duty: '담임', classroom: '9-9' },
    { name: '라교사', loginId: `${tag}-c`, duty: '전담' }, // 열 없음
  ];
  const r = await call('POST', `${P}/roster/import`, { rows });
  assert.equal(r.status, 200);
  assert.equal(r.json.made, 3);
  assert.deepEqual(r.json.classMissing, [{ line: 2, name: '다담임', classroom: '9-9' }]);
  const home = (await call('GET', `${P}/classrooms`)).json.find((c) => c.id === st.classrooms['1-1']).homeroom_membership_id;
  const who = (await pool.query(`SELECT u.name FROM membership m JOIN app_user u ON u.id = m.user_id WHERE m.id = $1`, [home])).rows[0];
  assert.equal(who.name, '나담임');
  assert.equal(r.json.results[2].classroom, undefined);
});

test('명단 양식: 내려받기 양식에 「반」 열이 더해졌다(읽기는 열이 없어도 된다)', () => {
  const src = fs.readFileSync(new URL('../server/routes/roster.js', import.meta.url), 'utf8');
  assert.match(src, /addRow\(\['이름', 'ID', '역할', '담임\/전담', '반'\]\)/);
  assert.match(src, /classroom: guess\(\['반'\]\)/);
});
