// 옛 자료 이전 도구(tools/migrate) — 시험 안 임시 서버에 명령줄 입구 run() 을 그대로 돌린다.
import test from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { HAS_DB, PW, setup } from './sec-helpers.js';
import { run } from '../tools/migrate/index.js';
import { makeClient } from '../tools/migrate/client.js';

const FIXTURE = new URL('../tools/migrate/test/fixtures/sample-school.fixture.json', import.meta.url);
const fixturePath = decodeURIComponent(FIXTURE.pathname).replace(/^\/([A-Za-z]:)/, '$1');
// 명단에 미리 올려 둘 사람(「마루」만 뺀다 — 못 맞춘 교사)
const SEEDED = ['이든', '노을', '한별', '빛나', '샛별', '하늘', '바다', '아라', '여울'];
const COUNTED = ['term', 'classroom', 'subject', 'special_room', 'teaching_load', 'timetable', 'cell', 'pin', 'membership'];

test('옛 자료 이전 도구', { skip: !HAS_DB }, async (t) => {
  const f = await setup(t);
  const { pool, tag } = f;
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0];
  const hash = await argon2.hash(PW);
  // 빈 기관 둘: M(옛 파일 넣기) · R(백업 되넣기). 이름이 tag- 로 시작해 cleanupOrgs 가 지운다
  const mkOrg = async (name) => (await one(`INSERT INTO org (name, kind) VALUES ($1, '초') RETURNING id`, [`${tag}-${name}`])).id;
  const mkAdmin = async (orgId, key) => {
    const u = (await one(`INSERT INTO app_user (name, login_id, password_hash, must_change_password) VALUES ($1, $2, $3, FALSE) RETURNING id`, [key, `${tag}-${key}`, hash])).id;
    await pool.query(`INSERT INTO membership (org_id, user_id, role) VALUES ($1, $2, '기관관리자')`, [orgId, u]);
    return `${tag}-${key}`;
  };
  const orgM = await mkOrg('M');
  const orgR = await mkOrg('R');
  const adminM = await mkAdmin(orgM, 'madmin');
  const adminR = await mkAdmin(orgR, 'radmin');
  const envM = { MIGRATE_LOGIN: adminM, MIGRATE_PASSWORD: PW };
  const noPrompt = () => { throw new Error('묻지 말아야 한다'); };
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const counts = async (orgId) => {
    const o = {};
    for (const tb of COUNTED) o[tb] = Number((await one(`SELECT count(*) AS n FROM ${tb} WHERE org_id = $1`, [orgId])).n);
    return o;
  };
  const live = async (sql, orgId) => Number((await one(sql, [orgId])).n);
  const midOf = async (orgId, name) => (await one(`SELECT m.id FROM membership m JOIN app_user u ON u.id = m.user_id WHERE m.org_id = $1 AND u.name = $2`, [orgId, name]))?.id;

  // 명단 올리기 길로 사람을 미리 올린다(앱 화면에서 명단부터 올린 학교)
  const cM = makeClient(f.base, { orgId: orgM });
  await cM.login(adminM, PW);
  const rows = SEEDED.map((name) => ({ name, loginId: `${tag}-${name}` }));
  let r = await cM.call('POST', cM.org('/roster/import'), { rows });
  if (r.status === 409) r = await cM.call('POST', cM.org('/roster/import'), { rows, confirm: true });
  assert.equal(r.status, 200);
  assert.ok(r.json.results.every((x) => x.ok));

  let out = [];
  const print = (s) => out.push(String(s));
  const base = ['--url', f.base, '--org', String(orgM)];

  await t.test('① preview 는 아무것도 안 넣는다 · 못 옮길 것을 미리 보여 준다', async () => {
    const before = await counts(orgM);
    out = [];
    const res = await run(['preview', fixturePath, ...base], { env: envM, prompt: noPrompt, print });
    assert.equal(res.code, 0);
    assert.deepEqual(await counts(orgM), before);
    const row = (name) => res.rows.find((x) => x[0] === name);
    assert.deepEqual(row('반').slice(1), [4, 0, 4, 0]);
    assert.deepEqual(row('교사(명단)').slice(1), [10, 9, 0, 1]);
    assert.deepEqual(row('과목').slice(1), [5, 4, 0, 1], '기본 교과 전제로 맞춘다(로봇코딩만 못 맞춤)');
    assert.deepEqual(row('시수표 줄').slice(1), [12, 0, 8, 4]);
    // --create-missing 이면 못 맞춘 것을 「새로 넣음」으로
    const cm = await run(['preview', fixturePath, ...base, '--create-missing'], { env: envM, prompt: noPrompt, print: () => {} });
    assert.deepEqual(cm.rows.find((x) => x[0] === '교사(명단)').slice(1), [10, 9, 1, 0]);
    assert.deepEqual(cm.rows.find((x) => x[0] === '과목').slice(1), [5, 4, 1, 0]);
    assert.deepEqual(await counts(orgM), before);
    assert.ok(!out.join('\n').includes(PW), '비밀번호가 화면에 나왔다');
  });

  let applied;
  const resultFile = path.join(tmp, 'result-m.json');
  await t.test('② apply 뒤 반·교사·과목·시수표 개수가 맞고 시간표는 시안으로만', async () => {
    out = [];
    applied = await run(['apply', fixturePath, ...base, '--out', resultFile], { env: envM, prompt: noPrompt, print });
    assert.equal(applied.code, 0);
    assert.equal(await live(`SELECT count(*) AS n FROM classroom WHERE org_id = $1 AND deleted_at IS NULL`, orgM), 4);
    const cls = (await pool.query(`SELECT grade, class_no, homeroom_membership_id FROM classroom WHERE org_id = $1 AND deleted_at IS NULL ORDER BY grade, class_no`, [orgM])).rows;
    assert.deepEqual(cls.map((c) => `${c.grade}-${c.class_no}`), ['2-1', '2-2', '3-1', '3-2']);
    assert.equal(String(cls.find((c) => c.grade === 3 && c.class_no === 1).homeroom_membership_id), String(await midOf(orgM, '아라')));
    assert.equal(await live(`SELECT count(*) AS n FROM membership WHERE org_id = $1 AND deleted_at IS NULL`, orgM), 10, '관리자 + 미리 올린 9명 — 더 만들지 않음');
    const subj = (await pool.query(`SELECT name FROM subject WHERE org_id = $1 AND deleted_at IS NULL`, [orgM])).rows.map((x) => x.name);
    assert.equal(subj.length, 14);
    assert.ok(!subj.includes('로봇코딩'));
    assert.equal(await live(`SELECT count(*) AS n FROM teaching_load WHERE org_id = $1 AND deleted_at IS NULL`, orgM), 8);
    assert.equal(applied.done.loads, 8);
    const tts = (await pool.query(`SELECT id, status FROM timetable WHERE org_id = $1 AND deleted_at IS NULL`, [orgM])).rows;
    assert.equal(tts.length, 1);
    assert.equal(tts[0].status, '시안');
    assert.equal(await live(`SELECT count(*) AS n FROM cell WHERE org_id = $1 AND deleted_at IS NULL`, orgM), 7);
    // 임시 비밀번호·로그인 비밀번호는 화면에 없다 · 결과 파일에 비밀번호 없음
    const shown = out.join('\n');
    assert.ok(!shown.includes(PW));
    const saved = JSON.parse(readFileSync(resultFile, 'utf8'));
    assert.ok(!JSON.stringify(saved).includes(PW));
    assert.equal(saved.accounts.length, 0);
  });

  await t.test('③ 못 맞춘 교사·과목은 「못 옮긴 것」에', () => {
    const has = (what, id) => applied.lost.some((x) => x.what === what && x.id === id);
    assert.ok(has('교사', '마루'));
    assert.ok(has('과목', '로봇코딩'));
    assert.ok(applied.lost.some((x) => x.what === '시수표 줄' && x.reason.includes('로봇코딩')));
    assert.ok(applied.lost.some((x) => x.what === '시수표 줄' && x.reason.includes('마루')));
    assert.ok(applied.lost.some((x) => x.what === '주간 금지칸'));
    const saved = JSON.parse(readFileSync(resultFile, 'utf8'));
    assert.equal(saved.lost.length, applied.lost.length);
  });

  await t.test('④ 둘째 교사 · 요일별 교시가 옮겨진다', async () => {
    const noeul = String(await midOf(orgM, '노을'));
    const eden = String(await midOf(orgM, '이든'));
    const loads = (await pool.query(
      `SELECT l.membership_id, l.second_membership_id FROM teaching_load l JOIN subject s ON s.id = l.subject_id JOIN classroom c ON c.id = l.classroom_id
        WHERE l.org_id = $1 AND l.deleted_at IS NULL AND s.name = '영어' AND c.grade = 3`, [orgM])).rows;
    assert.equal(loads.length, 2);
    for (const l of loads) { assert.equal(String(l.membership_id), eden); assert.equal(String(l.second_membership_id), noeul); }
    const cell = await one(
      `SELECT x.membership_id, x.second_membership_id FROM cell x JOIN classroom c ON c.id = x.classroom_id
        WHERE x.org_id = $1 AND x.deleted_at IS NULL AND c.grade = 3 AND c.class_no = 1 AND x.weekday = 1 AND x.period = 1`, [orgM]);
    assert.equal(String(cell.second_membership_id), noeul);
    const pc = (await one(`SELECT period_config FROM org WHERE id = $1`, [orgM])).period_config;
    assert.deepEqual(pc.grades['2'].byDay, { 1: 4, 5: 4 });
    assert.equal(pc.grades['2'].periods, 5);
    assert.equal(pc.grades['3'].periods, 6);
    assert.equal(pc.grades['3'].byDay, undefined);
    assert.equal(pc.grades['3'].lunchAfter, 4);
  });

  await t.test('⑤ 백업 파일 → 빈 기관 되넣기: 시수표·시안 칸 개수가 원본과 같다', async () => {
    const backup = await cM.ok('GET', cM.org('/backup'));
    const bfile = path.join(tmp, 'backup-m.json');
    writeFileSync(bfile, JSON.stringify(backup));
    const res = await run(['apply', bfile, '--url', f.base, '--org', String(orgR), '--login-prefix', `${tag}-r-`, '--out', path.join(tmp, 'result-r.json')],
      { env: { MIGRATE_LOGIN: adminR, MIGRATE_PASSWORD: PW }, prompt: noPrompt, print: () => {} });
    assert.equal(res.code, 0);
    assert.equal(res.accountCount, 10);
    const q = (tb) => `SELECT count(*) AS n FROM ${tb} WHERE org_id = $1 AND deleted_at IS NULL`;
    for (const tb of ['teaching_load', 'cell', 'timetable', 'classroom']) assert.equal(await live(q(tb), orgR), await live(q(tb), orgM), tb);
    const saved = JSON.parse(readFileSync(path.join(tmp, 'result-r.json'), 'utf8'));
    assert.equal(saved.accounts.length, 10);
    assert.ok(saved.accounts.every((a) => a.loginId.startsWith(`${tag}-r-`) && a.tempPassword));
  });
});
