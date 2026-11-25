#!/usr/bin/env node
// 문구 훑기 — 코드 속 한국어 리터럴을 세고(문구 폴더 밖), 문구 파일을 읽고, 지키는 검사(test/text-guard.test.js)와 검수표가 같이 쓴다.
// 토크나이저는 T-1340 실측(2,039개 / 91파일)에 쓴 것을 그대로 옮겼다 — 주석은 건너뛰고 따옴표·백틱·JSX 본문의 한글을 뽑는다.
//
//   node scripts/text-scan.js            파일별 지금 수와 기준 수를 견줘 찍는다(늘어난 파일이 있으면 exit 1)
//   node scripts/text-scan.js --rebase   기준 수 파일을 지금 수로 다시 쓴다 — 내려가기만. 올라간 칸이 있으면 멈춘다(exit 1)
//   node scripts/text-scan.js --rebase --allow-up   올라간 칸도 받아 쓴다(메인이 옛 문구 옮기기를 머지할 때만)
//   node scripts/text-scan.js --dump     리터럴을 「파일:줄<TAB>글」로 찍는다
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE = path.join(ROOT, 'test', 'text-guard.baseline.json');
export const SCAN_DIRS = ['web/src', 'server', 'shared'];
export const TEXT_DIR = 'shared/text';
// 한국어가 있어도 되는 곳(화면 글자가 아님) — 설계 6절 「허용 목록」. 이 밖의 한 줄 예외는 줄 끝 주석 `// 문구-예외: 사유`.
export const ALLOW = [
  /^shared\/text\//, /^shared\/codes\.js$/, /^server\/migrations\//, /^server\/presets\//, /^web\/src\/gen\/sample\.js$/,
];
export const EXCEPT_MARK = /\/\/\s*문구-예외\s*:/;

const H = /[가-힣]/;

// 리터럴 뽑기 — [{ line, s, kind: 'str'|'tpl'|'jsx', pos }]
export function scanSource(src, isJsx) {
  const res = []; let i = 0, line = 1; const n = src.length;
  let run = '', runLine = 0, runStart = 0;
  const flushRun = () => {
    if (run && H.test(run)) { const s = run.replace(/\s+/g, ' ').trim(); if (s) res.push({ line: runLine, s, kind: 'jsx', pos: runStart }); }
    run = '';
  };
  while (i < n) {
    const c = src[i];
    if (c === '\n') line++;
    if (c === '/' && src[i + 1] === '/') { flushRun(); while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { flushRun(); i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; } i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      // JSX 본문의 영어 아포스트로피(don't)는 글자로 본다
      if (c === "'" && /[A-Za-z]/.test(src[i - 1] || '') && /[A-Za-z]/.test(src[i + 1] || '')) { run += c; i++; continue; }
      flushRun();
      const q = c, startLine = line, pos = i; i++; let s = '', hasExpr = false;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { s += src[i] + src[i + 1]; if (src[i + 1] === '\n') line++; i += 2; continue; }
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
          hasExpr = true; let d = 1; let e = '${'; i += 2;
          while (i < n && d > 0) { if (src[i] === '{') d++; else if (src[i] === '}') d--; if (src[i] === '\n') line++; e += src[i]; i++; }
          s += e; continue;
        }
        if (src[i] === '\n') { line++; if (q !== '`') break; }
        s += src[i]; i++;
      }
      i++;
      if (H.test(s)) res.push({ line: startLine, s: s.replace(/\\n/g, '\n').replace(/\n/g, '\\n'), kind: hasExpr ? 'tpl' : 'str', pos });
      continue;
    }
    if (isJsx) {
      if (c === '<' || c === '{' || c === '}' || c === '>') { flushRun(); i++; continue; }
      if (H.test(c) || (run && c !== ';')) { if (!run) { runLine = line; runStart = i; } run += c; i++; continue; }
      i++; continue;
    }
    i++;
  }
  flushRun();
  return res;
}

function walk(d, acc = []) {
  if (!fs.existsSync(d)) return acc;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'fixtures') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, acc); else if (/\.(js|jsx|mjs)$/.test(e.name)) acc.push(p);
  }
  return acc;
}
const rel = (root, p) => path.relative(root, p).replace(/\\/g, '/');
export const allowed = (f) => ALLOW.some((re) => re.test(f));

// 코드 파일 목록(문구 폴더·허용 목록 포함 — 거르기는 부르는 쪽)
export function codeFiles(root = ROOT) {
  const out = [];
  for (const d of SCAN_DIRS) for (const p of walk(path.join(root, d))) out.push(rel(root, p));
  return out.sort();
}

