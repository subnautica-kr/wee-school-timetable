// JSX 에 쓴 대문자 컴포넌트 이름이 그 파일 안에서 정의(import·선언·매개변수)돼 있는지 센다.
// vite 빌드는 정의 안 된 JSX 이름을 통과시켜 화면에서야 ReferenceError 가 난다(T-1310c).
// 방법: 주석을 걷고, `<Name` · `</Name` 자리가 아닌 곳에 Name 이 한 번이라도 나오면 정의된 것으로 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'src');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.jsx')) out.push(p);
  }
  return out;
}

function undefinedTags(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const used = new Set([...code.matchAll(/<\/?([A-Z]\w*)/g)].map((m) => m[1]));
  return [...used].filter((n) => !new RegExp(String.raw`(?<!<|</)\b${n}\b`).test(code));
}

test('undefinedTags 는 import 빠진 이름을 잡는다 (검사기 자체 검산)', () => {
  assert.deepStrictEqual(undefinedTags('const a = <Foo x={1} />;'), ['Foo']);
  assert.deepStrictEqual(undefinedTags("import Foo from './F.jsx';\nconst a = <Foo />;"), []);
  assert.deepStrictEqual(undefinedTags('// import Foo\nconst a = <Foo.Bar />;'), ['Foo']);
});

test('web/src 의 모든 .jsx: JSX 컴포넌트 이름이 정의돼 있다', () => {
  const bad = [];
  for (const f of walk(ROOT)) {
    const miss = undefinedTags(fs.readFileSync(f, 'utf8'));
    if (miss.length) bad.push(`${path.relative(ROOT, f)}: ${miss.join(', ')}`);
  }
  assert.deepStrictEqual(bad, []);
});
