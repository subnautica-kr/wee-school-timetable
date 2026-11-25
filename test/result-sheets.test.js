// T-1304: 자동 생성 결과 화면과 엑셀 출력이 같은 계산 함수(shared/sheetCalc.js)를 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as shared from '../shared/sheetCalc.js';
import * as server from '../server/export/data.js';
import { mergeSettings } from '../server/export/settings.js';
import { makeXlsx } from '../server/export/xlsx.js';
import ExcelJS from 'exceljs';

const st = mergeSettings({});
const d = {
  classrooms: [{ id: 1, grade: 3, class_no: 1 }, { id: 2, grade: 3, class_no: 2 }],
  subjects: [{ id: 2, name: '과학', short_name: '과' }, { id: 3, name: '체육', short_name: '체' }],
  teachers: [{ id: 1, name: '김담임', duty: '담임' }, { id: 2, name: '박전담', duty: '전담' }],
  rooms: [{ id: 1, name: '과학실' }, { id: 2, name: '음악실' }],
  cells: [
    { classroom_id: 1, weekday: 1, period: 2, subject_id: 2, membership_id: 2, special_room_id: 1 },
    { classroom_id: 2, weekday: 3, period: 1, subject_id: 2, membership_id: 2, special_room_id: 1 },
    { classroom_id: 2, weekday: 2, period: 1, subject_id: 3, membership_id: 1, special_room_id: null },
  ],
  periodConfig: { grades: { 3: { periods: 4 } } },
};

test('엑셀 길(server/export/data.js)과 화면 길(shared)이 같은 함수 · 같은 입력 → 같은 표', () => {
  for (const f of ['buildSheets', 'classSheet', 'teacherSheet', 'roomSheet']) assert.equal(server[f], shared[f], f);
  for (const view of ['class', 'teacher', 'room']) {
    assert.deepEqual(server.buildSheets(d, st, { view }), shared.buildSheets(d, st, { view }));
  }
  // 화면 소스가 그 함수를 부르는지(복제본을 만들지 않았는지)
  const src = fs.readFileSync(new URL('../web/src/generate/AutoGen.jsx', import.meta.url), 'utf8');
  assert.match(src, /shared\/sheetCalc\.js/);
  assert.match(src, /buildSheets\(/);
});

test('특별실별 표 한 바퀴: 칸에 반+교사 · 특별실 이름 줄 없음 · 안 쓰는 방은 시트 없음', () => {
  const sheets = shared.buildSheets(d, st, { view: 'room' });
  assert.deepEqual(sheets.map((s) => s.title), ['과학실 특별실']);
  const [s] = sheets;
  assert.deepEqual(s.header.map((h) => h.text), ['', '월', '화', '수', '목', '금']);
  assert.equal(s.rows.length, 4);
  assert.equal(s.rows[1][1].text, '과\n3학년 1반\n박전담'); // 월 2교시
  assert.equal(s.rows[0][3].text, '과\n3학년 2반\n박전담'); // 수 1교시
  assert.equal(s.rows[0][1].text, '');
  assert.equal(s.rows[1][1].shade, true); // 과학실 음영
  assert.equal(shared.buildSheets(d, st, { view: 'room', id: 2 }).length, 0);
});

test('교사별 칸은 반+교과(교사 이름 없음) · 엑셀 파일에 특별실 시트가 든다', async () => {
  const [p] = shared.buildSheets(d, st, { view: 'teacher', id: 2 });
  assert.equal(p.rows[1][1].text, '과\n3학년 1반\n과학실');
  const buf = await makeXlsx(shared.buildSheets(d, st, { view: 'room' }), st, '시안');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['과학실 특별실']);
});
