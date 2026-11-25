// 013(T-1320a①) 명단 줄 독립 리허설 — 깨끗한 DB · 0.2.2 꼴 DB 에서 마이그레이션을 두 번씩 돌려 같은 끝에 닿는지 본다.
// 시험 DB 옆에 「<시험 DB 이름>_m013c」·「_m013o」 두 DB 를 만들어 쓰고 끝나면 지운다(시험 DB 자체는 안 건드린다).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { MEMBER_STATUS, MEMBER_STATUS_LOGIN, ROLE } from '../shared/codes.js';
import { ROLES } from '../server/permissions.js';

const HAS_DB = !!(process.env.DATABASE_URL || process.env.DATABASE_URL_FILE);
const skip = !HAS_DB && 'DB 없음 — 건너뜀';
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');

async function baseUrl() {
  const { databaseUrl } = await import('../server/db.js');
  return new URL(databaseUrl());
}
const urlFor = (base, db) => { const u = new URL(base); u.pathname = `/${db}`; return u.toString(); };

// 새 DB 하나를 만들고(있으면 지우고) 풀을 준다. t.after 로 지운다.
async function freshDb(t, suffix) {
  const base = await baseUrl();
  const name = `${base.pathname.slice(1)}_${suffix}`.toLowerCase();
  assert.match(name, /^[a-z0-9_]+$/);
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: urlFor(base, name), max: 2 });
  t.after(async () => {
    await pool.end();
    const c = new pg.Client({ connectionString: base.toString() });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await c.end();
  });
  return pool;
}

// 0.2.2 꼴: schema.sql + 001~012 만 돌리고, 013 과 함께 schema.sql 에서 바뀐 두 줄(:41 NOT NULL · :47 유일 제약)을 되돌린다
async function apply022(pool) {
  await pool.query(fs.readFileSync(path.join(SERVER, 'schema.sql'), 'utf8'));
  const mdir = path.join(SERVER, 'migrations');
  for (const f of fs.readdirSync(mdir).filter((n) => n.endsWith('.sql') && n < '013').sort()) {
    await pool.query(fs.readFileSync(path.join(mdir, f), 'utf8'));
  }
  await pool.query(`ALTER TABLE membership ALTER COLUMN user_id SET NOT NULL`);
  await pool.query(`ALTER TABLE membership ADD CONSTRAINT membership_user_id_org_id_key UNIQUE (user_id, org_id)`);
}

