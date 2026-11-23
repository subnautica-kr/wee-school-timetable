// DB 통째 백업(pg_dump 가 없을 때): public 스키마 전 표를 gzip JSON 하나로 뜬다. 비밀 열도 빼지 않는다(통째 복구용 — 파일은 쥔님 PC 에만).
//   DATABASE_URL=... node scripts/dump-db.js [--out 파일]
// DB 주소는 자격증명이라 출력·로그·파일에 남기지 않고 오류 메시지에서도 가린다.
// 값은 전부 ::text 로 읽어 되넣을 때 ::형 으로 되돌린다(시각 마이크로초·numeric·jsonb 가 깎이지 않는다).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const PAGE = 100000;

// 오류 글에서 주소 조각(전체·비밀번호·호스트)을 가린다
export function redactor(url) {
  const bits = [url];
  try {
    const u = new URL(url);
    for (const b of [decodeURIComponent(u.password), u.password, u.username, u.hostname]) if (b && b.length >= 3) bits.push(b);
  } catch { /* 주소 꼴이 아니면 통째만 가린다 */ }
  bits.sort((a, b) => b.length - a.length);
  return (s) => bits.reduce((t, b) => t.split(b).join('***'), String(s));
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// 표 목록 · 표마다 열(이름·형 · 생성열 제외). 이름은 pg_catalog 에서 받은 것만 쓴다.
export async function listTables(client) {
  const t = await client.query(
    `SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY c.relname`);
  const out = [];
  for (const { name } of t.rows) {
    const cols = await client.query(
      `SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type
         FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = ('public.' || pg_catalog.quote_ident($1::text))::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
        ORDER BY a.attnum`, [name]);
    out.push({ name, columns: cols.rows });
  }
  return out;
}

export async function dumpDb(url, outFile, log = () => {}) {
  const client = new pg.Client({ connectionString: url });
  const red = redactor(url);
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); // 표마다 읽는 시각이 어긋나지 않게
    const tables = {};
    const counts = [];
    for (const t of await listTables(client)) {
      const qt = 'public.' + client.escapeIdentifier(t.name);
      const sel = t.columns.map((c) => client.escapeIdentifier(c.name) + '::text AS ' + client.escapeIdentifier(c.name)).join(', ');
      const rows = [];
      for (let off = 0; ; off += PAGE) {
        const sql = ['SELECT', sel, 'FROM', qt, 'ORDER BY ctid LIMIT $1 OFFSET $2'].join(' ');
        const r = await client.query(sql, [PAGE, off]);
        for (const row of r.rows) rows.push(row);
        if (r.rows.length < PAGE) break;
      }
      tables[t.name] = { columns: t.columns, rows };
      counts.push([t.name, rows.length]);
    }
    await client.query('COMMIT');
    // 마이그레이션 표가 따로 없다 — 코드가 가진 migrations 파일 이름이 그 대신(되넣을 때 여기까지만 깐다)
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'migrations');
    const schemaMigrations = fs.readdirSync(dir).filter((n) => n.endsWith('.sql')).sort().map((n) => n.slice(0, -4));
    const doc = { format: 'wee-timetable-dbdump', version: 1, at: new Date().toISOString(), schemaMigrations, tables };
    fs.writeFileSync(outFile, zlib.gzipSync(Buffer.from(JSON.stringify(doc))));
    for (const [n, c] of counts) log(`${n.padEnd(24)} ${String(c).padStart(8)}`);
    return { counts: Object.fromEntries(counts), schemaMigrations };
  } catch (e) {
    throw new Error(red(e.message));
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? process.argv[i + 1] : `dbdump-${stamp()}.json.gz`;
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL 환경변수가 없다'); process.exit(1); }
  try {
    console.log('표                          줄 수');
    await dumpDb(url, out, console.log);
    console.log(`저장: ${out}  (비밀번호 해시 등 비밀이 그대로 든 파일 — 안전한 곳에만 둔다)`);
  } catch (e) {
    console.error('백업 실패:', e.message);
    process.exit(1);
  }
}
