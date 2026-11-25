// 문구 지키는 검사 — 설계 「화면 문구 분리 설계 (2026-11-25)」 6절.
// 문구 폴더(shared/text) 밖 한국어 리터럴이 기준 수보다 늘면 빨강 · 새 파일은 처음부터 0 · 키·변수·낱말·파일 꼴·쓰지 않을 말·시험 사본.
// 기준 수(test/text-guard.baseline.json)는 메인만 고친다: node scripts/text-scan.js --rebase
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROOT, codeFiles, allowed, literalsOf, countLiterals, textFiles, readTextFile, allPhrases, forbiddenHits, keyCalls,
  testCopies, readBaseline,
} from '../scripts/text-scan.js';
import { AREAS, t, makeT, makeValueName, josa, varsOf, termsOf, stripMarks, GLOSSARY, STRICT } from '../shared/text/index.js';
import { GLOSSARY as WEB_GLOSSARY } from '../web/src/glossary.js';
import { makeFail } from '../server/fail.js';

const base = readBaseline();

test('text-guard: 문구 폴더 밖 한국어 리터럴이 파일별 기준 수를 넘지 않는다(새 파일은 0)', () => {
  const now = countLiterals();
  const over = [];
  for (const [f, n] of Object.entries(now)) {
    const b = base.한국어리터럴[f] ?? 0;
    if (n > b) {
      const sample = literalsOf(f).slice(0, 3).map((it) => `    ${f}:${it.line} ${it.s}`).join('\n');
      over.push(`${f}: ${n} > ${b}${b ? '' : ' (기준에 없는 파일은 0)'}\n${sample}`);
    }
  }
  assert.deepEqual(over, [], '한국어 글자는 shared/text/<영역>.js 에 넣고 t()·<T>·fail() 로 쓴다.\n' + over.join('\n'));
});

test('text-guard: 기준 수 파일에 허용 목록 파일이나 없는 파일이 없다', () => {
  const files = new Set(codeFiles());
  for (const f of Object.keys(base.한국어리터럴)) {
    assert.ok(files.has(f), `기준에 있는데 없는 파일: ${f} — 메인이 --rebase`);
    assert.ok(!allowed(f), `허용 목록 파일이 기준에 있음: ${f}`);
  }
});

test('text-guard: 문구 파일은 export default {JSON} 꼴 · 영역 이름 · 묶음마다 _자리', () => {
  const files = textFiles();
  assert.deepEqual(files.filter((f) => !['glossary.js', 'labels.js'].includes(f)).map((f) => f.replace(/\.js$/, '')).sort(), Object.keys(AREAS).sort(), 'shared/text 의 영역 파일과 index.js 의 AREAS 가 같아야 한다');
  for (const file of files) {
    const obj = readTextFile(file);
    assert.equal(typeof obj._영역, 'string', `${file}: _영역`);
    if (file === 'glossary.js') continue;
    for (const [g, grp] of Object.entries(obj)) {
      if (g.startsWith('_')) continue;
      assert.match(g, /^[a-z][a-z0-9_]*$/, `${file}: 묶음 이름은 영어 소문자 — ${g}`);
      assert.ok(grp && typeof grp === 'object' && !Array.isArray(grp), `${file}: ${g} 는 묶음(객체)`);
      assert.ok(typeof grp._자리 === 'string' && grp._자리.trim(), `${file}: ${g} 에 _자리 한 줄`);
      for (const [u, v] of Object.entries(grp)) {
        if (u.startsWith('_')) continue;
        if (file === 'labels.js') {
          assert.ok(v && typeof v === 'object', `labels.js: ${g}.${u} 는 { 저장 값: 화면 낱말 }`);
          for (const [val, name] of Object.entries(v)) assert.equal(typeof name, 'string', `labels.js: ${g}.${u}.${val}`);
          continue;
        }
        assert.equal(typeof v, 'string', `${file}: ${g}.${u} 는 문자열`);
        if (u.endsWith('?')) assert.ok(u.slice(0, -1) in grp, `${file}: ${g}.${u} 가 설명하는 키가 없음`);
        else assert.match(u, /^[a-z][a-z0-9_]*$/, `${file}: 쓰임 이름은 영어 소문자 — ${g}.${u}`);
      }
    }
  }
});

