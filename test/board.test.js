// 도움·요청 서버(T-1324a①) — 공개 범위 넷 × 보는 사람 넷 표 · 글쓴이 이름 안 나감 · 처리 상태·올리기·묶기·태그·답글·비슷한 글
import test from 'node:test';
import assert from 'node:assert/strict';
import { HAS_DB, setup } from './sec-helpers.js';

const skip = !HAS_DB && 'DB 없음';
const VIS = ['org_admins', 'sysadmin', 'org_and_sysadmin', 'public'];

// 학교 A 선생님(staffA)이 쓴 글을 보는 사람 넷 — 글쓴이 · 같은 학교 기관 관리자 · 다른 학교 기관 관리자 · 총괄관리자
const TABLE = {
  org_admins: { author: true, adminA: true, adminB: false, sys: false },
  sysadmin: { author: true, adminA: false, adminB: false, sys: true },
  org_and_sysadmin: { author: true, adminA: true, adminB: false, sys: true },
  public: { author: true, adminA: true, adminB: true, sys: true },
};

async function world(t) {
  const f = await setup(t);
  const who = { author: await f.as('staffA'), adminA: await f.as('adminA'), adminB: await f.as('adminB'), sys: await f.as('sys'), viewA: await f.as('viewA') };
  const write = async (c, visibility, title, extra = {}) => {
    const r = await c.call('POST', '/api/board/posts', { kind: 'bug', visibility, title, body: '본문', ...extra });
    assert.equal(r.status, 201, r.text);
    return r.json.id;
  };
  return { f, who, write };
}

test('공개 범위 넷 × 보는 사람 넷: 한 칸도 틀리지 않는다(상세 · 목록 · 비슷한 글)', { skip }, async (t) => {
  const { who, write } = await world(t);
  const ids = {};
  for (const v of VIS) ids[v] = await write(who.author, v, `표시험 ${v} 낱말공통 글`);
  const bad = [];
  for (const [vis, row] of Object.entries(TABLE)) {
    for (const [name, want] of Object.entries(row)) {
      const c = who[name];
      const one = await c.call('GET', `/api/board/posts/${ids[vis]}`);
      if ((one.status === 200) !== want) bad.push(`상세 ${vis} × ${name}: ${one.status}`);
      const list = await c.call('GET', '/api/board/posts');
      assert.equal(list.status, 200);
      if (list.json.items.some((x) => x.id === ids[vis]) !== want) bad.push(`목록 ${vis} × ${name}`);
      const sim = await c.call('GET', `/api/board/similar?title=${encodeURIComponent('표시험 낱말공통')}`);
      if (sim.json.items.some((x) => x.id === ids[vis]) !== want) bad.push(`비슷한 글 ${vis} × ${name}`);
    }
  }
  assert.deepEqual(bad, []);
  // 같은 학교 일반 선생님(글쓴이 아님)은 전체 공개만 본다
  for (const v of VIS) assert.equal((await who.viewA.call('GET', `/api/board/posts/${ids[v]}`)).status, v === 'public' ? 200 : 404, `viewA × ${v}`);
  // 「내가 쓴 글」 거르기 — 글쓴이만 넷 다, 남은 mine 이 없다
  const mine = await who.author.call('GET', '/api/board/posts?mine=1');
  assert.equal(mine.json.items.filter((x) => Object.values(ids).includes(x.id)).length, 4);
  assert.equal((await who.adminA.call('GET', '/api/board/posts?mine=1')).json.items.length, 0);
});

