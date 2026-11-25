// 문구 읽기 — 화면·서버·출력물이 같은 t() 하나로 shared/text/<영역>.js 의 문구를 읽는다.
// 설계: 볼트 「화면 문구 분리 설계 (2026-11-25)」 1·2·4절. 언어는 하나라 언어 상태·번역 라이브러리는 없다.
// 키는 「영역.묶음.쓰임」(영역 = 파일 이름). 변수는 한글 이름 {이름}. 변수 바로 뒤 (을/를) 같은 조사 표시는 받침을 보고 고른다.
// 꾸밈은 둘만: [[낱말]] = 낱말 풀이(화면은 <T> 가 <Term> 으로 그림) · **굵게**. t() 는 꾸밈을 벗긴 글자를 준다.
import common from './common.js';
import roster from './roster.js';
import signup from './signup.js';
import notify from './notify.js';
import board from './board.js';
import school from './school.js';
import grid from './grid.js';
import generate from './generate.js';
import rules from './rules.js';
import operations from './operations.js';
import attendance from './attendance.js';
import output from './output.js';
import admin from './admin.js';
import settings from './settings.js';
import guide from './guide.js';
import audit from './audit.js';
import glossary from './glossary.js';
import labels from './labels.js';

// 영역 파일 — 파일 이름이 키의 첫 토막이다. 새 영역 파일을 만들면 여기와 scripts/text-scan.js 의 AREA_FILES 를 같이 늘린다.
export const AREAS = { common, roster, signup, notify, board, school, grid, generate, rules, operations, attendance, output, admin, settings, guide, audit };
export const GLOSSARY_TABLE = glossary;
export const LABELS = labels;

// 시험(node --test) 안에서는 없는 키·빠진 변수를 던지고, 운영에선 ⟦키⟧ 를 내고 죽지 않는다.
const env = globalThis.process?.env ?? {};
export const STRICT = Boolean(env.NODE_TEST_CONTEXT) || env.NODE_ENV === 'test';

const VAR = /\{([^{}\s]+)\}(\((?:을\/를|를\/을|이\/가|가\/이|은\/는|는\/은|와\/과|과\/와|으로\/로|로\/으로|이랑\/랑|아\/야|이에요\/예요)\))?/g;
const PAIRS = { // [받침 있을 때, 없을 때]
  '을/를': ['을', '를'], '를/을': ['을', '를'], '이/가': ['이', '가'], '가/이': ['이', '가'],
  '은/는': ['은', '는'], '는/은': ['은', '는'], '와/과': ['과', '와'], '과/와': ['과', '와'],
  '이랑/랑': ['이랑', '랑'], '아/야': ['아', '야'], '이에요/예요': ['이에요', '예요'],
};
// 숫자·영문으로 끝나면 읽는 소리로 받침을 본다(0 영 · 1 일 · 3 삼 · 6 육 · 7 칠 · 8 팔 · 10 십 → 받침, ㄹ 은 으로/로 에서 「로」).
const DIGIT_JONG = { 0: 21, 1: 8, 2: 0, 3: 16, 4: 0, 5: 0, 6: 1, 7: 8, 8: 8, 9: 0 };
function jongOf(word) {
  const s = String(word).trim();
  const c = s.charCodeAt(s.length - 1);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28;
  const ch = s[s.length - 1];
  if (ch >= '0' && ch <= '9') return DIGIT_JONG[ch];
  if (/[lmnLMN]/.test(ch)) return ch.toLowerCase() === 'l' ? 8 : 4;
  return 0; // 그 밖(영문 모음·기호)은 받침 없음으로 본다
}

// 변수 바로 뒤 조사 표시를 받침으로 고른다. 예: josa('학교', '으로/로') → '로'
export function josa(word, pair) {
  const j = jongOf(word);
  if (pair === '으로/로' || pair === '로/으로') return j === 0 || j === 8 ? '로' : '으로';
  const p = PAIRS[pair];
  if (!p) throw new Error(`unknown josa pair: ${pair}`);
  return j ? p[0] : p[1];
}

// 문구 안의 변수 이름 목록(같은 이름은 한 번)
export function varsOf(s) {
  const out = new Set();
  for (const m of String(s).matchAll(VAR)) out.add(m[1]);
  return [...out];
}

// [[낱말]] 목록
export function termsOf(s) {
  return [...String(s).matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
}

export const stripMarks = (s) => String(s).replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1');

// 키로 문구 원문(꾸밈·변수 그대로)을 찾는다. 없으면 undefined.
export function makeLookup(areas) {
  return (key) => {
    const [area, group, use, ...rest] = String(key).split('.');
    if (rest.length || use === undefined) return undefined;
    const v = areas[area]?.[group]?.[use];
    return typeof v === 'string' && !group.startsWith('_') && !use.startsWith('_') && !use.endsWith('?') ? v : undefined;
  };
}

// 변수 채우기(꾸밈은 그대로 둔다 — <T> 가 그린다)
export function fill(raw, vars = {}, key = '', strict = STRICT) {
  return raw.replace(VAR, (whole, name, pair) => {
    if (!(name in vars) || vars[name] == null) {
      if (strict) throw new Error(`text var missing: ${key} {${name}}`);
      return whole;
    }
    const v = String(vars[name]);
    return pair ? v + josa(v, pair.slice(1, -1)) : v;
  });
}

// t 만들기 — 시험이 가짜 영역 표를 넣어 볼 수 있게 표를 받는다.
export function makeT(areas, strict = STRICT) {
  const lookup = makeLookup(areas);
  const raw = (key, vars) => {
    const r = lookup(key);
    if (r === undefined) {
      if (strict) throw new Error(`text key missing: ${key}`);
      return `⟦${key}⟧`;
    }
    return fill(r, vars, key, strict);
  };
  const t = (key, vars) => stripMarks(raw(key, vars));
  t.raw = raw; // 꾸밈을 벗기지 않은 글(<T> 용)
  t.has = (key) => lookup(key) !== undefined;
  return t;
}

export const t = makeT(AREAS);

// 낱말 풀이 — { 낱말: 풀이 }. 풀이가 있는 낱말만. 화면의 <Term> 과 도움말 용어표가 읽는다.
export const GLOSSARY = Object.fromEntries(
  Object.entries(glossary).filter(([k, v]) => !k.startsWith('_') && v && typeof v.풀이 === 'string' && v.풀이).map(([k, v]) => [k, v.풀이]),
);

// 저장 값 → 화면 낱말. 예: 값이름('membership.status', '사용') → labels.js 의 membership.status.사용
export function makeValueName(table, strict = STRICT) {
  return (field, value) => {
    const [tbl, col] = String(field).split('.');
    const v = table[tbl]?.[col]?.[value];
    if (typeof v === 'string') return v;
    if (strict) throw new Error(`label missing: ${field} = ${value}`);
    return value == null ? '' : String(value);
  };
}
export const 값이름 = makeValueName(labels);
