// 시수표 엑셀 올리기(T-1204) — 반 칸 세 꼴 · 미리보기/반영 · 같은 파일 또 올려도 두 배 안 됨 · 교사 못 찾음 → 교사 빈 줄 받기
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseBlock, parseClassCell, parseLoadRows } from '../server/export/loadsImport.js';
import { bigSchool, smallSchool, seedPeople, seedStructure } from './fixtures/schools.js';
import { setupSchoolEnv, HAS_DB } from './fixtures/school-env.js';

const xlsx = async (rows) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('a');
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
};
const HEAD = ['교사', '교과', '학년', '반', '주당 시수', '연강'];

test('반 칸 세 꼴: 비움 = 전체 · 1,3,5 · 1~4(1-4 도) · 읽을 수 없는 칸은 사유', () => {
  assert.deepEqual(parseClassCell(''), { all: true, nums: [] });
  assert.deepEqual(parseClassCell(' 1, 3 ,5 '), { all: false, nums: [1, 3, 5] });
  assert.deepEqual(parseClassCell('1~4'), { all: false, nums: [1, 2, 3, 4] });
  assert.deepEqual(parseClassCell('1-4'), { all: false, nums: [1, 2, 3, 4] });
  assert.deepEqual(parseClassCell('2반'), { all: false, nums: [2] });
  assert.ok(parseClassCell('가나').bad);
  assert.ok(parseClassCell('4~1').bad);
});

test('연강 칸: 비움 1 · ○ 2 · 숫자 그대로 · 한도 넘으면 사유', () => {
  assert.equal(parseBlock('').block, 1);
  assert.equal(parseBlock('○').block, 2);
  assert.equal(parseBlock('3').block, 3);
  assert.ok(parseBlock('99').bad);
  assert.ok(parseBlock('글쎄').bad);
});

test('표 읽기(순수): 학년+반 목록 · 학년 전체 · 학교 전체 · 교사 못 찾음은 빈 줄 후보 · 연강 열이 없어도 읽힘', () => {
  const classrooms = [1, 2, 3].map((n) => ({ id: n, grade: 3, class_no: n })).concat([{ id: 9, grade: 4, class_no: 1 }]);
  const subjects = [{ id: 7, name: '체육', short_name: null }];
  const people = [{ membership_id: 5, name: '가나다', login_id: 'ga' }, { membership_id: 6, name: '동명', login_id: 'd1' }, { membership_id: 8, name: '동명', login_id: 'd2' }];
  const t = (rows) => parseLoadRows([HEAD, ...rows], { people, classrooms, subjects });
  const r = t([
    ['가나다', '체육', '3', '1,3', '2', ''],
    ['GA', '체육', '3', '', '1', '○'],
    ['가나다', '체육', '', '', '1', ''],
    ['없는분', '체육', '3', '2', '1', ''],
    ['동명', '체육', '3', '2', '1', ''],
    ['가나다', '없는과목', '3', '2', '1', ''],
    ['가나다', '체육', '3', '9', '1', ''],
  ]);
  assert.deepEqual(r[0].classroom_ids, [1, 3]);
  assert.deepEqual([r[1].ok, r[1].classroom_ids, r[1].block, r[1].membership_id], [true, [1, 2, 3], 2, 5]); // ID 로 찾음(대소문자 무시)
  assert.deepEqual([r[2].ok, r[2].classroom_ids], [true, null]); // 학교 전체
  assert.deepEqual([r[3].ok, r[3].blank_teacher_ok, r[3].reason], [false, true, '교사를 찾지 못함']);
  assert.match(r[4].reason, /이름이 같은/);
  assert.deepEqual([r[5].ok, r[5].blank_teacher_ok, r[5].reason], [false, false, '교과를 찾지 못함']);
  assert.match(r[6].reason, /9반을 찾지 못함/);
  // 머리 줄에 연강 열이 없는 파일
  const noBlock = parseLoadRows([['교사', '교과', '학년', '반', '시수'], ['가나다', '체육', '3', '1', '2']], { people, classrooms, subjects });
  assert.deepEqual([noBlock[0].ok, noBlock[0].block], [true, 1]);
});