// 0.2.2 에서 실제로 생길 수 있는 자료: 겸임 데려오기(두 학교 줄) · 총괄관리자가 학교에도 소속 · 숨김 줄 · 지운 줄
async function seed022(pool) {
  const q = async (sql, args) => (await pool.query(sql, args)).rows[0]?.id;
  const edu = await q(`INSERT INTO org (name, kind) VALUES ('교육청', '상위 기관') RETURNING id`);
  const A = await q(`INSERT INTO org (name, kind) VALUES ('가초', '초') RETURNING id`);
  const B = await q(`INSERT INTO org (name, kind) VALUES ('나초', '초') RETURNING id`);
  const user = (name, login) => q(`INSERT INTO app_user (name, login_id, password_hash) VALUES ($1,$2,'x') RETURNING id`, [name, login]);
  const mem = (org, uid, role, status, at, deleted = null) =>
    q(`INSERT INTO membership (org_id, user_id, role, status, created_at, deleted_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [org, uid, role, status, at, deleted]);
  const dual = await user('겸임샘', 'dual');
  const sys = await user('총괄', 'sys');
  const hid = await user('숨김샘', 'hid');
  const del = await user('지운샘', 'del');
  const tri = await user('세학교샘', 'tri');
  return {
    A, B, edu, dual, sys, hid, del, tri,
    dualA: await mem(A, dual, '교직원', '사용', '2026-03-01'),
    dualB: await mem(B, dual, '교직원', '사용', '2026-04-01'),
    sysEdu: await mem(edu, sys, '시스템관리자', '사용', '2026-01-01'),
    sysA: await mem(A, sys, '기관관리자', '사용', '2026-02-01'),
    hidA: await mem(A, hid, '교직원', '숨김', '2026-03-01'),
    hidB: await mem(B, hid, '교직원', '사용', '2026-05-01'),
    delA: await mem(A, del, '교직원', '사용', '2026-03-01', '2026-06-01'),
    delB: await mem(B, del, '교직원', '사용', '2026-07-01'),
    triB: await mem(B, tri, '보기만', '사용', '2026-03-02', null),
    triA: await mem(A, tri, '교직원', '사용', '2026-03-01'),
    triEdu: await mem(edu, tri, '교직원', '사용', '2026-03-03'),
  };
}

// 표 꼴(칸·제약·색인·트리거) — 깨끗한 DB 와 옛 DB 가 같은 끝에 닿았는지 견준다
async function shape(pool) {
  const rows = async (sql) => (await pool.query(sql)).rows;
  return {
    columns: await rows(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
                          WHERE table_name = 'membership' ORDER BY column_name`),
    constraints: await rows(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
                              WHERE conrelid = 'membership'::regclass ORDER BY conname`),
    indexes: await rows(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'membership' ORDER BY indexname`),
    triggers: await rows(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'membership'::regclass AND NOT tgisinternal ORDER BY tgname`),
  };
}
const memRows = async (pool) =>
  (await pool.query(`SELECT id, org_id, user_id, name, role, status, is_concurrent, deleted_at FROM membership ORDER BY id`)).rows;

test('013 깨끗한 DB: 두 번 돌려도 같은 꼴 · 이름 칸·계정 없는 줄·재직 상태 넷·색인 둘·트리거', { skip }, async (t) => {
  const pool = await freshDb(t, 'm013c');
  const { migrate } = await import('../server/migrate.js');
  await migrate(pool);
  const s1 = await shape(pool);
  await migrate(pool);
  assert.deepEqual(await shape(pool), s1, '두 번째 돌림에서 꼴이 바뀌었다');

  const col = Object.fromEntries(s1.columns.map((c) => [c.column_name, c]));
  assert.equal(col.name.is_nullable, 'NO');
  assert.equal(col.user_id.is_nullable, 'YES');
  for (const c of ['birth_date', 'linked_at', 'linked_by', 'is_concurrent', 'concurrent_until']) assert.ok(col[c], `${c} 칸 없음`);
  const idx = s1.indexes.map((i) => i.indexname);
  assert.ok(idx.includes('membership_user_org_uq') && idx.includes('membership_primary_uq'), idx.join(','));
  assert.ok(!s1.constraints.some((c) => c.conname === 'membership_user_id_org_id_key'), '옛 유일 제약이 남았다');
  assert.deepEqual(s1.triggers.map((x) => x.tgname), ['membership_fill_before_write']);
});

test('013 0.2.2 꼴 DB: 두 번 돌려도 같은 자료 · 이름 베낌 · 둘째 학교 줄만 겸임 · 깨끗한 DB 와 같은 꼴', { skip }, async (t) => {
  const clean = await freshDb(t, 'm013c2');
  const old = await freshDb(t, 'm013o');
  const { migrate } = await import('../server/migrate.js');
  await migrate(clean);
  await apply022(old);
  const ids = await seed022(old);
  const before = await old.query(`SELECT id, status, user_id FROM membership ORDER BY id`);

  await migrate(old);
  const r1 = await memRows(old);
  const s1 = await shape(old);
  await migrate(old);
  assert.deepEqual(await memRows(old), r1, '두 번째 돌림에서 자료가 바뀌었다');
  assert.deepEqual(await shape(old), s1, '두 번째 돌림에서 꼴이 바뀌었다');
  assert.deepEqual(s1, await shape(clean), '옛 DB 와 깨끗한 DB 의 끝 꼴이 다르다');

  const by = Object.fromEntries(r1.map((r) => [r.id, r]));
  // 이름은 계정 이름 그대로
  const names = (await old.query(`SELECT m.id, m.name, u.name AS uname FROM membership m JOIN app_user u ON u.id = m.user_id`)).rows;
  for (const n of names) assert.equal(n.name, n.uname);
  // 재직 상태·계정 칸은 한 줄도 안 바뀜(옛 숨김 줄의 계정 칸도 그대로)
  assert.deepEqual(r1.map(({ id, status, user_id }) => ({ id, status, user_id })), before.rows);
  // 겸임 표시: 가장 오래된 줄만 본 소속
  const conc = r1.filter((r) => r.is_concurrent).map((r) => r.id).sort((a, b) => a - b);
  assert.deepEqual(conc, [ids.dualB, ids.triB, ids.triEdu].sort((a, b) => a - b));
  assert.equal(by[ids.triA].is_concurrent, false); // 세 줄 가운데 created_at 가장 이른 줄
  assert.equal(by[ids.sysA].is_concurrent, false); // 총괄관리자 줄은 안 센다
  assert.equal(by[ids.hidB].is_concurrent, false); // 숨김 줄은 본 소속을 다투지 않는다
  assert.equal(by[ids.delB].is_concurrent, false); // 지운 줄도
});

test('013 뒤 DB 규칙: 이름 채움 · 계정 없는 줄 · 상태 넷 · 지운 줄은 자리 안 차지 · 본 소속 하나', { skip }, async (t) => {
  const pool = await freshDb(t, 'm013r');
  const { migrate } = await import('../server/migrate.js');
  await apply022(pool);
  const ids = await seed022(pool);
  await migrate(pool);
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0];

  // 이름을 안 주면 계정 이름으로 채운다(옛 코드 29곳 꼴)
  const u = (await one(`INSERT INTO app_user (name, login_id, password_hash) VALUES ('새샘','new','x') RETURNING id`)).id;
  const m = await one(`INSERT INTO membership (org_id, user_id, role) VALUES ($1,$2,'교직원') RETURNING name, is_concurrent`, [ids.A, u]);
  assert.deepEqual(m, { name: '새샘', is_concurrent: false });
  // 주면 그 이름(둘째 학교 줄이라 겸임 표시는 쓰는 쪽이 넣는다)
  assert.equal((await one(`INSERT INTO membership (org_id, user_id, role, name, is_concurrent) VALUES ($1,$2,'교직원','학교가 적은 이름',TRUE) RETURNING name`, [ids.B, u])).name, '학교가 적은 이름');
  // 겸임 표시 없이 둘째 본 소속을 넣으면 이제 DB 가 막는다(017 이 「저절로 겸임」을 걷었다 · 판정은 앱 hasPrimaryLine)
  const C = (await one(`INSERT INTO org (name, kind) VALUES ('셋째학교','초') RETURNING id`)).id;
  await assert.rejects(pool.query(`INSERT INTO membership (org_id, user_id, role) VALUES ($1,$2,'교직원')`, [C, u]), { code: '23505' });
  // 계정 없는 줄
  assert.equal((await one(`INSERT INTO membership (org_id, role, name) VALUES ($1,'교직원','계정없는샘') RETURNING user_id`, [ids.A])).user_id, null);
  // 계정도 이름도 없으면 거절
  await assert.rejects(pool.query(`INSERT INTO membership (org_id, role) VALUES ($1,'교직원')`, [ids.A]), { code: '23502' });
  // 재직 상태 넷 · 그 밖은 거절
  //   hidA 는 다른 학교(B)에 본 소속이 있어 겸임으로 돌려야 재직·휴직이 된다
  for (const s of Object.values(MEMBER_STATUS)) await pool.query(`UPDATE membership SET status = $1, is_concurrent = TRUE WHERE id = $2`, [s, ids.hidA]);
  await pool.query(`UPDATE membership SET is_concurrent = FALSE WHERE id = $1`, [ids.hidA]);
  // 숨김 줄을 겸임 판정 없이 재직으로 풀면 DB 가 막는다(옛 트리거는 저절로 겸임으로 세웠다)
  await assert.rejects(pool.query(`UPDATE membership SET status = '사용' WHERE id = $1`, [ids.hidA]), { code: '23505' });
  assert.equal((await one(`SELECT status, is_concurrent FROM membership WHERE id = $1`, [ids.hidA])).status, '숨김');
  await assert.rejects(pool.query(`UPDATE membership SET status = '퇴직' WHERE id = $1`, [ids.hidA]), { code: '23514' });
  await pool.query(`UPDATE membership SET status = '숨김' WHERE id = $1`, [ids.hidA]);
  // 지운 줄은 자리를 안 차지한다 — 같은 학교에 같은 계정 줄을 다시 넣을 수 있다(본 소속이 다른 학교라 겸임으로 넣는다)
  await assert.rejects(pool.query(`INSERT INTO membership (org_id, user_id, role) VALUES ($1,$2,'교직원')`, [ids.A, ids.del]), { code: '23505' });
  const back = await one(`INSERT INTO membership (org_id, user_id, role, is_concurrent) VALUES ($1,$2,'교직원',TRUE) RETURNING is_concurrent`, [ids.A, ids.del]);
  assert.equal(back.is_concurrent, true);
  // 살아 있는 줄은 같은 학교에 둘 못 둔다
  await assert.rejects(pool.query(`INSERT INTO membership (org_id, user_id, role) VALUES ($1,$2,'교직원')`, [ids.B, ids.del]), { code: '23505' });
  // 본 소속 둘은 DB 가 막는다(겸임 표시를 떼면 걸림)
  await assert.rejects(pool.query(`UPDATE membership SET is_concurrent = FALSE WHERE id = $1`, [ids.dualB]), { code: '23505' });
  // 휴직도 본 소속으로 센다
  await pool.query(`UPDATE membership SET status = '휴직' WHERE id = $1`, [ids.dualA]);
  await assert.rejects(pool.query(`UPDATE membership SET is_concurrent = FALSE WHERE id = $1`, [ids.dualB]), { code: '23505' });
});

test('shared/codes.js: 재직 상태 옛 값 그대로 · 권한 값은 permissions.js 와 같음', () => {
  assert.equal(MEMBER_STATUS.ACTIVE, '사용');
  assert.equal(MEMBER_STATUS.RETIRED, '숨김');
  assert.deepEqual([...MEMBER_STATUS_LOGIN], ['사용', '휴직']);
  assert.deepEqual(Object.values(ROLE), ROLES);
  assert.ok(Object.isFrozen(MEMBER_STATUS));
  // 013 의 CHECK 값과 같은지
  const sql = fs.readFileSync(path.join(SERVER, 'migrations', '013_membership_line.sql'), 'utf8');
  const chk = sql.match(/membership_status_check CHECK \(status IN \(([^)]*)\)\)/)[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.deepEqual(chk.sort(), Object.values(MEMBER_STATUS).sort());
});