test('text-guard: 코드가 부르는 키가 문구 파일에 있고 변수가 한 벌로 맞는다', () => {
  const bad = [];
  for (const c of keyCalls()) {
    if (!t.has(c.key)) { bad.push(`${c.f}:${c.line} 없는 키 ${c.key}`); continue; }
    if (c.vars === null) continue;
    const want = varsOf(rawOf(c.key)).sort();
    const got = [...c.vars].sort();
    if (want.join() !== got.join()) bad.push(`${c.f}:${c.line} ${c.key} 변수 {${want.join(',')}} ≠ 넘긴 것 {${got.join(',')}}`);
  }
  assert.deepEqual(bad, []);
});
function rawOf(key) {
  const [a, g, u] = key.split('.');
  return AREAS[a][g][u];
}

test('text-guard: 문구의 [[낱말]] 은 용어 사전에 있다', () => {
  const glossary = readTextFile('glossary.js');
  const bad = [];
  for (const p of allPhrases()) for (const w of termsOf(p.s)) if (!glossary[w] || glossary[w].낱말없음) bad.push(`${p.key}: [[${w}]]`);
  assert.deepEqual(bad, []);
});

test('text-guard: 쓰지 않을 말·시험 사본이 기준 수를 넘지 않는다', () => {
  const glossary = readTextFile('glossary.js');
  const hits = allPhrases().flatMap((p) => forbiddenHits(p.s, glossary).map((h) => `${p.key}: 「${h.쓰지않을말}」 → 「${h.낱말}」`));
  assert.ok(hits.length <= base.쓰지않을말, `쓰지 않을 말 ${hits.length} > 기준 ${base.쓰지않을말}\n` + hits.join('\n'));
  const copies = testCopies();
  assert.ok(copies.length <= base.시험사본, `시험이 문구를 베껴 쥠 ${copies.length} > 기준 ${base.시험사본} — t('키') 로 읽어 비교\n` + copies.map((c) => `${c.f}:${c.line} ${c.s}`).join('\n'));
});

test('text-guard: 용어 사전 — 0.2.2 낱말 풀이 27개가 다 있고 꼴이 맞는다', () => {
  const OLD = ['시간표 격자', '교시', '시수', '시수표', '담임', '전담', '비교과', '연강', '진도 맞춤', '특별실', '시안', '확정', '고정', '금지', '권장 규칙', '규칙 수위', '가중', '라운드로빈', '교사 티어', '복식 학급', '소규모교', '결강', '보결', '형평성', '근태', '마감', '기록'];
  assert.equal(OLD.length, 27);
  for (const w of OLD) assert.ok(GLOSSARY[w]?.length > 10, `옛 낱말 ${w}`);
  const glossary = readTextFile('glossary.js');
  for (const [k, v] of Object.entries(glossary)) {
    if (k.startsWith('_')) continue;
    assert.equal(typeof v.묶음, 'string', `${k}.묶음`);
    assert.ok(Array.isArray(v.쓰지않을말), `${k}.쓰지않을말`);
    for (const f of ['문맥말', '예외']) if (f in v) assert.ok(Array.isArray(v[f]), `${k}.${f}`);
    if ('풀이' in v) assert.ok(typeof v.풀이 === 'string' && v.풀이.endsWith('.'), `${k}.풀이 는 합니다체 문장`);
    for (const bad of v.쓰지않을말) assert.ok(!(bad in glossary) || glossary[bad].낱말없음, `${k}: 쓰지 않을 말 「${bad}」 가 화면 낱말이기도 하다`);
  }
  // 정본 표(11-25)의 새 영역 낱말 몇 개 — 옮김이 빠지지 않았나
  for (const w of ['기관 관리자', '총괄관리자', '명단 줄', '계정 연결', '연결 해제', '초대 코드', '승인 대기', '재직 상태', '전출 요청', '겸임', '도움·요청', '처리 상태', '공개 범위']) assert.ok(glossary[w], w);
  assert.deepEqual(WEB_GLOSSARY, GLOSSARY, 'web/src/glossary.js 는 다시 내보내기만');
});

test('text-guard: 쓰지 않을 말 — 더 긴 화면 낱말 안에 든 것은 봐주고 홀로 쓴 것은 짚는다', () => {
  const g = readTextFile('glossary.js');
  assert.equal(forbiddenHits('기관 관리자에게 물어보세요', g).length, 0);
  assert.equal(forbiddenHits('교직원 권한이에요', g).length, 0);
  assert.deepEqual(forbiddenHits('기관을 고르세요', g).map((h) => h.쓰지않을말), ['기관']);
  assert.deepEqual(forbiddenHits('학교 관리자에게 물어보세요', g).map((h) => h.쓰지않을말), ['학교 관리자']);
  assert.equal(forbiddenHits('로그인하세요', g).length, 0, '문맥말(로그)은 검사하지 않는다');
});