test('올리기: 102줄 미리보기 → 반영 102줄 → 같은 파일 또 올려도 두 배 안 됨 · 시수·연강만 고침', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const { pool, orgId, tag, call, P } = await setupSchoolEnv(t, 'li');
  const s = bigSchool();
  const mids = await seedPeople(pool, orgId, tag, s);
  await seedStructure(pool, orgId, s, mids, { withLoads: false });
  const file = await xlsx([HEAD, ...s.loads.map((l) => [`${tag}-${l.teacher}`, l.subject, l.grade, l.class_no, l.hours, ''])]);
  assert.equal(s.loads.length, 102);
  assert.equal((await call('GET', `${P}/loads/template`)).status, 200);
  const pv = await call('POST', `${P}/loads/preview`, file);
  assert.equal(pv.status, 200);
  assert.deepEqual([pv.json.ok, pv.json.unread], [102, 0]);
  const body = (rows) => ({ rows: rows.filter((x) => x.ok).map((x) => ({ membership_id: x.membership_id, subject_id: x.subject_id, classroom_ids: x.classroom_ids, hours: x.hours, block: x.block })) });
  const ap = await call('POST', `${P}/loads/apply`, body(pv.json.rows));
  assert.deepEqual([ap.json.applied, ap.json.created, ap.json.updated, ap.json.skipped], [102, 102, 0, 0]);
  const count = async () => (await call('GET', `${P}/loads`)).json.lines.length;
  assert.equal(await count(), 102);
  // 같은 파일, 시수 하나·연강 하나만 바꿔 다시
  const l0 = s.loads[0];
  const file2 = await xlsx([HEAD, ...s.loads.map((l, i) => [`${tag}-${l.teacher}`, l.subject, l.grade, l.class_no, i === 0 ? 5 : l.hours, i === 0 ? '○' : ''])]);
  const ap2 = await call('POST', `${P}/loads/apply`, body((await call('POST', `${P}/loads/preview`, file2)).json.rows));
  assert.deepEqual([ap2.json.created, ap2.json.updated], [0, 102]);
  const lines = (await call('GET', `${P}/loads`)).json.lines;
  assert.equal(lines.length, 102);
  assert.equal(lines.filter((l) => l.weekly_hours === 5 && l.block === 2).length, 1);
  assert.ok(l0);
});