test('글쓴이 이름·번호는 어느 응답에도 없고 학교 이름만 있다', { skip }, async (t) => {
  const { f, who, write } = await world(t);
  const pid = await write(who.author, 'public', '이름 시험 글');
  await who.adminA.call('POST', `/api/board/posts/${pid}/comments`, { body: '답글입니다' });
  const me = f.users.staffA;
  for (const name of ['adminA', 'adminB', 'sys', 'author']) {
    const out = [
      await who[name].call('GET', '/api/board/posts'),
      await who[name].call('GET', `/api/board/posts/${pid}`),
      await who[name].call('GET', `/api/board/similar?title=${encodeURIComponent('이름 시험 글')}`),
    ];
    for (const r of out) {
      assert.equal(r.status, 200);
      assert.ok(!r.text.includes(me.loginId), `${name}: 로그인 아이디가 실림`);
      assert.ok(!r.text.includes('staffA'), `${name}: 이름이 실림`);
      assert.ok(!/author|user_id|userId/i.test(r.text), `${name}: 글쓴이 칸이 실림`);
      assert.ok(!r.text.includes(`"uid":${me.uid}`));
    }
  }
  const one = (await who.adminB.call('GET', `/api/board/posts/${pid}`)).json;
  assert.equal(one.post.school, `${f.tag}-A`);
  assert.equal(one.post.mine, false);
  assert.equal((await who.author.call('GET', `/api/board/posts/${pid}`)).json.post.mine, true);
  assert.equal(one.comments[0].mine, false);
  assert.equal(one.comments[0].bySysadmin, false);
});

test('글쓰기: 공개 범위를 안 고르면 거절 · 총괄관리자는 못 쓴다 · 겸임은 들어가 있던 학교 글', { skip }, async (t) => {
  const { f, who, write } = await world(t);
  const no = await who.author.call('POST', '/api/board/posts', { kind: 'bug', title: '범위 없음' });
  assert.equal(no.status, 400);
  assert.equal(no.json.code, 'board.err.bad_input');
  assert.equal((await who.author.call('POST', '/api/board/posts', { kind: 'zzz', visibility: 'public', title: 'x' })).status, 400);
  assert.equal((await who.sys.call('POST', '/api/board/posts', { kind: 'bug', visibility: 'public', title: '총괄' })).status, 403);
  assert.equal((await f.client().call('GET', '/api/board/posts')).status, 401);
  // 겸임: B 학교로 들어가 쓴 글은 B 글 — B 관리자는 보고 A 관리자는 못 본다 · 쓴 본인은 A 세션에서도 본다
  const dualB = await f.as('dual', f.orgB);
  const pid = await write(dualB, 'org_admins', '겸임 글');
  assert.equal((await who.adminB.call('GET', `/api/board/posts/${pid}`)).status, 200);
  assert.equal((await who.adminA.call('GET', `/api/board/posts/${pid}`)).status, 404);
  const dualA = await f.as('dual', f.orgA);
  assert.equal((await dualA.call('GET', `/api/board/posts/${pid}`)).status, 200);
});

test('처리 상태: 총괄관리자 · 「기관 관리자만」 글은 그 학교 기관 관리자 · 그 밖은 거절', { skip }, async (t) => {
  const { who, write } = await world(t);
  const onlyAdmin = await write(who.author, 'org_admins', '기관 관리자만 글');
  const both = await write(who.author, 'org_and_sysadmin', '둘 다 글');
  const put = (c, id, stage) => c.call('PATCH', `/api/board/posts/${id}/stage`, { stage });
  assert.equal((await put(who.adminA, onlyAdmin, 'reviewing')).status, 200);
  assert.equal((await put(who.sys, onlyAdmin, 'working')).status, 404); // 총괄관리자에겐 안 보인다
  assert.equal((await put(who.adminA, both, 'working')).status, 403); // 총괄관리자 글은 기관 관리자가 못 바꾼다
  assert.equal((await put(who.sys, both, 'working')).status, 200);
  assert.equal((await put(who.author, onlyAdmin, 'done')).status, 403); // 글쓴이도 못 바꾼다
  assert.equal((await put(who.adminB, both, 'done')).status, 404);
  assert.equal((await put(who.sys, both, 'nope')).status, 400);
  const d = (await who.adminA.call('GET', `/api/board/posts/${onlyAdmin}`)).json.post;
  assert.equal(d.stage, 'reviewing');
  assert.equal(d.canStage, true);
  assert.equal((await who.adminA.call('GET', `/api/board/posts/${both}`)).json.post.canStage, false);
});

test('세로 순서: 검토·처리 중 → 접수·보류 → 완료', { skip }, async (t) => {
  const { who, write } = await world(t);
  const a = await write(who.author, 'public', '순서 완료');
  const b = await write(who.author, 'public', '순서 접수');
  const c = await write(who.author, 'public', '순서 처리중');
  const e = await write(who.author, 'public', '순서 보류');
  for (const [id, s] of [[a, 'done'], [c, 'working'], [e, 'hold']]) await who.sys.call('PATCH', `/api/board/posts/${id}/stage`, { stage: s });
  const items = (await who.sys.call('GET', '/api/board/posts')).json.items.filter((x) => [a, b, c, e].includes(x.id)).map((x) => x.id);
  assert.deepEqual(items, [c, e, b, a]);
});

