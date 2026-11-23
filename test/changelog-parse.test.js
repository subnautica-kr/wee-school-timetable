import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseChangelog, splitInline, hasNewVersion } from '../web/src/changelog.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const text = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');

test('실제 CHANGELOG: 버전 칸 수 · 첫 버전 = package.json · Unreleased 빠짐', () => {
  const v = parseChangelog(text);
  const heads = text.match(/^## \[(?!Unreleased)[^\]]+\]/gim) || [];
  assert.equal(v.length, heads.length);
  assert.ok(v.length >= 2);
  assert.equal(v[0].version, pkg.version);
  assert.ok(!v.some((x) => /unreleased/i.test(x.version)));
  assert.ok(v.every((x) => x.groups.length > 0 && x.groups.every((g) => g.items.length > 0)));
});

test('작은 예: Unreleased 아래 글은 버려진다', () => {
  const v = parseChangelog('# t\n\n머리\n\n## [Unreleased]\n### 추가\n- 숨김\n\n## [1.0.0] - 2026-01-01\n### 고침\n- **a** `b`\n');
  assert.deepEqual(v, [{ version: '1.0.0', date: '2026-01-01', groups: [{ title: '고침', items: ['**a** `b`'] }] }]);
});

test('splitInline: 굵게·코드만, HTML 안 만듦', () => {
  assert.deepEqual(splitInline('x **b** `c` <i>'), [{ t: 'text', s: 'x ' }, { t: 'b', s: 'b' }, { t: 'text', s: ' ' }, { t: 'code', s: 'c' }, { t: 'text', s: ' <i>' }]);
});

test('hasNewVersion: 같으면 false · 다르면 true · 없으면 true', () => {
  assert.equal(hasNewVersion('0.2.1', '0.2.1'), false);
  assert.equal(hasNewVersion('0.2.0', '0.2.1'), true);
  assert.equal(hasNewVersion(null, '0.2.1'), true);
});