test('올리기: 학년 전체·반 목록이 반마다 줄로 · 교사 못 찾은 줄은 미리보기에 사유 · 「빈 줄로 받기」일 때만 교사 빈 줄', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const { pool, orgId, tag, call, P } = await setupSchoolEnv(t, 'li');
  const s = bigSchool();
  const mids = await seedPeople(pool, orgId, tag, s);
  await seedStructure(pool, orgId, s, mids, { withLoads: false });
  const sub = '영어';
  const file = await xlsx([HEAD,
    [`${tag}-s01`, sub, 3, '', 2, ''], // 3학년 전체 9반
    [`${tag}-s01`, sub, 4, '1~3', 1, '○'], // 4학년 1~3반
    [`${tag}-s02`, '과학', 1, '1,3,5', 1, ''],
    ['지어낸이름없음', sub, 5, '2', 1, ''], // 교사 못 찾음
    [`${tag}-s01`, '없는교과', 5, '2', 1, ''], // 교과 못 찾음 — 빈 줄로도 못 받음
  ]);
  const pv = (await call('POST', `${P}/loads/preview`, file)).json;
  assert.deepEqual([pv.ok, pv.unread, pv.blankTeacher], [3, 2, 1]);
  assert.equal(pv.rows[3].reason, '교사를 찾지 못함'); // 버리지 않고 사유와 함께
  assert.equal(pv.rows[4].blank_teacher_ok, false);
  const pick = (x) => ({ membership_id: x.membership_id, subject_id: x.subject_id, classroom_ids: x.classroom_ids, hours: x.hours, block: x.block });
  // 기본(체크 꺼짐): 읽힌 줄만
  const a1 = await call('POST', `${P}/loads/apply`, { rows: pv.rows.filter((x) => x.ok).map(pick) });
  assert.equal(a1.json.created, 9 + 3 + 3);
  let lines = (await call('GET', `${P}/loads`)).json.lines;
  assert.equal(lines.length, 15);
  assert.equal(lines.filter((l) => !l.membership_id).length, 0);
  assert.equal(lines.filter((l) => l.block === 2).length, 3);
  // 체크 켬: 교사만 못 맞춘 줄을 membership_id null 로
  const a2 = await call('POST', `${P}/loads/apply`, { rows: pv.rows.filter((x) => x.blank_teacher_ok).map(pick) });
  assert.equal(a2.json.created, 1);
  lines = (await call('GET', `${P}/loads`)).json.lines;
  assert.equal(lines.filter((l) => !l.membership_id).length, 1);
  assert.equal(lines.find((l) => !l.membership_id).incomplete, true); // 기존대로 「덜 채운 줄」 표시
  // 반 하나 없는 학교 전체 줄(학년·반 모두 비움)
  const all = await xlsx([HEAD, [`${tag}-s03`, '과학', '', '', 1, '']]);
  const pv3 = (await call('POST', `${P}/loads/preview`, all)).json;
  assert.equal(pv3.rows[0].classroom_ids, null);
  await call('POST', `${P}/loads/apply`, { rows: [pick(pv3.rows[0])] });
  lines = (await call('GET', `${P}/loads`)).json.lines;
  assert.equal(lines.filter((l) => l.classroom_id === null).length, 1);
});

test('올리기: 남의 기관 자료·깨진 파일은 막는다', { skip: !HAS_DB && 'DB 없음 — 건너뜀' }, async (t) => {
  const { pool, orgId, tag, call, P } = await setupSchoolEnv(t, 'li');
  const s = smallSchool();
  const mids = await seedPeople(pool, orgId, tag, s);
  await seedStructure(pool, orgId, s, mids, { withLoads: false });
  assert.equal((await call('POST', `${P}/loads/preview`, Buffer.from('zzzz'), { expect: 400 })).status, 400);
  const ap = await call('POST', `${P}/loads/apply`, { rows: [{ membership_id: 999999999, subject_id: 999999999, classroom_ids: [999999999], hours: 2 }] });
  assert.deepEqual([ap.json.applied, ap.json.skipped], [0, 1]);
  assert.equal((await call('POST', `${P}/loads/apply`, { rows: [{ subject_id: 1, classroom_ids: null, hours: 0 }] }, { expect: 400 })).status, 400);
});

test('시수표 화면: 반 여러 개·학년 전체 고르기 · 줄에서 바로 고치기(PATCH) · 지우기 전 확인 · 올리기 칸', async () => {
  const fs = await import('node:fs');
  const s = fs.readFileSync(new URL('../web/src/school/SchoolPage.jsx', import.meta.url), 'utf8');
  const loads = s.slice(s.indexOf('function Loads('));
  assert.match(loads, /<MultiSelect/);
  assert.match(loads, /학년 전체/);
  assert.match(loads, /patch\(l, \{ membership_id/);
  assert.match(loads, /patch\(l, \{ subject_id/);
  assert.match(loads, /patch\(l, \{ weekly_hours/);
  assert.match(loads, /if \(!\(await ask\(/); // 지우기 전 한 번 묻는다
  assert.match(loads, /<LoadUpload/);
  const u = fs.readFileSync(new URL('../web/src/school/LoadUpload.jsx', import.meta.url), 'utf8');
  assert.match(u, /교사 빈 줄로 받기/);
  assert.match(u, /useState\(false\)/); // 기본 꺼짐
});
