import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 훅 순서 정적 검사 — React #310(「Rendered more hooks than during the previous render」) 재발 막기(T-1204v · T-1206h).
// web/ 에 eslint-plugin-react-hooks 를 들이지 않고, 의존성 없는 토크나이저로 web/src 의 함수마다 본다:
//  ① 같은 함수에서 return 뒤에 use*() 를 부르면 실패(early return 뒤 훅)
//  ② if/for/while/switch/try 블록 안에서 use*() 를 부르면 실패(조건부 훅)
//  ③ use*() 바로 앞이 && · || · ?? · ? · : 이면 실패(cond && useX() 꼴)

const KEYWORD_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);
const BLOCK_HEADS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
const BLOCK_WORDS = new Set(['else', 'try', 'finally', 'do']);
const isIdStart = (c) => /[A-Za-z_$\u0080-￿]/.test(c);
const isId = (c) => /[A-Za-z0-9_$\u0080-￿]/.test(c);

// 토큰: { t: 'id' | 'p' | 'lit', v, line }. JSX 글자·문자열·주석·정규식은 lit 로 접거나 버린다.
export function tokenize(src) {
  const out = [];
  let i = 0;
  let line = 1;
  const push = (t, v) => out.push({ t, v, line });
  const prevSig = () => out[out.length - 1];
  const exprStart = () => { // 지금 자리가 「값이 올 자리」인가 — 정규식·JSX 판정
    const p = prevSig();
    if (!p) return true;
    if (p.t === 'lit') return false;
    if (p.t === 'id') return KEYWORD_BEFORE_REGEX.has(p.v);
    return ![')', ']', '}'].includes(p.v);
  };
  const adv = (n = 1) => { for (let k = 0; k < n; k++) { if (src[i] === '\n') line++; i++; } };
  const skipWs = () => { while (i < src.length && /\s/.test(src[i])) adv(); };
  function str(q) { adv(); while (i < src.length && src[i] !== q) { if (src[i] === '\\') adv(); adv(); } adv(); push('lit', 'str'); }
  function template() {
    adv();
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { adv(2); continue; }
      if (src[i] === '$' && src[i + 1] === '{') { adv(2); push('p', '('); code('}'); push('p', ')'); adv(); continue; }
      adv();
    }
    adv(); push('lit', 'tpl');
  }
  function regex() {
    adv(); let cls = false;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { adv(2); continue; }
      if (c === '[') cls = true; else if (c === ']') cls = false; else if (c === '/' && !cls) break;
      adv();
    }
    adv(); while (isId(src[i] || '')) adv();
    push('lit', 're');
  }
  // JSX 원소 하나 — 속성 {식} 과 자식 {식} 만 코드로 읽고 글자는 버린다
  function jsx() {
    adv(); // <
    if (src[i] === '>') { adv(); children(); return; } // <> 조각
    while (i < src.length && /[^\s/>{]/.test(src[i])) adv(); // 태그 이름
    for (;;) {
      skipWs();
      const c = src[i];
      if (c === '/' && src[i + 1] === '>') { adv(2); return; }
      if (c === '>') { adv(); children(); return; }
      if (c === '{') { adv(); push('p', '('); code('}'); push('p', ')'); adv(); continue; }
      if (c === '"' || c === "'") { const q = c; adv(); while (src[i] !== q) adv(); adv(); continue; }
      if (i >= src.length) throw new Error(`JSX 태그가 안 닫힘 (줄 ${line})`);
      adv(); // 속성 이름·=
    }
  }
  function children() {
    for (;;) {
      if (i >= src.length) throw new Error(`JSX 자식이 안 닫힘 (줄 ${line})`);
      const c = src[i];
      if (c === '<' && src[i + 1] === '/') { while (src[i] !== '>') adv(); adv(); return; }
      if (c === '<') { jsx(); continue; }
      if (c === '{') { adv(); push('p', '('); code('}'); push('p', ')'); adv(); continue; }
      adv();
    }
  }
  // 코드 읽기 — end 글자(짝 맞는 깊이 0)에서 멈춘다
  function code(end) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      const d = src[i + 1];
      if (/\s/.test(c)) { adv(); continue; }
      if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') adv(); continue; }
      if (c === '/' && d === '*') { adv(2); while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) adv(); adv(2); continue; }
      if (c === '"' || c === "'") { str(c); continue; }
      if (c === '`') { template(); continue; }
      if (c === '/' && exprStart()) { regex(); continue; }
      if (c === '<' && exprStart() && (isIdStart(d) || d === '>')) { jsx(); push('lit', 'jsx'); continue; }
      if (isIdStart(c)) { const s = i; while (i < src.length && isId(src[i])) adv(); push('id', src.slice(s, i)); continue; }
      if (/[0-9]/.test(c)) { while (i < src.length && /[0-9A-Za-z_.]/.test(src[i])) adv(); push('lit', 'num'); continue; }
      if (end && c === end && depth === 0) return;
      const three = src.slice(i, i + 3);
      const two = src.slice(i, i + 2);
      const op = ['...', '===', '!==', '??=', '&&=', '||='].includes(three) ? three : ['=>', '&&', '||', '??', '?.', '==', '!=', '<=', '>=', '++', '--', '+=', '-='].includes(two) ? two : c;
      if (op === '{' || op === '(' || op === '[') depth++;
      if (op === '}' || op === ')' || op === ']') depth--;
      push('p', op); adv(op.length);
    }
    if (end) throw new Error(`「${end}」 가 안 닫힘`);
  }
  code(null);
  return out;
}