// 파일 하나의 한국어 리터럴(문구-예외 줄 뺌)
export function literalsOf(f, root = ROOT) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  const lines = src.split('\n');
  return scanSource(src, f.endsWith('.jsx')).filter((it) => !EXCEPT_MARK.test(lines[it.line - 1] || ''));
}

// 허용 목록 밖 파일별 한국어 리터럴 수 — 0인 파일은 안 싣는다
export function countLiterals(root = ROOT) {
  const out = {};
  for (const f of codeFiles(root)) {
    if (allowed(f)) continue;
    const n = literalsOf(f, root).length;
    if (n) out[f] = n;
  }
  return out;
}

// 문구 파일 — 이름 목록(index.js 빼고)
export function textFiles(root = ROOT) {
  return fs.readdirSync(path.join(root, TEXT_DIR)).filter((n) => n.endsWith('.js') && n !== 'index.js').sort();
}

// `export default {JSON};` 꼴만 받는다. 꼴이 틀리면 던진다.
export function readTextFile(file, root = ROOT) {
  const src = fs.readFileSync(path.join(root, TEXT_DIR, file), 'utf8');
  const m = /^export default (\{[\s\S]*\});?\s*$/.exec(src);
  if (!m) throw new Error(`${file}: export default {JSON}; form required`);
  return JSON.parse(m[1]);
}

// 영역 파일의 문구 목록 — [{ key, s }] (묶음·쓰임이 _ 로 시작하거나 ? 로 끝나면 문구 아님)
export function phrasesOf(area, obj) {
  const out = [];
  for (const [g, grp] of Object.entries(obj)) {
    if (g.startsWith('_') || !grp || typeof grp !== 'object') continue;
    for (const [u, s] of Object.entries(grp)) {
      if (u.startsWith('_') || u.endsWith('?')) continue;
      out.push({ key: `${area}.${g}.${u}`, s });
    }
  }
  return out;
}

// 쓰지 않을 말 세기 — 더 긴 화면 낱말·예외 안에 든 것은 봐준다(「기관」 ⊂ 「기관 관리자」)
export function forbiddenHits(s, glossary) {
  const entries = Object.entries(glossary).filter(([k, v]) => !k.startsWith('_') && v && typeof v === 'object');
  const shields = new Set();
  for (const [k, v] of entries) { if (!v.낱말없음) shields.add(k); for (const e of v.예외 || []) shields.add(e); }
  const spans = [];
  for (const w of shields) { let i = s.indexOf(w); while (i >= 0) { spans.push([i, i + w.length]); i = s.indexOf(w, i + 1); } }
  const hits = [];
  for (const [k, v] of entries) {
    for (const bad of v.쓰지않을말 || []) {
      let i = s.indexOf(bad);
      while (i >= 0) {
        const end = i + bad.length;
        if (!spans.some(([a, b]) => a <= i && end <= b && b - a > bad.length)) hits.push({ 낱말: k, 쓰지않을말: bad });
        i = s.indexOf(bad, i + 1);
      }
    }
  }
  return hits;
}

