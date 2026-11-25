#!/usr/bin/env node
// 문구 검수표 — 쥔님 검수 창구(설계 「화면 문구 분리 설계 (2026-11-25)」 7절). 정본은 shared/text/ 하나이고 검수표는 거기서 뽑은 사본이자 고침 요청서다.
//
//   node scripts/text-sheet.js --out "<경로>.xlsx"     뽑기: 정본 → 엑셀(문구·용어·경고만 세 시트)
//   node scripts/text-sheet.js --apply "<경로>.xlsx"   되넣기: 「고칠 문구」·「고칠 풀이」가 적힌 줄만 정본에 쓴다. 어긋난 줄은 안 넣고 사유와 함께 돌려준다
//
// 되넣기 검사: ① {변수} 가 한 벌 그대로 ② [[낱말]] 이 사전에 있음 ③ 검수표의 「지금 문구」가 정본과 같음(낡은 표로 최신을 덮지 않음).
// 정본 파일은 줄 모양을 지키려고 글자 하나만 바꿔 쓰고, 쓴 뒤 다시 읽어 기대한 값과 같은지 본다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { ROOT, TEXT_DIR, textFiles, readTextFile, forbiddenHits, keyCalls } from './text-scan.js';
import { varsOf, termsOf } from '../shared/text/index.js';

// ---- _자리 세 토막 꼴 (설계 7절) — text-guard 시험도 쓴다 ----
// 「어느 화면 › 어느 창·단추 › 언제 뜨나」. 문제가 있으면 사유 글, 괜찮으면 null.
export function jariProblem(jari, 영역 = '') {
  if (typeof jari !== 'string' || !jari.trim()) return '_자리 가 비었음';
  const parts = jari.split('›').map((s) => s.trim());
  if (parts.length < 3) return `세 토막(화면 › 창·단추 › 언제)이 아님: 「${jari}」`;
  if (parts.some((p) => !p)) return `빈 토막이 있음: 「${jari}」`;
  if (new Set(parts).size < parts.length) return `같은 토막이 되풀이됨: 「${jari}」`;
  if (영역 && parts.includes(영역.trim())) return `영역 이름(${영역})만 되풀이한 토막이 있음: 「${jari}」`;
  return null;
}

const SHEET_PHRASE = '문구', SHEET_TERM = '용어', SHEET_WARN = '경고만';
const nl = (s) => String(s ?? '').replace(/\r\n?/g, '\n');
const isAreaFile = (f) => f !== 'glossary.js';

// 셀 값 → 글자(서식 있는 글·수식 결과·숫자도 받는다)
function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return nl(v.richText.map((r) => r.text).join(''));
    if ('result' in v) return nl(v.result);
    if ('text' in v) return nl(v.text);
  }
  return nl(v);
}

// ---- 뽑기 ----
const DRAFT_STYLE = { wrapText: true, vertical: 'top' };

export function buildRows(root = ROOT) {
  const usedIn = new Map();
  for (const c of keyCalls(root)) { if (!usedIn.has(c.key)) usedIn.set(c.key, new Set()); usedIn.get(c.key).add(c.f); }
  const glossary = readTextFile('glossary.js', root);
  const phrases = [], terms = [];
  for (const file of textFiles(root)) {
    if (!isAreaFile(file) || file === 'labels.js') continue;
    const area = file.replace(/\.js$/, '');
    const obj = readTextFile(file, root);
    for (const [g, grp] of Object.entries(obj)) {
      if (g.startsWith('_') || !grp || typeof grp !== 'object') continue;
      for (const [u, s] of Object.entries(grp)) {
        if (u.startsWith('_') || u.endsWith('?')) continue;
        const note = typeof grp[u + '?'] === 'string' ? ` — ${grp[u + '?']}` : '';
        const warn = [];
        for (const h of forbiddenHits(s, glossary)) warn.push(`쓰지 않을 말 「${h.쓰지않을말}」 → 「${h.낱말}」`);
        if (/(습니다|입니다|합니다)[.!?]?$/.test(s.trim())) warn.push('합니다체(화면 말투는 해요체)');
        const key = `${area}.${g}.${u}`;
        phrases.push({ 영역: obj._영역 ?? area, 자리: `${grp._자리 ?? ''}${note}`, 지금: s, 키: key, 파일: [...(usedIn.get(key) ?? [])].sort().join(', '), 경고: warn.join(' / ') });
      }
    }
  }
  for (const [k, v] of Object.entries(glossary)) {
    if (k.startsWith('_') || !v || typeof v !== 'object') continue;
    terms.push({ 낱말: k, 묶음: v.묶음 ?? '', 풀이: v.풀이 ?? '', 쓰지않을말: (v.쓰지않을말 ?? []).join(', '), 메모: v.메모 ?? '' });
  }
  return { phrases, terms };
}