// 함수마다 훅 규칙을 본다. 반환: [{ line, rule, hook }]
export function hookProblems(src) {
  const toks = tokenize(src);
  const parenOpen = []; // ( 짝 찾기
  const matchOf = new Map();
  toks.forEach((tk, k) => {
    if (tk.t !== 'p') return;
    if (tk.v === '(') parenOpen.push(k);
    if (tk.v === ')') matchOf.set(k, parenOpen.pop());
  });
  const root = { kind: 'fn', returned: false };
  const stack = [root];
  const fnOf = () => { for (let k = stack.length - 1; k >= 0; k--) if (stack[k].kind === 'fn') return stack[k]; return root; };
  const inBlock = () => { for (let k = stack.length - 1; k >= 0; k--) { if (stack[k].kind === 'fn') return false; if (stack[k].kind === 'block') return true; } return false; };
  const found = [];
  toks.forEach((tk, k) => {
    const prev = toks[k - 1];
    if (tk.t === 'p' && tk.v === '{') {
      let kind = 'obj';
      if (prev?.v === '=>') kind = 'fn';
      else if (prev?.t === 'id' && BLOCK_WORDS.has(prev.v)) kind = 'block';
      else if (prev?.v === ')') {
        const head = toks[matchOf.get(k - 1) - 1];
        kind = head?.t === 'id' && BLOCK_HEADS.has(head.v) ? 'block' : 'fn';
      }
      stack.push({ kind, returned: false });
      return;
    }
    if (tk.t === 'p' && tk.v === '}') { if (stack.length > 1) stack.pop(); return; }
    if (tk.t === 'id' && tk.v === 'return') { fnOf().returned = true; return; }
    if (tk.t === 'id' && /^use[A-Z]/.test(tk.v) && toks[k + 1]?.v === '(' && prev?.v !== '.' && prev?.v !== '?.' && prev?.v !== 'function') {
      if (fnOf().returned) found.push({ line: tk.line, rule: 'return 뒤 훅', hook: tk.v });
      else if (inBlock()) found.push({ line: tk.line, rule: '블록 안 훅', hook: tk.v });
      else if (['&&', '||', '??', '?', ':'].includes(prev?.v)) found.push({ line: tk.line, rule: '조건식 안 훅', hook: tk.v });
    }
  });
  if (stack.length !== 1) throw new Error(`중괄호 짝이 안 맞음(남은 깊이 ${stack.length - 1})`);
  return found;
}

const webSrc = fileURLToPath(new URL('../web/src/', import.meta.url));
function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(jsx?|mjs)$/.test(n) ? [p] : [];
  });
}

test('훅 검사기: 심은 버그를 잡는다', () => {
  const cases = {
    'return 뒤 훅': 'function A({ ok }) {\n  const [a] = useState(0);\n  if (!ok) return null;\n  useEffect(() => {}, []);\n  return <div>{a}</div>;\n}',
    '블록 안 훅': 'function A({ ok }) {\n  if (ok) {\n    useEffect(() => {}, []);\n  }\n  return <p>it\'s {ok}</p>;\n}',
    '조건식 안 훅': 'const A = ({ ok }) => {\n  const v = ok && useMemo(() => 1, []);\n  return <b>{v}</b>;\n};',
  };
  for (const [rule, code] of Object.entries(cases)) assert.deepEqual(hookProblems(code).map((f) => f.rule), [rule], rule);
  // 안쪽 함수의 return 은 바깥 컴포넌트를 「돌아간 것」으로 만들지 않는다 · a < b 는 JSX 가 아니다 · 정규식 안 { 무시
  const ok = 'function A({ n }) {\n  const f = () => { return n < 2; };\n  const re = /[{(]/g;\n  const [x] = useState(() => { if (n) { return 1; } return 2; });\n  useEffect(() => { if (!n) return; f(); }, [n]);\n  return <div title={`a${n}`}>{n > 1 ? <i>{x}</i> : null}</div>;\n}';
  assert.deepEqual(hookProblems(ok), []);
});

test('web/src 의 모든 함수: 훅은 return·조건 앞에서 늘 같은 순서로 부른다', () => {
  const files = walk(webSrc);
  assert.ok(files.length > 20, `web/src 파일을 못 찾음(${files.length})`);
  const bad = [];
  for (const f of files) {
    let found;
    try { found = hookProblems(readFileSync(f, 'utf8')); } catch (e) { bad.push(`${f}: 읽기 실패 — ${e.message}`); continue; }
    for (const x of found) bad.push(`${f.slice(webSrc.length)}:${x.line} ${x.rule} ${x.hook}()`);
  }
  assert.deepEqual(bad, []);
});
