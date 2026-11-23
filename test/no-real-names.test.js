// 실명 거름 시험 — 추적 파일에 선생님·직원 실명이 없는지, 실명 자료가 들어올 모양이 아닌지 본다.
// 이름 목록은 레포에 두지 않는다: WEE_NAME_HASHES(기본 ~/.config/wee-hygiene/names.sha256) 파일에 sha256 hex 한 줄씩.
// 목록이 없으면 ① 은 건너뛴다(건너뜀 ≠ 통과). 실패 메시지에는 파일:줄만 찍고 이름은 찍지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HASH_FILE = process.env.WEE_NAME_HASHES || path.join(os.homedir(), '.config', 'wee-hygiene', 'names.sha256');
const sha = (s) => createHash('sha256').update(s.normalize('NFC')).digest('hex');
// 성 뺀 2자 이름은 흔한 낱말(같은지 등)과 겹치니, 낱말 맨 앞에서 조사·호칭만 붙은 꼴일 때만 친다.
const TAIL = /^(선생님|선생|쌤|샘|님|씨|이|가|은|는|을|를|의|도|에게|한테|과|와)?$/;

function loadHashes() {
  if (!existsSync(HASH_FILE)) return null;
  const set = new Set(readFileSync(HASH_FILE, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[0-9a-f]{64}$/.test(s)));
  return set.size ? set : null;
}

export function hitLines(text, H) {
  const lines = [];
  text.split('\n').forEach((ln, i) => {
    outer: for (const m of ln.normalize('NFC').matchAll(/[가-힣]+/g)) {
      const r = m[0];
      for (let a = 0; a < r.length; a++) {
        for (let l = 2; l <= 4 && a + l <= r.length; l++) {
          if (!H.has(sha(r.slice(a, a + l)))) continue;
          if (l >= 3 || (a === 0 && TAIL.test(r.slice(l)))) { lines.push(i + 1); break outer; }
        }
      }
    }
  });
  return lines;
}

const tracked = () => execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 1 << 26 }).toString('utf8').split('\0').filter(Boolean);
const isBinary = (buf) => buf.includes(0);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

function scanFiles(files, H, label) {
  const bad = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f.abs).split(path.sep).join('/');
    if (hitLines(f.rel, H).length) bad.push(`${rel} (파일 이름)`);
    const buf = readFileSync(f.abs);
    if (isBinary(buf)) continue;
    const ls = hitLines(buf.toString('utf8'), H);
    if (ls.length) bad.push(`${rel}:${ls.slice(0, 5).join(',')}`);
  }
  assert.deepEqual(bad, [], `${label}에 실명 해시가 맞는 곳이 있다(이름은 안 찍음):\n${bad.join('\n')}`);
}

test('① 추적 파일에 실명 없음(해시 대조)', (t) => {
  const H = loadHashes();
  if (!H) return t.skip('이름 목록 없음 — 건너뜀≠통과');
  scanFiles(tracked().map((rel) => ({ rel, abs: path.join(ROOT, rel) })), H, '추적 파일');
});

test('①-b 빌드 결과물(web/dist)에 실명 없음', (t) => {
  const H = loadHashes();
  if (!H) return t.skip('이름 목록 없음 — 건너뜀≠통과');
  const dist = path.join(ROOT, 'web', 'dist');
  if (!existsSync(dist)) return t.skip('web/dist 없음 — 건너뜀≠통과');
  scanFiles(walk(dist).map((abs) => ({ rel: path.relative(dist, abs), abs })), H, 'web/dist');
});

const FIXTURE_DIRS = ['test/fixtures/', 'tools/migrate/test/fixtures/'];

export function shapeProblems(files, sizeOf) {
  const bad = [];
  for (const f of files) {
    const base = f.split('/').pop();
    if (/실명|정답지|deid/i.test(f)) bad.push(`${f} (이름에 실명·정답지·deid)`);
    if (/\.json\.gz$/i.test(base)) bad.push(`${f} (json.gz 덤프)`);
    // dbdump 시험·스크립트 소스(.js)는 덤프가 아니다 — 덤프 자료 꼴만 막는다
    if (/^dbdump/i.test(base) && !/\.m?js$/.test(base)) bad.push(`${f} (dbdump 덤프)`);
    if (/\.json$/i.test(base) && !FIXTURE_DIRS.some((d) => f.startsWith(d)) && sizeOf(f) > 200 * 1024) bad.push(`${f} (시험 자료 폴더 밖 200KB 넘는 json)`);
  }
  return bad;
}

test('② 모양 검사 — 실명 자료가 들어올 모양이 아님', () => {
  const files = tracked();
  const bad = shapeProblems(files, (f) => statSync(path.join(ROOT, f)).size);
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('② 모양 검사 자체 점검 — 나쁜 모양을 실제로 잡는다', () => {
  const size = (f) => (f === 'data/big.json' ? 300 * 1024 : 10);
  assert.equal(shapeProblems(['a/실명목록.csv'], size).length, 1);
  assert.equal(shapeProblems(['x/정답지.txt'], size).length, 1);
  assert.equal(shapeProblems(['x/deid-map.json'], size).length, 1);
  assert.equal(shapeProblems(['backup.json.gz'], size).length, 1);
  assert.equal(shapeProblems(['dbdump-1.sql'], size).length, 1);
  assert.equal(shapeProblems(['data/big.json'], size).length, 1);
  assert.equal(shapeProblems(['test/fixtures/big.json'], () => 300 * 1024).length, 0);
  assert.equal(shapeProblems(['test/dbdump.test.js'], size).length, 0);
});
