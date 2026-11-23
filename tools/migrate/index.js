#!/usr/bin/env node
// 옛 자료 이전 도구 — 명령줄 입구.
//   node tools/migrate/index.js preview <파일> --url <앱 주소> --org <기관 번호> [--create-missing] [--login-prefix <앞말>]
//   node tools/migrate/index.js apply   <파일> --url <앱 주소> --org <기관 번호> --out <결과.json> [--create-missing] [--login-prefix <앞말>]
// 아이디·비밀번호는 환경변수 MIGRATE_LOGIN · MIGRATE_PASSWORD (없으면 물어본다). 비밀번호는 화면·로그·결과 파일 어디에도 안 적는다.
// 새 계정의 임시 비밀번호는 --out 결과 파일에만 적고 화면엔 개수만 낸다.
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { makeClient } from './client.js';
import { detect, legacyToSource, backupToSource } from './sources.js';
import { preview, apply, renderTable } from './migrate.js';

const USAGE = `쓰는 법:
  node tools/migrate/index.js preview <파일> --url <앱 주소> --org <기관 번호> [--create-missing] [--login-prefix <앞말>]
  node tools/migrate/index.js apply   <파일> --url <앱 주소> --org <기관 번호> --out <결과.json> [--create-missing] [--login-prefix <앞말>]
  아이디·비밀번호: 환경변수 MIGRATE_LOGIN · MIGRATE_PASSWORD (없으면 물어본다)`;

export function parseArgs(argv) {
  const a = { cmd: argv[0], file: null, url: null, org: null, createMissing: false, loginPrefix: '', out: null };
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--create-missing') a.createMissing = true;
    else if (k === '--url') a.url = argv[++i];
    else if (k === '--org') a.org = argv[++i];
    else if (k === '--login-prefix') a.loginPrefix = argv[++i] ?? '';
    else if (k === '--out') a.out = argv[++i];
    else if (!k.startsWith('--') && !a.file) a.file = k;
    else throw new Error(`모르는 인자: ${k}`);
  }
  if (!['preview', 'apply'].includes(a.cmd)) throw new Error('첫 낱말은 preview 또는 apply');
  if (!a.file || !a.url || !a.org) throw new Error('파일 · --url · --org 는 꼭 있어야 한다');
  if (!/^\d+$/.test(String(a.org))) throw new Error('--org 는 기관 번호(숫자)');
  if (a.cmd === 'apply' && !a.out) throw new Error('apply 는 --out <결과.json> 이 있어야 한다(새 계정 임시 비밀번호를 거기에만 적는다)');
  return a;
}

export function loadSource(file) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const kind = detect(json);
  if (kind === 'backup') return backupToSource(json);
  if (kind === 'legacy') return legacyToSource(json);
  throw new Error('읽을 수 없는 파일 — 옛 앱 작업 파일(.shiftgrid.json)이나 새 앱 백업 파일이어야 한다');
}

// 대화형으로 묻기 — 비밀번호는 입력을 화면에 되비치지 않는다
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(question); };
    rl.question(question, (ans) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(ans); });
  });
}

const lostLines = (lost) => lost.map((x) => `- [${x.what}] ${x.id} — ${x.reason}`);

// 시험이 부르는 입구. 비밀번호는 env 나 prompt 로만 받는다.
export async function run(argv, { env = process.env, prompt = ask, print = (s) => console.log(s), wait } = {}) {
  let a;
  try { a = parseArgs(argv); } catch (e) { print(`${e.message}\n\n${USAGE}`); return { code: 2 }; }
  const src = loadSource(a.file);
  const loginId = env.MIGRATE_LOGIN || (await prompt('관리자 아이디: '));
  const password = env.MIGRATE_PASSWORD || (await prompt('비밀번호: ', { hidden: true }));
  const c = makeClient(a.url, { orgId: a.org, ...(wait ? { wait } : {}) });
  await c.login(loginId, password);
  const opts = { createMissing: a.createMissing, loginPrefix: a.loginPrefix };
  print(`원본: ${src.kind === 'backup' ? '새 앱 백업' : '옛 앱 파일'} 「${src.title}」 → 기관 ${a.org}`);

  if (a.cmd === 'preview') {
    const r = await preview(c, src, opts);
    print(renderTable(r.rows));
    print(r.lost.length ? `\n못 옮기는 것 ${r.lost.length}건:\n${lostLines(r.lost).join('\n')}` : '\n못 옮기는 것 없음');
    print('\n미리보기라 아무것도 넣지 않았다. 넣으려면 같은 명령을 apply 로(--out 결과.json 붙여서).');
    return { code: 0, rows: r.rows, lost: r.lost };
  }

  const r = await apply(c, src, { ...opts, log: print });
  writeFileSync(a.out, JSON.stringify({ at: new Date().toISOString(), org: Number(a.org), source: src.title, done: r.done, accounts: r.accounts, lost: r.lost }, null, 2), { encoding: 'utf8', mode: 0o600 });
  const d = r.done;
  print(`넣음: 교사 ${d.people} · 반 ${d.classes} · 과목 ${d.subjects} · 특별실 ${d.rooms} · 교시 학년 ${d.periods} · 담임/학생 수 ${d.homerooms} · 시수표 ${d.loads} · 시안 ${d.timetables}(칸 ${d.cells}) · 고정·금지 ${d.pins}`);
  if (r.accounts.length) print(`새 계정 ${r.accounts.length}개 — 임시 비밀번호는 결과 파일(${a.out})에만 있다. 나눠 준 뒤 그 파일은 지운다.`);
  print(r.lost.length ? `못 옮긴 것 ${r.lost.length}건:\n${lostLines(r.lost).join('\n')}` : '못 옮긴 것 없음');
  return { code: 0, done: r.done, accountCount: r.accounts.length, lost: r.lost };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run(process.argv.slice(2)).then((r) => { process.exitCode = r.code; }, (e) => { console.error(`멈춤: ${e.message}`); process.exitCode = 1; });
}
