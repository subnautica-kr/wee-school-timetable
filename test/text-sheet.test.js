// 문구 검수표 — 뽑기 → 한 줄 고침 → 되넣기 한 바퀴를 임시 사본 위에서 돌린다(레포의 실제 문구 파일은 안 바꾼다).
// 검수표 파일은 레포·볼트 밖 %TEMP% 에만 둔다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { ROOT } from '../scripts/text-scan.js';
import { jariProblem, buildRows, writeSheet, applySheet } from '../scripts/text-sheet.js';

const FAKE = `export default {
  "_영역": "시험영역",
  "link": {
    "_자리": "명단 › 줄 메뉴 계정 연결 창 › 아이디가 없을 때",
    "title": "{이름} 선생님 계정을 연결해요.",
    "title?": "창 머리말",
    "body": "[[시수표]]를 먼저 **넣어** 주세요. {학교}(으로/로) 가요.",
    "formal": "연결되었습니다."
  },
  "err": {
    "_자리": "명단 › 오류 알림 › 이미 연결됐을 때",
    "dup": "이미 연결돼 있어요. 학교 관리자에게 물어보세요."
  }
};
`;

// 임시 사본: 시험 영역 파일 하나 + 진짜 용어 사전
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'T-1316b-root-'));
  fs.mkdirSync(path.join(root, 'shared', 'text'), { recursive: true });
  fs.writeFileSync(path.join(root, 'shared', 'text', 'glossary.js'), fs.readFileSync(path.join(ROOT, 'shared/text/glossary.js')));
  fs.writeFileSync(path.join(root, 'shared', 'text', 'fake.js'), FAKE);
  fs.mkdirSync(path.join(root, 'web', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web', 'src', 'A.jsx'), "const x = t('fake.link.title', { 이름: a });\n");
  return root;
}
const sheetDir = path.join(os.tmpdir(), 'T-1316b');
const read = (root, f) => fs.readFileSync(path.join(root, 'shared', 'text', f), 'utf8');
const sheetFile = (name) => { fs.mkdirSync(sheetDir, { recursive: true }); return path.join(sheetDir, `${name}-${process.pid}.xlsx`); };

async function edit(file, fn) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  fn(wb);
  await wb.xlsx.writeFile(file);
}
// 검수표에서 키 칸 값으로 줄을 찾아 칸 하나를 쓴다
function setCell(wb, sheet, keyCol, key, col, text) {
  const ws = wb.getWorksheet(sheet);
  const head = {}; ws.getRow(1).eachCell((c, i) => { head[c.value] = i; });
  let hit = 0;
  ws.eachRow((row, n) => { if (n > 1 && row.getCell(head[keyCol]).value === key) { row.getCell(head[col]).value = text; hit++; } });
  assert.equal(hit, 1, `${sheet}/${key} 줄 하나`);
}

test('jariProblem: 세 토막 꼴만 통과', () => {
  assert.equal(jariProblem('명단 › 줄 메뉴 계정 연결 창 › 아이디가 없을 때', '명단·계정'), null);
  assert.match(jariProblem('명단 › 계정 연결 창'), /세 토막/);
  assert.match(jariProblem('명단 › › 언제'), /빈 토막/);
  assert.match(jariProblem('명단·계정 › 명단·계정 › 명단·계정', '명단·계정'), /되풀이/);
  assert.match(jariProblem('명단 › 명단·계정 › 언제', '명단·계정'), /영역 이름/);
  assert.match(jariProblem('  '), /비었음/);
  assert.match(jariProblem(undefined), /비었음/);
});

