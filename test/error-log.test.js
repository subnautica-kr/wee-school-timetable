// 오류 기록·첨부(T-1324b) — 가림 · 첨부 크기·꼴 거름 · 90일 정리 · 남의 글에 첨부 못 함
import test from 'node:test';
import assert from 'node:assert/strict';
import { HAS_DB, setup } from './sec-helpers.js';
import { scrubText } from '../server/routes/board.js';
import { runCleanups } from '../server/cleanup.js';

const skip = !HAS_DB && 'DB 없음';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x'.repeat(100))]);
const bin = { 'content-type': 'application/octet-stream' };

test('가림: 이메일·전화·이름·아이디·쿼리값이 글자에서 사라진다(DB 없이)', () => {
  const out = scrubText('홍길동 선생님 kim@school.kr 010-1234-5678 GET /api/x?name=김가명&id=7 {"name":"박철수"} 로그인 abc-login', ['abc-login']);
  for (const bad of ['홍길동', 'kim@school.kr', '1234-5678', '김가명', '박철수', 'abc-login']) assert.ok(!out.includes(bad), `${bad} 남음: ${out}`);
  assert.ok(out.includes('/api/x'));
});

test('오류 기록: 서버에 가려서 남고 기록 번호가 온다 · 로그인 전에도 받는다', { skip }, async (t) => {
  const f = await setup(t);
  const c = await f.as('staffA');
  const u = f.users.staffA;
  const r = await c.call('POST', '/api/board/errors', {
    message: `Cannot read ${u.loginId} 연락처 010-9999-8888`, stack: `at ${u.loginId} (a.js:1)`, screen: '/#tab?name=비밀', version: '1.0', recent: ['GET /api/orgs/1/roster?q=홍길동', '> /#me'],
  });
  assert.equal(r.status, 201, r.text);
  const row = (await f.pool.query(`SELECT * FROM error_report WHERE id = $1`, [r.json.id])).rows[0];
  const all = JSON.stringify(row);
  for (const bad of [u.loginId, '010-9999-8888', '홍길동', '비밀']) assert.ok(!all.includes(bad), `${bad} 가 기록에 남음: ${all}`);
  assert.equal(String(row.user_id), String(u.uid));
  assert.deepEqual(row.recent, ['GET /api/orgs/1/roster', '> /#me']);
  await f.pool.query(`DELETE FROM error_report WHERE id = $1`, [row.id]);
  // 로그인 전
  const anon = f.client();
  await anon.call('GET', '/api/auth/session');
  const a = await anon.call('POST', '/api/board/errors', { message: '로그인 화면 오류' });
  assert.equal(a.status, 201);
  assert.equal((await f.pool.query(`SELECT user_id FROM error_report WHERE id = $1`, [a.json.id])).rows[0].user_id, null);
  await f.pool.query(`DELETE FROM error_report WHERE id = $1`, [a.json.id]);
  assert.equal((await anon.call('POST', '/api/board/errors', { message: '' })).status, 400);
});

test('오류 기록: 같은 IP 에서 1분 20건이 넘으면 429', { skip }, async (t) => {
  const f = await setup(t);
  const c = f.client();
  await c.call('GET', '/api/auth/session');
  const ids = [];
  let last;
  for (let i = 0; i < 21; i += 1) { last = await c.call('POST', '/api/board/errors', { message: `flood ${i}` }); if (last.json?.id) ids.push(last.json.id); }
  assert.equal(last.status, 429);
  await f.pool.query(`DELETE FROM error_report WHERE id = ANY($1::bigint[])`, [ids]);
});

test('서버 500: 오류 기록에 남고 응답에 기록 번호가 실린다', { skip }, async (t) => {
  const f = await setup(t);
  f.app.get('/api/__boom', () => { throw new Error('터짐 sec-boom'); });
  // 라우터 뒤에 붙은 404 때문에 안 닿으므로 앞에 끼워 넣는다
  const stack = f.app._router.stack;
  const layer = stack.pop();
  const at = stack.findIndex((l) => l.name === 'router' && l.regexp?.test?.('/api/board'));
  stack.splice(at < 0 ? 0 : at, 0, layer);
  const c = await f.as('staffA');
  const r = await c.call('GET', '/api/__boom');
  assert.equal(r.status, 500);
  assert.ok(r.json.reportId, r.text);
  const row = (await f.pool.query(`SELECT message FROM error_report WHERE id = $1`, [r.json.reportId])).rows[0];
  assert.ok(row.message.includes('sec-boom'));
  await f.pool.query(`DELETE FROM error_report WHERE id = $1`, [r.json.reportId]);
});

async function postOf(c) {
  const r = await c.call('POST', '/api/board/posts', { kind: 'bug', visibility: 'public', title: '첨부 시험', body: '본문' });
  assert.equal(r.status, 201, r.text);
  return r.json.id;
}
const upload = (c, id, name, body) => c.call('POST', `/api/board/posts/${id}/attachments?name=${encodeURIComponent(name)}`, body, bin);

