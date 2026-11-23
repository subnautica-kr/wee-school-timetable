// 가짜 학교 두 벌의 크기를 센다 + 도우미가 DB 에 실제로 심어지는지 한 번(T-1201)
import test from 'node:test';
import assert from 'node:assert/strict';
import { bigSchool, smallSchool, seedPeople, seedStructure } from './fixtures/schools.js';
import { setupSchoolEnv, HAS_DB } from './fixtures/school-env.js';

test('큰 학교: 반 51 · 시수표 102줄 · 교사 67', () => {
  const s = bigSchool();
  assert.equal(s.classes.length, 51);
  assert.equal(s.loads.length, 102);
  assert.equal(s.teachers.length, 67);
  assert.equal(s.teachers.filter((t) => t.duty === '담임').length, 51);
});

test('작은 학교: 반 6 · 교사 8', () => {
  const s = smallSchool();
  assert.equal(s.classes.length, 6);
  assert.equal(s.teachers.length, 8);
});

test('도우미가 작은 학교를 DB 에 심는다', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const { pool, orgId, tag } = await setupSchoolEnv(t, 'fx');
  const s = smallSchool();
  const mids = await seedPeople(pool, orgId, tag, s);
  assert.equal(Object.keys(mids).length, 8);
  const st = await seedStructure(pool, orgId, s, mids);
  assert.equal(Object.keys(st.classrooms).length, 6);
  assert.equal(st.loadCount, s.loads.length);
  const n = (await pool.query(`SELECT count(*)::int AS n FROM teaching_load WHERE org_id=$1`, [orgId])).rows[0].n;
  assert.equal(n, s.loads.length);
});
