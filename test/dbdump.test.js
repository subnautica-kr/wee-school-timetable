// DB 통째 백업·되넣기(scripts/dump-db.js · restore-db.js) — 예시 학교를 심고 → 덤프 → 빈 DB 에 되넣고 → 같은지 본다.
// 되넣을 DB 는 DBDUMP_RESTORE_URL, 없으면 DATABASE_URL 에서 DB 이름만 timetable_t1209r 로 바꾼다.
// ⛔ 되넣는 쪽은 시험이 표를 다 지우고 시작한다 — 시험용 빈 DB 가 아니면(이름이 _t1209r 로 안 끝나면) 건너뛴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import pg from 'pg';
import { HAS_DB } from './sec-helpers.js';
import { dumpDb, redactor } from '../scripts/dump-db.js';
import { restoreDb } from '../scripts/restore-db.js';

const SRC = process.env.DATABASE_URL;
const DST = process.env.DBDUMP_RESTORE_URL || (SRC ? SRC.replace(/\/[^/?]+(\?|$)/, '/timetable_t1209r$1') : '');
const SAFE_DST = /\/timetable_t1209r(\?|$)/.test(DST);
const PASSWORD = 'dev-sample-1234';

test('DB 통째 백업·되넣기', { skip: (!HAS_DB && 'DB 없음') || (!SAFE_DST && '되넣을 시험 DB(timetable_t1209r)가 아님') }, async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'dbdump-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const file = path.join(tmp, 'd.json.gz');

  // 예시 학교를 시험 DB 에 심는다(이미 있으면 그대로)
  execFileSync(process.execPath, ['scripts/seed-sample.js'], { env: { ...process.env, SAMPLE_PASSWORD: PASSWORD }, stdio: 'pipe' });

  const lines = [];
  const { counts } = await dumpDb(SRC, file, (s) => lines.push(s));

  // 되넣을 시험 DB 가 없으면 만든다(CI 처럼 새 DB 서버에서도 돌게 — 11-23 GitHub 시험이 이것 하나로 빨갰다)
  const admin = new pg.Client({ connectionString: SRC });
  await admin.connect();
  const dbName = new URL(DST).pathname.slice(1);
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!rowCount) await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  // 되넣을 DB 를 비운다(스키마째)
  const dst = new pg.Client({ connectionString: DST });
  await dst.connect();
  t.after(() => dst.end());
  const wipe = async () => { await dst.query('DROP SCHEMA public CASCADE'); await dst.query('CREATE SCHEMA public'); };
  await wipe();

  await t.test('① 덤프는 gzip JSON · 표 줄 수 표가 나온다 · 주소가 파일에 없다', () => {
    const raw = zlib.gunzipSync(readFileSync(file)).toString('utf8');
    const doc = JSON.parse(raw);
    assert.equal(doc.format, 'wee-timetable-dbdump');
    assert.ok(doc.schemaMigrations.length >= 1);
    assert.ok(counts.app_user >= 9 && counts.cell > 0, '예시 학교가 덤프에 있다');
    assert.ok(lines.some((l) => /^app_user\s+\d+$/.test(l.trim())));
    assert.ok(!raw.includes(SRC), '접속 주소가 파일에 없다');
    // 짧은 비밀번호(CI 의 'ci')는 아무 낱말에나 들어 있어 거짓 경보라 6자 이상만 찾는다
    const pw = new URL(SRC).password;
    if (pw.length >= 6) assert.ok(!raw.includes(pw), '비밀번호가 파일에 없다');
    assert.ok(raw.includes('$argon2'), '비밀 열(해시)은 그대로 든다');
  });

  await t.test('② 오류 메시지에서 주소를 가린다', async () => {
    const bad = 'postgres://zed:s3cr3tpw@127.0.0.1:1/nodb';
    await assert.rejects(dumpDb(bad, path.join(tmp, 'x.gz')), (e) => !/s3cr3tpw|zed:/.test(e.message));
    assert.ok(!redactor(bad)('연결 실패 ' + bad + ' pw s3cr3tpw').includes('s3cr3tpw'));
  });

  await t.test('③ 빈 DB 에 되넣으면 표마다 줄 수가 같다', async () => {
    const warns = [];
    const r = await restoreDb(DST, file, { warn: (s) => warns.push(s) });
    assert.deepEqual(r.counts, counts);
    for (const [tb, n] of Object.entries(counts)) {
      const got = (await dst.query(['SELECT count(*)::int AS n FROM public.', dst.escapeIdentifier(tb)].join(''))).rows[0].n;
      assert.equal(got, n, `${tb} 줄 수`);
    }
  });

  await t.test('④ 비밀번호 해시가 살아남아 로그인(검증)된다', async () => {
    const h = (await dst.query(`SELECT password_hash FROM app_user WHERE login_id = 'sample-admin'`)).rows[0].password_hash;
    assert.equal(await argon2.verify(h, PASSWORD), true);
  });

  await t.test('⑤ 새로 하나 넣어도 일련번호가 충돌하지 않는다', async () => {
    const r = await dst.query(`INSERT INTO org (name, kind) VALUES ('t1209r-새기관', '초') RETURNING id`);
    const mx = (await dst.query(`SELECT max(id)::int AS m FROM org WHERE name <> 't1209r-새기관'`)).rows[0].m;
    assert.ok(Number(r.rows[0].id) > mx);
    await dst.query(`DELETE FROM org WHERE name = 't1209r-새기관'`);
  });

  await t.test('⑥ 자료가 든 DB 에는 --force 없이 멈춘다', async () => {
    await assert.rejects(restoreDb(DST, file), /비어 있지 않다/);
  });

  await t.test('⑦ 더 새 마이그레이션이 있으면 경고하고 진행한다', async () => {
    const doc = JSON.parse(zlib.gunzipSync(readFileSync(file)).toString('utf8'));
    doc.schemaMigrations = doc.schemaMigrations.slice(0, -1);
    // 011(두 번째 교사)이 더한 열을 덤프에서도 뺀다 — 011 을 모르는 옛 서버의 덤프 흉내
    // 012(지우기 묶음)가 더한 표 둘도 덤프에서 뺀다 — 마지막 마이그레이션(012)을 모르는 옛 서버의 덤프 흉내
    for (const n of ['delete_batch', 'delete_batch_item']) delete doc.tables[n];
    // 013(명단 줄 독립)이 membership 에 더한 칸도 뺀다 — 마지막 마이그레이션(013)을 모르는 옛 서버의 덤프 흉내
    //   (name 은 org·special_room 등에도 있는 칸 이름이라 membership 표에서만 뺀다)
    for (const tb of Object.values(doc.tables)) { tb.columns = tb.columns.filter((c) => !['second_membership_id', 'second_hours'].includes(c.name)); }
    const M013 = ['name', 'birth_date', 'linked_at', 'linked_by', 'is_concurrent', 'concurrent_until'];
    doc.tables.membership.columns = doc.tables.membership.columns.filter((c) => !M013.includes(c.name));
    const old = path.join(tmp, 'old.json.gz');
    writeFileSync(old, zlib.gzipSync(Buffer.from(JSON.stringify(doc))));
    await wipe();
    const warns = [];
    await restoreDb(DST, old, { warn: (s) => warns.push(s) });
    assert.equal(warns.length, 1);
    assert.match(warns[0], /새 마이그레이션/);
  });
});