test('총괄관리자에게 올리기: 「기관 관리자만」 글만 · 한 번만 · 글쓴이에게 소식 · 거꾸로 길 없음', { skip }, async (t) => {
  const { f, who, write } = await world(t);
  const pid = await write(who.author, 'org_admins', '올릴 글');
  const raise = (c, id) => c.call('POST', `/api/board/posts/${id}/raise`);
  assert.equal((await who.sys.call('GET', `/api/board/posts/${pid}`)).status, 404);
  assert.equal((await raise(who.author, pid)).status, 403); // 글쓴이(일반 선생님)는 못 올린다
  assert.equal((await raise(who.adminB, pid)).status, 404);
  const ok = await raise(who.adminA, pid);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.visibility, 'org_and_sysadmin');
  assert.equal((await who.sys.call('GET', `/api/board/posts/${pid}`)).status, 200);
  assert.equal((await raise(who.adminA, pid)).status, 409);
  assert.equal((await raise(who.adminA, pid)).json.code, 'board.err.raise_only_admins');
  const n = await f.pool.query(`SELECT audience, text FROM notification WHERE kind = 'board.raised' AND link = $1 ORDER BY id`, [`board:${pid}`]);
  assert.deepEqual(n.rows.map((x) => x.audience).sort(), ['sysadmin', 'user']);
  assert.ok(n.rows.find((x) => x.audience === 'user').text.includes('올릴 글'));
  // 공개 범위를 바꾸는 다른 길은 없다
  assert.equal((await who.adminA.call('PATCH', `/api/board/posts/${pid}`, { visibility: 'org_admins' })).status, 404);
});

test('답글: 총괄관리자 · 우리 학교 기관 관리자(볼 수 있는 글만) · 글쓴이에게 소식', { skip }, async (t) => {
  const { f, who, write } = await world(t);
  const pub = await write(who.author, 'public', '답글 공개');
  const sysOnly = await write(who.author, 'sysadmin', '답글 총괄만');
  const reply = (c, id, body = '답') => c.call('POST', `/api/board/posts/${id}/comments`, { body });
  assert.equal((await reply(who.adminA, pub)).status, 201);
  assert.equal((await reply(who.sys, pub)).status, 201);
  assert.equal((await reply(who.adminB, pub)).status, 403); // 보이지만 남의 학교 글
  assert.equal((await reply(who.viewA, pub)).status, 403);
  assert.equal((await reply(who.author, pub)).status, 403);
  assert.equal((await reply(who.adminA, sysOnly)).status, 404);
  assert.equal((await reply(who.sys, sysOnly)).status, 201);
  assert.equal((await reply(who.sys, pub, '  ')).status, 400);
  const cs = (await who.author.call('GET', `/api/board/posts/${pub}`)).json.comments;
  assert.deepEqual(cs.map((c) => c.bySysadmin), [false, true]);
  const n = await f.pool.query(`SELECT 1 FROM notification WHERE kind = 'board.reply' AND link = $1 AND user_id = $2`, [`board:${pub}`, f.users.staffA.uid]);
  assert.equal(n.rowCount, 2);
});

