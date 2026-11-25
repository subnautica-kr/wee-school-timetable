// 014(T-1320b) 새 표·계정 칸 — 깨끗한 DB · 013 까지 돈 DB(자료 있음) 에서 두 번 돌려도 같은 끝에 닿는지 본다.
// 시험 DB 옆에 「<시험 DB 이름>_m014c」·「_m014o」 를 만들어 쓰고 끝나면 지운다(시험 DB 자체는 안 건드린다).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HAS_DB = !!(process.env.DATABASE_URL || process.env.DATABASE_URL_FILE);
const skip = !HAS_DB && 'DB 없음 — 건너뜀';
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');
const NEW_TABLES = ['invite_code', 'unlinked_account', 'transfer_request', 'notification', 'notification_read',
  'board_post', 'board_comment', 'board_attachment', 'error_report', 'signup_attempt'];
const USER_COLS = ['birth_date', 'signed_up_at', 'first_linked_at', 'dormant_at', 'dormant_reason'];

async function freshDb(t, suffix) {
  const { databaseUrl } = await import('../server/db.js');
  const base = new URL(databaseUrl());
  const name = `${base.pathname.slice(1)}_${suffix}`.toLowerCase();
  assert.match(name, /^[a-z0-9_]+$/);
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(base); u.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: u.toString(), max: 2 });
  t.after(async () => {
    await pool.end();
    const c = new pg.Client({ connectionString: base.toString() });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await c.end();
  });
  return pool;
}

// schema.sql + 마이그레이션(upto 보다 앞 이름만 · 없으면 전부)
async function applyUpTo(pool, upto = null) {
  await pool.query(fs.readFileSync(path.join(SERVER, 'schema.sql'), 'utf8'));
  const mdir = path.join(SERVER, 'migrations');
  for (const f of fs.readdirSync(mdir).filter((n) => n.endsWith('.sql') && (!upto || n < upto)).sort()) {
    await pool.query(fs.readFileSync(path.join(mdir, f), 'utf8'));
  }
}

// 구조 찍기: 칸·제약·색인 + 계정 표 자료
async function snapshot(pool) {
  const cols = (await pool.query(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'public' ORDER BY 1, 2`)).rows;
  const cons = (await pool.query(`SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS d FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`)).rows;
  const idx = (await pool.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`)).rows;
  const users = (await pool.query(`SELECT id, first_linked_at, dormant_at FROM app_user ORDER BY id`)).rows;
  return JSON.parse(JSON.stringify({ cols, cons, idx, users }));
}

test('014: 깨끗한 DB 에서 두 번 돌려도 같은 끝 · 새 표 열 · 계정 칸 다섯', { skip }, async (t) => {
  const pool = await freshDb(t, 'm014c');
  await applyUpTo(pool);
  const one = await snapshot(pool);
  await applyUpTo(pool);
  assert.deepEqual(await snapshot(pool), one);
  const tables = new Set(one.cols.map((c) => c.table_name));
  for (const tb of NEW_TABLES) assert.ok(tables.has(tb), tb);
  const ucols = one.cols.filter((c) => c.table_name === 'app_user').map((c) => c.column_name);
  for (const c of USER_COLS) assert.ok(ucols.includes(c), c);
  // 저장 값 CHECK 가 codes.js 와 같은 값을 받는다
  await assert.rejects(pool.query(`INSERT INTO app_user (name, login_id, password_hash, dormant_reason) VALUES ('가','ga','x','nope')`), /check/i);
});

test('014: 013 까지 돈 DB(자료 있음)에서 — 연결된 적 있는 계정만 처음 연결 시각을 채우고 두 번째엔 안 바뀐다', { skip }, async (t) => {
  const pool = await freshDb(t, 'm014o');
  await applyUpTo(pool, '014');
  const q = async (sql, args) => Number((await pool.query(sql, args)).rows[0].id);
  const A = await q(`INSERT INTO org (name, kind) VALUES ('가초','초') RETURNING id`);
  const linked = await q(`INSERT INTO app_user (name, login_id, password_hash) VALUES ('가','ga','x') RETURNING id`);
  const loner = await q(`INSERT INTO app_user (name, login_id, password_hash) VALUES ('나','na','x') RETURNING id`);
  await pool.query(`INSERT INTO membership (org_id, user_id, role) VALUES ($1,$2,'교직원')`, [A, linked]);
  await pool.query(`INSERT INTO membership (org_id, name, role) VALUES ($1,'계정 없는 줄','교직원')`, [A]);
  await applyUpTo(pool);
  const one = await snapshot(pool);
  const byId = Object.fromEntries(one.users.map((u) => [Number(u.id), u]));
  assert.ok(byId[linked].first_linked_at, '연결 줄이 있는 계정은 채움');
  assert.equal(byId[loner].first_linked_at, null, '연결 줄 없는 계정은 비워 둠(7일 정리 대상 가름)');
  await applyUpTo(pool);
  assert.deepEqual(await snapshot(pool), one);
});