test('첨부: 크기·꼴 거름 · 남의 글엔 못 붙임 · 내려받기 · 5개 상한', { skip }, async (t) => {
  const f = await setup(t);
  const me = await f.as('staffA');
  const other = await f.as('adminB');
  const pid = await postOf(me);

  const ok = await upload(me, pid, '화면.png', PNG);
  assert.equal(ok.status, 201, ok.text);
  // 내려받기: 압축 저장이 원본으로 돌아온다
  const dl = await me.call('GET', `/api/board/attachments/${ok.json.id}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  const stored = (await f.pool.query(`SELECT size, octet_length(bytes) AS n FROM board_attachment WHERE id = $1`, [ok.json.id])).rows[0];
  assert.equal(stored.size, PNG.length);
  assert.ok(stored.n < PNG.length, '압축되지 않음');
  // 공개 글이라 남도 읽지만 붙이지는 못한다
  assert.equal((await other.call('GET', `/api/board/attachments/${ok.json.id}`)).status, 200);
  assert.equal((await upload(other, pid, 'x.png', PNG)).status, 403);
  // 꼴: 허용 밖 확장자 · 이름과 내용이 안 맞음
  assert.equal((await upload(me, pid, 'run.exe', Buffer.from('MZ'))).status, 415);
  assert.equal((await upload(me, pid, '가짜.png', Buffer.from('not a png'))).status, 415);
  assert.equal((await upload(me, pid, '문서.pdf', PNG)).status, 415);
  assert.equal((await upload(me, pid, '메모.txt', Buffer.from('안녕\n'))).status, 201);
  // 크기: 10MB 넘음 — 지금 크기가 말에 실린다
  const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
  const tooBig = await upload(me, pid, '큰.png', big);
  assert.equal(tooBig.status, 413);
  assert.match(tooBig.json.error, /10MB/);
  assert.match(tooBig.json.error, /10\.0MB/);
  // 상한 5개
  for (let i = 0; i < 3; i += 1) assert.equal((await upload(me, pid, `m${i}.txt`, Buffer.from('a'))).status, 201);
  assert.equal((await upload(me, pid, 'm9.txt', Buffer.from('a'))).status, 409);
  // 글 보기에 첨부 목록
  const d = await me.call('GET', `/api/board/posts/${pid}`);
  assert.equal(d.json.attachments.length, 5);
  // 안 보이는 글(총괄관리자만)의 첨부는 남이 못 받는다
  const sec = await me.call('POST', '/api/board/posts', { kind: 'bug', visibility: 'sysadmin', title: '비공개', body: 'x' });
  const sa = await upload(me, sec.json.id, 'a.png', PNG);
  assert.equal((await other.call('GET', `/api/board/attachments/${sa.json.id}`)).status, 404);
});

test('첨부: 90일이 지나면 파일 바이트만 비우고 글엔 지났다고 나온다', { skip }, async (t) => {
  const f = await setup(t);
  const me = await f.as('staffA');
  const pid = await postOf(me);
  const a = await upload(me, pid, 'a.png', PNG);
  const b = await upload(me, pid, 'b.png', PNG);
  await f.pool.query(`UPDATE board_attachment SET purge_after = now() - interval '1 day' WHERE id = $1`, [a.json.id]);
  const out = await runCleanups(f.pool, { log: { error() {} } });
  assert.equal(out.find((x) => x.name === 'board-attachment-90d')?.ok, true);
  const rows = (await f.pool.query(`SELECT id, bytes IS NULL AS purged FROM board_attachment WHERE post_id = $1 ORDER BY id`, [pid])).rows;
  assert.deepEqual(rows.map((r) => r.purged), [true, false]);
  assert.equal((await me.call('GET', `/api/board/attachments/${a.json.id}`)).status, 410);
  assert.equal((await me.call('GET', `/api/board/attachments/${b.json.id}`)).status, 200);
  const d = await me.call('GET', `/api/board/posts/${pid}`);
  assert.equal(d.json.attachments[0].purged, true);
});

test('글쓰기에 오류 기록 번호를 실으면 기록에 글 번호가 이어진다(내 기록만)', { skip }, async (t) => {
  const f = await setup(t);
  const me = await f.as('staffA');
  const rep = await me.call('POST', '/api/board/errors', { message: 'e' });
  const p = await me.call('POST', '/api/board/posts', { kind: 'bug', visibility: 'public', title: '오류 글', body: 'x', errorReportId: rep.json.id });
  assert.equal(p.status, 201, p.text);
  const row = (await f.pool.query(`SELECT board_post_id FROM error_report WHERE id = $1`, [rep.json.id])).rows[0];
  assert.equal(String(row.board_post_id), String(p.json.id));
  await f.pool.query(`UPDATE error_report SET board_post_id = NULL WHERE id = $1`, [rep.json.id]);
  await f.pool.query(`DELETE FROM error_report WHERE id = $1`, [rep.json.id]);
});

test('오류 기록: 91일 된 줄은 지워지고 89일 된 줄은 남는다', { skip }, async (t) => {
  const f = await setup(t);
  const ins = async (days) => (await f.pool.query(
    `INSERT INTO error_report (message, created_at) VALUES ($1, now() - make_interval(days => $2)) RETURNING id`, [`${f.tag}-정리`, days],
  )).rows[0].id;
  const old = await ins(91);
  const fresh = await ins(89);
  const out = await runCleanups(f.pool, { log: { error() {} } });
  assert.equal(out.find((x) => x.name === 'error-report-90d')?.ok, true);
  const left = (await f.pool.query(`SELECT id FROM error_report WHERE id = ANY($1::bigint[])`, [[old, fresh]])).rows.map((r) => String(r.id));
  assert.deepEqual(left, [String(fresh)]);
  await f.pool.query(`DELETE FROM error_report WHERE id = $1`, [fresh]);
});