test('t(): 변수·조사·꾸밈·없는 키', () => {
  assert.equal(STRICT, true, 'node --test 안에서는 엄격');
  const tt = makeT({ x: { g: { _자리: '시험', a: '{이름} 선생님의 계정을 연결해요.', b: '{학교}(으로/로) 옮겼어요. {이름}(을/를) 찾았어요. {수}명(이/가) 아님', c: '[[시수표]]를 먼저 **넣어** 주세요.', 'a?': '설명' } } });
  assert.equal(tt('x.g.a', { 이름: '김하나' }), '김하나 선생님의 계정을 연결해요.');
  assert.equal(tt('x.g.b', { 학교: '가람초', 이름: '박', 수: 3 }), '가람초로 옮겼어요. 박을 찾았어요. 3명(이/가) 아님');
  assert.equal(tt('x.g.b', { 학교: '가람중학교', 이름: '이수', 수: 0 }), '가람중학교로 옮겼어요. 이수를 찾았어요. 0명(이/가) 아님');
  assert.equal(tt('x.g.b', { 학교: '한빛읍', 이름: 'Kim', 수: 1 }), '한빛읍으로 옮겼어요. Kim을 찾았어요. 1명(이/가) 아님');
  assert.equal(tt('x.g.c'), '시수표를 먼저 넣어 주세요.');
  assert.equal(tt.raw('x.g.c'), '[[시수표]]를 먼저 **넣어** 주세요.');
  assert.throws(() => tt('x.g.nope'), /text key missing: x\.g\.nope/);
  assert.throws(() => tt('x.g.a?'), /missing/, '설명 줄은 문구가 아니다');
  assert.throws(() => tt('x.g._자리'), /missing/);
  assert.throws(() => tt('x.g.a'), /text var missing: x\.g\.a \{이름\}/);
  const loose = makeT({ x: { g: { _자리: '시험', a: '{이름} 님' } } }, false);
  assert.equal(loose('x.g.zz'), '⟦x.g.zz⟧');
  assert.equal(loose('x.g.a'), '{이름} 님');
  assert.deepEqual(varsOf('{학교}(으로/로) {이름} {이름}(을/를)'), ['학교', '이름']);
  assert.deepEqual(termsOf('[[시수]]와 [[보결]]'), ['시수', '보결']);
  assert.equal(stripMarks('**가** [[나]]'), '가 나');
  assert.equal(josa('사과', '와/과'), '와');
  assert.equal(josa('책', '와/과'), '과');
  assert.equal(josa('물', '으로/로'), '로');
  assert.equal(josa('밥', '은/는'), '은');
  assert.equal(josa('7', '이/가'), '이');
});

test('값이름(): 저장 값 → 화면 낱말 · 없으면 시험에선 던진다', () => {
  const vn = makeValueName({ membership: { _자리: '명단', status: { 사용: '재직', 숨김: '퇴직' } } });
  assert.equal(vn('membership.status', '사용'), '재직');
  assert.throws(() => vn('membership.status', '없는값'), /label missing/);
  assert.equal(makeValueName({}, false)('a.b', 'x'), 'x');
});

test('fail(): 문장·코드·변수·깃발을 같이 싣는다', () => {
  const tt = makeT({ roster: { err: { _자리: '시험', already_linked: '{이름} 선생님은 이미 연결돼 있어요.' } } });
  let sent;
  const res = { status(s) { sent = { status: s }; return this; }, json(b) { sent.body = b; return this; } };
  makeFail(tt)(res, 409, 'roster.err.already_linked', { 이름: '김하나' }, { needConfirm: true });
  assert.deepEqual(sent, { status: 409, body: { error: '김하나 선생님은 이미 연결돼 있어요.', code: 'roster.err.already_linked', vars: { 이름: '김하나' }, needConfirm: true } });
});

test('text-scan: 토크나이저가 주석·문구-예외 줄은 빼고 리터럴·JSX 본문을 뽑는다', async () => {
  const { scanSource } = await import('../scripts/text-scan.js');
  const src = "// 주석 한글\nconst a = '하나';\n/* 둘 */ const b = `셋 ${x}`;\nconst c = <p>넷 {y} 다섯</p>;\n";
  assert.deepEqual(scanSource(src, true).map((i) => [i.line, i.s, i.kind]), [[2, '하나', 'str'], [3, '셋 ${x}', 'tpl'], [4, '넷', 'jsx'], [4, '다섯', 'jsx']]);
  assert.ok(ROOT);
});