function phraseSheet(wb, name, rows) {
  const ws = wb.addWorksheet(name);
  ws.columns = [
    { header: '영역', key: '영역', width: 14 }, { header: '자리', key: '자리', width: 44 }, { header: '지금 문구', key: '지금', width: 52 },
    { header: '고칠 문구', key: '고칠', width: 52 }, { header: '메모', key: '메모', width: 28 },
    { header: '키', key: '키', width: 30, hidden: true }, { header: '쓰이는 파일', key: '파일', width: 30, hidden: true }, { header: '경고', key: '경고', width: 36, hidden: true },
  ];
  for (const r of rows) ws.addRow({ ...r, 고칠: '', 메모: '' });
  finishSheet(ws, [4, 5], [1, 2, 3]);
}
function termSheet(wb, rows) {
  const ws = wb.addWorksheet(SHEET_TERM);
  ws.columns = [
    { header: '낱말', key: '낱말', width: 18 }, { header: '묶음', key: '묶음', width: 22 }, { header: '지금 풀이', key: '풀이', width: 52 },
    { header: '지금 쓰지 않을 말', key: '쓰지않을말', width: 28 }, { header: '고칠 풀이', key: '고칠풀이', width: 52 },
    { header: '고칠 쓰지 않을 말', key: '고칠금', width: 28 }, { header: '메모', key: '메모', width: 28 },
  ];
  for (const r of rows) ws.addRow({ ...r, 고칠풀이: '', 고칠금: '', 메모: r.메모 });
  finishSheet(ws, [5, 6, 7], [1, 2, 3, 4]);
}
// 잠글 칸·열 풀 칸을 정해 시트 보호(비밀번호 없음 — 실수 방지용)
function finishSheet(ws, openCols, lockCols) {
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.eachRow((row, n) => {
    for (const c of lockCols) { const cell = row.getCell(c); cell.alignment = DRAFT_STYLE; cell.protection = { locked: true }; }
    if (n === 1) return;
    for (const c of openCols) { const cell = row.getCell(c); cell.alignment = DRAFT_STYLE; cell.protection = { locked: false }; }
  });
  ws.protect('', { selectLockedCells: true, selectUnlockedCells: true, formatColumns: true, formatRows: true, autoFilter: true, sort: false });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
}

export async function writeSheet(outFile, root = ROOT) {
  const { phrases, terms } = buildRows(root);
  const wb = new ExcelJS.Workbook();
  phraseSheet(wb, SHEET_PHRASE, phrases);
  termSheet(wb, terms);
  phraseSheet(wb, SHEET_WARN, phrases.filter((p) => p.경고));
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  await wb.xlsx.writeFile(outFile);
  return { 문구: phrases.length, 용어: terms.length, 경고: phrases.filter((p) => p.경고).length };
}

// ---- 되넣기 ----
// 시트의 데이터 줄 → { 머리글: 글자 }[]  (머리글 이름으로 읽어 열 순서가 바뀌어도 된다)
function readRows(ws) {
  const head = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { head[i] = cellText(c.value).trim(); });
  const out = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const o = { _줄: n };
    head.forEach((h, i) => { if (h) o[h] = cellText(row.getCell(i).value); });
    out.push(o);
  });
  return out;
}

// 소스 속 JSON 문자열 한 칸만 바꾼다. 시작 위치(from) 뒤의 첫 `"이름": "…"` 를 찾는다.
const JSON_STR = '"(?:[^"\\\\]|\\\\.)*"';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function replaceStringAfter(src, from, name, value) {
  const re = new RegExp(`("${esc(name)}"\\s*:\\s*)${JSON_STR}`, 'g');
  re.lastIndex = from;
  const m = re.exec(src);
  if (!m) return null;
  return src.slice(0, m.index) + m[1] + JSON.stringify(value) + src.slice(m.index + m[0].length);
}
function replaceArrayAfter(src, from, name, list) {
  const re = new RegExp(`("${esc(name)}"\\s*:\\s*)\\[[^\\]]*\\]`, 'g');
  re.lastIndex = from;
  const m = re.exec(src);
  if (!m) return null;
  return src.slice(0, m.index) + m[1] + JSON.stringify(list) + src.slice(m.index + m[0].length);
}
function indexOfKey(src, name, from = 0) {
  const m = new RegExp(`"${esc(name)}"\\s*:\\s*\\{`).exec(src.slice(from));
  return m ? from + m.index : -1;
}
const tokens = (s) => varsOf(s).sort().join('|') + '#' + [...String(s).matchAll(/\{[^{}\s]+\}/g)].length;