test('글 종류·태그·묶기: 총괄관리자와 기관 관리자(자기 학교 글끼리만)', { skip }, async (t) => {
  const { who, write } = await world(t);
  const a1 = await write(who.author, 'public', '묶기 하나');
  const a2 = await write(who.author, 'org_and_sysadmin', '묶기 둘');
  const b1 = await write(who.adminB, 'public', '묶기 남의 학교');
  const grp = (c, id, groupId) => c.call('PUT', `/api/board/posts/${id}/group`, { groupId });
  assert.equal((await grp(who.adminA, a2, a1)).status, 200);
  assert.equal((await who.adminA.call('GET', `/api/board/posts/${a1}`)).json.grouped.map((x) => x.id)[0], a2);
  assert.equal((await who.adminA.call('GET', '/api/board/posts')).json.items.find((x) => x.id === a1).groupCount, 1);
  assert.equal((await grp(who.adminA, a1, a1)).status, 400);
  assert.equal((await grp(who.adminA, a1, a2)).status, 409); // 묶인 글이 머리가 될 수 없다
  assert.equal((await grp(who.sys, a1, a2)).status, 409);
  assert.equal((await grp(who.adminA, a1, b1)).status, 404); // 남의 학교 글에는 못 묶는다
  assert.equal((await grp(who.adminB, a1, b1)).status, 403); // 남의 학교 글은 못 고친다
  assert.equal((await grp(who.author, a1, b1)).status, 403);
  assert.equal((await grp(who.adminA, a2, null)).status, 200);
  assert.equal((await who.adminA.call('GET', `/api/board/posts/${a2}`)).json.post.groupId, null);
  // 태그
  const tags = (c, id, list) => c.call('PUT', `/api/board/posts/${id}/tags`, { tags: list });
  assert.deepEqual((await tags(who.adminA, a1, ['시간표', '시간표', '속도'])).json.tags, ['시간표', '속도']);
  assert.equal((await tags(who.adminB, a1, ['x'])).status, 403);
  assert.equal((await tags(who.sys, a1, ['총괄'])).status, 200);
  assert.equal((await tags(who.author, a1, ['x'])).status, 403);
  assert.equal((await who.sys.call('GET', '/api/board/posts?tag=' + encodeURIComponent('총괄'))).json.items.length, 1);
  // 글 종류
  assert.equal((await who.adminA.call('PATCH', `/api/board/posts/${a1}/kind`, { kind: 'question' })).status, 200);
  assert.equal((await who.adminB.call('PATCH', `/api/board/posts/${a1}/kind`, { kind: 'bug' })).status, 403);
  assert.equal((await who.adminA.call('PATCH', `/api/board/posts/${a1}/kind`, { kind: 'zzz' })).status, 400);
  assert.equal((await who.adminB.call('GET', `/api/board/posts/${a1}`)).json.post.kind, 'question');
});

test('새 글 소식: 공개 범위에 따라 총괄관리자 · 그 학교 기관 관리자에게만', { skip }, async (t) => {
  const { f, who, write } = await world(t);
  const kinds = {};
  for (const v of VIS) kinds[v] = await write(who.author, v, `소식 ${v}`);
  const aud = async (id) => (await f.pool.query(`SELECT audience, org_id FROM notification WHERE kind = 'board.new_post' AND link = $1 ORDER BY audience`, [`board:${id}`])).rows;
  assert.deepEqual((await aud(kinds.org_admins)).map((x) => x.audience), ['org_admins']);
  assert.deepEqual((await aud(kinds.sysadmin)).map((x) => x.audience), ['sysadmin']);
  assert.deepEqual((await aud(kinds.org_and_sysadmin)).map((x) => x.audience), ['org_admins', 'sysadmin']);
  assert.deepEqual((await aud(kinds.public)).map((x) => x.audience), ['org_admins', 'sysadmin']);
  assert.ok((await aud(kinds.org_admins)).every((x) => String(x.org_id) === String(f.orgA)));
});

test('비슷한 글: 제목 낱말이 둘 겹쳐야 · 묶인 글은 빠진다', { skip }, async (t) => {
  const { who, write } = await world(t);
  const p = await write(who.adminA, 'public', '로그인 화면 느려요');
  const q = await write(who.adminA, 'public', '로그인 화면 오류');
  await who.adminA.call('PUT', `/api/board/posts/${q}/group`, { groupId: p });
  const x = await write(who.adminA, 'public', '엑셀 내려받기 오류');
  const sim = async (title) => (await who.adminB.call('GET', `/api/board/similar?title=${encodeURIComponent(title)}`)).json.items.map((x) => x.id);
  assert.deepEqual(await sim('로그인 화면이 안 열려요 로그인 화면'), [p]);
  assert.deepEqual(await sim('엑셀'), [x]); // 낱말 하나짜리 제목은 한 낱말만 겹쳐도 된다
  assert.deepEqual(await sim('오류 보고'), []); // 낱말이 둘이면 둘 다 겹쳐야 한다(오류 하나만으론 안 됨)
  assert.equal((await who.adminB.call('GET', '/api/board/similar')).status, 400);
});