test('검수표 한 바퀴: 뽑기 → 한 줄 고침 → 되넣기', async () => {
  const root = makeRoot();
  const file = sheetFile('round');
  const n = await writeSheet(file, root);
  assert.equal(n.문구, 4);
  assert.ok(n.용어 > 20);
  assert.equal(n.경고, 2, '합니다체 한 줄 + 쓰지 않을 말 한 줄');

  // 뽑힌 모양: 시트 셋 · 숨은 열 · 잠금 · 쓰이는 파일
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['문구', '용어', '경고만']);
  const ws = wb.getWorksheet('문구');
  assert.equal(ws.getRow(1).getCell(6).value, '키');
  assert.equal(ws.getColumn(6).hidden, true);
  assert.notEqual(ws.getRow(2).getCell(3).protection?.locked, false, '지금 문구 칸은 잠김(기본값)');
  assert.equal(ws.getRow(2).getCell(4).protection.locked, false);
  assert.ok(ws.sheetProtection, '시트 보호');
  const rows = buildRows(root).phrases;
  assert.equal(rows.find((r) => r.키 === 'fake.link.title').파일, 'web/src/A.jsx');
  assert.equal(rows.find((r) => r.키 === 'fake.link.title').자리, '명단 › 줄 메뉴 계정 연결 창 › 아이디가 없을 때 — 창 머리말');

  // 한 줄 고침(따옴표·줄바꿈·변수 그대로) → 되넣기
  await edit(file, (w) => setCell(w, '문구', '키', 'fake.link.title', '고칠 문구', '{이름} 님의 "계정"을\n연결해요.'));
  const before = read(root, 'fake.js');
  const dry = await applySheet(file, root, { dry: true });
  assert.equal(read(root, 'fake.js'), before, '미리보기는 안 쓴다');
  assert.equal(dry.바뀜.length, 1);
  const r = await applySheet(file, root);
  assert.deepEqual(r.안넣음, []);
  assert.deepEqual(r.바뀜, [{ 키: 'fake.link.title', 앞: '{이름} 선생님 계정을 연결해요.', 뒤: '{이름} 님의 "계정"을\n연결해요.' }]);
  const after = read(root, 'fake.js');
  assert.equal(after, before.replace('"{이름} 선생님 계정을 연결해요."', JSON.stringify('{이름} 님의 "계정"을\n연결해요.')), '그 글자 칸만 바뀌고 줄 모양은 그대로');
  assert.ok(after.includes('"title?": "창 머리말"'));

  // 낡은 표(정본이 그 사이 바뀜)로 또 되넣으면 안 넣는다
  const again = await applySheet(file, root);
  assert.equal(again.바뀜.length, 0);
  assert.match(again.안넣음[0].사유, /지금 문구/);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(file, { force: true });
});

test('되넣기 거절: 변수 · [[낱말]] · 낡은 표는 안 넣고 사유를 돌려준다', async () => {
  const root = makeRoot();
  const file = sheetFile('reject');
  await writeSheet(file, root);
  await edit(file, (w) => {
    setCell(w, '문구', '키', 'fake.link.title', '고칠 문구', '선생님 계정을 연결해요.'); // 변수 빠짐
    setCell(w, '문구', '키', 'fake.link.body', '고칠 문구', '[[없는낱말]]을 먼저 넣어 주세요. {학교}(으로/로) 가요.'); // 사전에 없음
    setCell(w, '문구', '키', 'fake.link.formal', '고칠 문구', '연결됐어요.'); // 정상
    setCell(w, '문구', '키', 'fake.err.dup', '지금 문구', '다른 글'); // 낡은 표
    setCell(w, '문구', '키', 'fake.err.dup', '고칠 문구', '이미 연결돼 있어요.');
  });
  const before = read(root, 'fake.js');
  const r = await applySheet(file, root);
  assert.deepEqual(r.바뀜.map((c) => c.키), ['fake.link.formal']);
  assert.equal(r.안넣음.length, 3);
  assert.match(r.안넣음.find((x) => x.키 === 'fake.link.title').사유, /변수/);
  assert.match(r.안넣음.find((x) => x.키 === 'fake.link.body').사유, /용어 사전/);
  assert.match(r.안넣음.find((x) => x.키 === 'fake.err.dup').사유, /지금 문구/);
  assert.equal(read(root, 'fake.js'), before.replace('"연결되었습니다."', '"연결됐어요."'), '정상 한 줄만 바뀜');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(file, { force: true });
});

test('용어 시트: 풀이 고치기 · 경고만 시트에서도 고침', async () => {
  const root = makeRoot();
  const file = sheetFile('term');
  await writeSheet(file, root);
  const gBefore = read(root, 'glossary.js');
  await edit(file, (w) => {
    setCell(w, '용어', '낱말', '교시', '고칠 풀이', '하루 수업의 차례입니다. 첫 수업이 1교시입니다.');
    setCell(w, '경고만', '키', 'fake.err.dup', '고칠 문구', '이미 연결돼 있어요. 기관 관리자에게 물어보세요.');
  });
  const r = await applySheet(file, root);
  assert.deepEqual(r.안넣음, []);
  assert.deepEqual(r.바뀜.map((c) => c.키).sort(), ['fake.err.dup', '용어.교시.풀이']);
  const gAfter = read(root, 'glossary.js');
  assert.equal(gAfter.split('\n').length, gBefore.split('\n').length, '줄 수 그대로');
  assert.ok(gAfter.includes('첫 수업이 1교시입니다.'));
  assert.ok(read(root, 'fake.js').includes('기관 관리자에게'));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(file, { force: true });
});