// applySheet — 검수표 → 정본. dry 면 쓰지 않고 계획만 낸다. { 바뀜: [{키,앞,뒤}], 안넣음: [{키,줄,사유}] }
export async function applySheet(file, root = ROOT, { dry = false } = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const glossary = readTextFile('glossary.js', root);
  const 안넣음 = [];
  const 바뀜 = [];
  const sources = new Map(); // 파일 이름 → 고친 소스
  const parsed = new Map();
  const load = (f) => { if (!sources.has(f)) sources.set(f, fs.readFileSync(path.join(root, TEXT_DIR, f), 'utf8')); return sources.get(f); };
  const obj = (f) => { if (!parsed.has(f)) parsed.set(f, readTextFile(f, root)); return parsed.get(f); };

  // 문구: 「문구」·「경고만」 시트의 같은 키가 서로 다른 글을 가리키면 둘 다 안 넣는다
  const want = new Map(); // 키 → { 뒤, 줄, 지금, 메모 }
  for (const name of [SHEET_PHRASE, SHEET_WARN]) {
    const ws = wb.getWorksheet(name);
    if (!ws) continue;
    for (const r of readRows(ws)) {
      const 뒤 = nl(r['고칠 문구']).trim();
      if (!뒤) continue;
      const prev = want.get(r['키']);
      if (prev && prev.뒤 !== 뒤) { 안넣음.push({ 키: r['키'], 줄: `${name} ${r._줄}`, 사유: '문구 시트와 경고만 시트가 서로 다른 글을 적음' }); prev.충돌 = true; continue; }
      want.set(r['키'], { 뒤, 줄: `${name} ${r._줄}`, 지금: nl(r['지금 문구']), 충돌: prev?.충돌 });
    }
  }
  for (const [key, w] of want) {
    if (w.충돌) continue;
    const [area, g, u, ...rest] = key.split('.');
    const f = `${area}.js`;
    const fail = (사유) => 안넣음.push({ 키: key, 줄: w.줄, 사유 });
    if (rest.length || !u || !fs.existsSync(path.join(root, TEXT_DIR, f)) || !isAreaFile(f)) { fail('정본에 없는 키'); continue; }
    const 앞 = obj(f)[g]?.[u];
    if (typeof 앞 !== 'string' || g.startsWith('_') || u.startsWith('_') || u.endsWith('?')) { fail('정본에 없는 키'); continue; }
    if (nl(앞) !== w.지금) { fail('검수표의 「지금 문구」가 정본과 다름(낡은 표 — 다시 뽑아서 고치세요)'); continue; }
    if (w.뒤 === nl(앞)) continue;
    if (tokens(앞) !== tokens(w.뒤)) { fail(`{변수}가 한 벌 그대로가 아님 — 정본 {${varsOf(앞).join(',')}} · 새 글 {${varsOf(w.뒤).join(',')}} (같은 변수를 같은 수만큼)`); continue; }
    const badTerm = termsOf(w.뒤).find((t) => !glossary[t] || glossary[t].낱말없음);
    if (badTerm) { fail(`[[${badTerm}]] 이 용어 사전에 없음`); continue; }
    const src = load(f);
    const gi = indexOfKey(src, g);
    const next = gi < 0 ? null : replaceStringAfter(src, gi, u, w.뒤);
    if (next == null) { fail('정본 파일에서 그 줄을 못 찾음'); continue; }
    sources.set(f, next);
    obj(f)[g][u] = w.뒤; // 쓴 뒤 다시 읽은 값과 맞춰 볼 기대값
    바뀜.push({ 키: key, 앞, 뒤: w.뒤 });
  }

  // 용어: 고칠 풀이 · 고칠 쓰지 않을 말
  const wsT = wb.getWorksheet(SHEET_TERM);
  if (wsT) {
    for (const r of readRows(wsT)) {
      const k = r['낱말'];
      const 새풀이 = nl(r['고칠 풀이']).trim();
      const 새금 = nl(r['고칠 쓰지 않을 말']).trim();
      if (!새풀이 && !새금) continue;
      const fail = (사유) => 안넣음.push({ 키: `용어.${k}`, 줄: `${SHEET_TERM} ${r._줄}`, 사유 });
      const gl = obj('glossary.js');
      const cur = gl[k];
      if (!cur || k.startsWith('_')) { fail('정본에 없는 낱말'); continue; }
      if (nl(cur.풀이 ?? '') !== nl(r['지금 풀이']) || (cur.쓰지않을말 ?? []).join(', ') !== nl(r['지금 쓰지 않을 말'])) { fail('검수표의 「지금 풀이」·「지금 쓰지 않을 말」이 정본과 다름(낡은 표)'); continue; }
      let src = load('glossary.js');
      const si = indexOfKey(src, k);
      if (si < 0) { fail('정본 파일에서 그 낱말을 못 찾음'); continue; }
      const edits = [];
      if (새풀이 && 새풀이 !== cur.풀이) {
        if (!새풀이.endsWith('.')) { fail('풀이는 합니다체 문장(마침표로 끝)이어야 함'); continue; }
        if (!('풀이' in cur)) { fail('이 낱말은 풀이 칸이 없음(풀이 없는 낱말은 표에서 못 만듦)'); continue; }
        const bad = termsOf(새풀이).find((t) => !glossary[t] || glossary[t].낱말없음);
        if (bad) { fail(`[[${bad}]] 이 용어 사전에 없음`); continue; }
        edits.push(['풀이', 새풀이]);
      }
      let list;
      if (새금) {
        list = 새금.split(/\s*,\s*/).filter(Boolean);
        const clash = list.find((w) => gl[w] && !gl[w].낱말없음);
        if (clash) { fail(`쓰지 않을 말 「${clash}」 가 화면 낱말이기도 함`); continue; }
        if (list.join(', ') !== (cur.쓰지않을말 ?? []).join(', ')) edits.push(['쓰지않을말', list]);
      }
      let ok = true;
      for (const [name, val] of edits) {
        const n2 = Array.isArray(val) ? replaceArrayAfter(src, si, name, val) : replaceStringAfter(src, si, name, val);
        if (n2 == null) { fail(`정본 파일에서 ${name} 칸을 못 찾음`); ok = false; break; }
        src = n2;
      }
      if (!ok || !edits.length) continue;
      sources.set('glossary.js', src);
      for (const [name, val] of edits) { 바뀜.push({ 키: `용어.${k}.${name}`, 앞: Array.isArray(val) ? (cur.쓰지않을말 ?? []).join(', ') : cur.풀이, 뒤: Array.isArray(val) ? val.join(', ') : val }); cur[name] = val; }
    }
  }

  // 쓰기 전 확인 — 고친 소스를 다시 읽어 기대값과 같은지 본다(틀리면 그 파일은 통째로 안 쓴다)
  const written = [];
  for (const [f, src] of sources) {
    if (src === fs.readFileSync(path.join(root, TEXT_DIR, f), 'utf8')) continue;
    const m = /^export default (\{[\s\S]*\});?\s*$/.exec(src);
    let again = null;
    try { again = m ? JSON.parse(m[1]) : null; } catch { again = null; }
    if (JSON.stringify(again) !== JSON.stringify(parsed.get(f))) {
      안넣음.push({ 키: f, 줄: '-', 사유: '고친 뒤 정본을 다시 읽은 값이 기대와 다름 — 이 파일은 쓰지 않음' });
      for (let i = 바뀜.length - 1; i >= 0; i--) if (바뀜[i].키.startsWith(f.replace(/\.js$/, '') + '.') || (f === 'glossary.js' && 바뀜[i].키.startsWith('용어.'))) 바뀜.splice(i, 1);
      continue;
    }
    if (!dry) fs.writeFileSync(path.join(root, TEXT_DIR, f), src);
    written.push(f);
  }
  return { 바뀜, 안넣음, 쓴파일: written };
}

// ---- 명령줄 ----
async function main(argv) {
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const out = flag('--out'), apply = flag('--apply');
  if (out) {
    const n = await writeSheet(out);
    console.log(`검수표를 뽑았다: ${out}\n  문구 ${n.문구}줄 · 용어 ${n.용어}줄 · 경고만 ${n.경고}줄`);
    return 0;
  }
  if (apply) {
    const r = await applySheet(apply, ROOT, { dry: argv.includes('--dry') });
    console.log(`${argv.includes('--dry') ? '(미리보기 — 쓰지 않음) ' : ''}바뀐 줄 ${r.바뀜.length}개 · 안 넣은 줄 ${r.안넣음.length}개`);
    for (const c of r.바뀜) console.log(`  ${c.키}\n    앞: ${c.앞}\n    뒤: ${c.뒤}`);
    for (const x of r.안넣음) console.log(`  안 넣음 ${x.키} (${x.줄}) — ${x.사유}`);
    return r.안넣음.length ? 2 : 0;
  }
  console.error('쓰는 법:\n  node scripts/text-sheet.js --out "<경로>.xlsx"\n  node scripts/text-sheet.js --apply "<경로>.xlsx" [--dry]');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
}