// 코드가 부르는 문구 키 — t('키', {…}) · <T k="키" v={{…}}> · fail(res, 409, '키', {…})
const CALLS = [
  /(?<![\w$.])t(?:\.raw)?\(\s*(['"`])([a-z][\w.]*)\1\s*(?:,\s*\{([^{}]*)\})?/g,
  /<T\s+k=(['"])([a-z][\w.]*)\1(?:\s+v=\{\{([^{}]*)\}\})?/g,
  /(?<![\w$.])fail\(\s*[\w$.]+\s*,\s*\d+\s*,\s*(['"`])([a-z][\w.]*)\1\s*(?:,\s*\{([^{}]*)\})?/g,
];
// 객체 글자 `{ 이름: x, 수 }` 의 키 이름들. 펼침(...)이 있으면 셀 수 없어 null.
function objKeys(body) {
  if (body == null) return [];
  if (/\.\.\./.test(body)) return null;
  return body.split(',').map((p) => p.trim()).filter(Boolean).map((p) => p.split(':')[0].trim().replace(/^['"]|['"]$/g, ''));
}
export function keyCalls(root = ROOT) {
  const out = [];
  for (const f of codeFiles(root)) {
    if (f.startsWith(TEXT_DIR + '/')) continue;
    // 주석 속 보기(예: fail(res, 409, '…'))는 부른 것이 아니다 — 줄 수는 두고 주석만 지운다
    const src = fs.readFileSync(path.join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|\s)\/\/[^\n]*/g, '$1');
    for (const re of CALLS) {
      for (const m of src.matchAll(re)) {
        const line = src.slice(0, m.index).split('\n').length;
        const next = src.slice(m.index + m[0].length).trimStart();
        // 변수 객체를 글자로 못 읽으면(이름 있는 값·중괄호 든 값) null — 변수 대조를 건너뛴다
        const vars = m[3] !== undefined ? objKeys(m[3]) : next.startsWith(',') || next.startsWith('v=') ? null : [];
        out.push({ f, line, key: m[2], vars });
      }
    }
  }
  return out;
}

// 시험 파일의 리터럴(시험 사본 세기용)
export function testLiterals(root = ROOT) {
  const out = [];
  for (const p of walk(path.join(root, 'test'))) {
    const f = rel(root, p);
    for (const it of scanSource(fs.readFileSync(p, 'utf8'), false)) out.push({ f, line: it.line, s: it.s });
  }
  return out;
}

// 모든 문구(영역 파일) — [{ key, s }]
export function allPhrases(root = ROOT) {
  const out = [];
  for (const file of textFiles(root)) {
    const area = file.replace(/\.js$/, '');
    if (area === 'glossary' || area === 'labels') continue;
    out.push(...phrasesOf(area, readTextFile(file, root)));
  }
  return out;
}

// 시험 사본 — 시험 리터럴 가운데 문구 값과 글자가 똑같은 것(8자 이상)
export const COPY_MIN = 8;
export function testCopies(root = ROOT) {
  const vals = new Set(allPhrases(root).map((p) => p.s).filter((s) => typeof s === 'string' && s.length >= COPY_MIN));
  return testLiterals(root).filter((it) => vals.has(it.s));
}

// 기준 수와 견줄 지금 수 셋
export function measure(root = ROOT) {
  const glossary = readTextFile('glossary.js', root);
  const 쓰지않을말 = allPhrases(root).reduce((n, p) => n + (typeof p.s === 'string' ? forbiddenHits(p.s, glossary).length : 0), 0);
  return { 한국어리터럴: countLiterals(root), 쓰지않을말, 시험사본: testCopies(root).length };
}

export function readBaseline(file = BASELINE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const BASELINE_NOTE = '문구 지키는 검사(test/text-guard.test.js)의 기준 수. 한국어리터럴 = 문구 폴더·허용 목록 밖 파일별 한국어 리터럴 수(없는 파일은 0) · 쓰지않을말 = 문구에 든 쓰지 않을 말 수 · 시험사본 = 문구와 글자가 똑같은 시험 리터럴 수. 이 수를 넘으면 빨강. 메인만 고친다: node scripts/text-scan.js --rebase (내려가기만).';

// 기준 수 파일 꼴: { "_설명": …, "한국어리터럴": { 파일: 수 }, "쓰지않을말": 수, "시험사본": 수 }
export function writeBaseline(b, file = BASELINE) {
  const lit = Object.fromEntries(Object.entries(b.한국어리터럴).sort(([a], [c]) => (a < c ? -1 : 1)));
  fs.writeFileSync(file, JSON.stringify({ ...b, 한국어리터럴: lit }, null, 2) + '\n');
}

function main(argv) {
  if (argv.includes('--dump')) {
    for (const f of codeFiles()) { if (allowed(f)) continue; for (const it of literalsOf(f)) console.log(`${f}:${it.line}\t${it.s}`); }
    return 0;
  }
  const now = measure();
  const base = fs.existsSync(BASELINE) ? readBaseline() : { 한국어리터럴: {}, 쓰지않을말: 0, 시험사본: 0 };
  const ups = [];
  const files = new Set([...Object.keys(now.한국어리터럴), ...Object.keys(base.한국어리터럴)]);
  let total = 0, baseTotal = 0;
  for (const f of [...files].sort()) {
    const a = now.한국어리터럴[f] || 0, b = base.한국어리터럴[f] || 0;
    total += a; baseTotal += b;
    if (a > b) ups.push(`${f}: ${b} -> ${a}`);
    else if (a < b && !argv.includes('--rebase')) console.log(`down ${f}: ${b} -> ${a}`);
  }
  for (const k of ['쓰지않을말', '시험사본']) if ((now[k] || 0) > (base[k] || 0)) ups.push(`${k}: ${base[k] || 0} -> ${now[k]}`);
  console.log(`literals ${total} (baseline ${baseTotal}) in ${Object.keys(now.한국어리터럴).length} files · forbidden words ${now.쓰지않을말} · test copies ${now.시험사본}`);
  if (argv.includes('--rebase')) {
    if (ups.length && !argv.includes('--allow-up')) { console.error('rebase stopped — counts went up:\n  ' + ups.join('\n  ')); return 1; }
    writeBaseline({ _설명: base._설명 || BASELINE_NOTE, ...now });
    console.log(`baseline written: ${path.relative(ROOT, BASELINE)}`);
    return 0;
  }
  if (ups.length) { console.error('over baseline:\n  ' + ups.join('\n  ')); return 1; }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
