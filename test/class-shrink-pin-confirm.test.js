// 반 줄이기가 지우기 창을 거쳐 DELETE /classrooms/ 를 부르고, 고정·금지 지우기는 확인 뒤에만 DELETE 한다(정적 읽기)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../web/src/school/SchoolPage.jsx', import.meta.url), 'utf8');

test('반 줄이기: 맨 뒤 반을 classrooms 지우기 경로로 지운다', () => {
  assert.match(src, /const shrink = \(\) =>/);
  assert.match(src, /cascadeOpts\(P, 'classroom', last\.id[^\n]*\/classrooms\/\$\{last\.id\}/);
  assert.match(src, /onClick=\{shrink\}/);
});
test('고정·금지 지우기: DELETE 앞에 확인 창(ask)이 있다', () => {
  const i = src.indexOf("api('DELETE', `${P}/pins/");
  assert.ok(i > 0);
  const before = src.slice(Math.max(0, i - 400), i);
  assert.match(before, /await ask\(/);
  assert.match(before, /\)\)\) return;/);
});
