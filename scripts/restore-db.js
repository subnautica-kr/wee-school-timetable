// dump-db.js 가 뜬 파일을 「빈 DB」에 되넣는다.
//   DATABASE_URL=... node scripts/restore-db.js <파일> [--force]
// 스키마부터 깔고(덤프에 적힌 마이그레이션까지만) · 표마다 줄을 넣고 · 일련번호를 최댓값으로 맞춘다.
// 대상 DB 에 이미 자료가 있으면 멈춘다(--force 없이는). DB 주소는 어디에도 남기지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { redactor, listTables } from './dump-db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BATCH = 500;

// 참조 받는 표가 먼저 오게 줄 세운다(자기 참조는 무시 · 고리가 있으면 남은 것을 뒤에)
async function fkOrder(client, names) {
  const r = await client.query(
    `SELECT con.conrelid::regclass::text AS child, con.confrelid::regclass::text AS parent
       FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_namespace n ON n.oid = con.connamespace
      WHERE con.contype = 'f' AND n.nspname = 'public'`);
  const strip = (s) => s.replace(/^public\./, '').replace(/^"|"$/g, '');
  const deps = new Map(names.map((n) => [n, new Set()]));
  for (const { child, parent } of r.rows) {
    const c = strip(child), p = strip(parent);
    if (c !== p && deps.has(c) && deps.has(p)) deps.get(c).add(p);
  }
  const out = [];
  const left = new Set(names);
  while (left.size) {
    const ready = [...left].filter((n) => [...deps.get(n)].every((d) => !left.has(d)));
    const pick = ready.length ? ready : [...left];
    for (const n of pick) { out.push(n); left.delete(n); }
  }
  return out;
}

export async function restoreDb(url, file, { force = false, log = () => {}, warn = () => {} } = {}) {
  const red = redactor(url);
  let doc;
  try {
    doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  } catch (e) {
    throw new Error('덤프 파일을 못 읽었다: ' + e.message);
  }
  if (doc.format !== 'wee-timetable-dbdump' || doc.version !== 1) throw new Error('이 도구의 덤프 파일이 아니다');

  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    // 1) 빈 DB 인지 — public 의 어느 표든 줄이 있으면 멈춘다
    if (!force) {
      for (const t of await listTables(client)) {
        const sql = ['SELECT 1 FROM', 'public.' + client.escapeIdentifier(t.name), 'LIMIT 1'].join(' ');
        if ((await client.query(sql)).rowCount) throw new Error(`대상 DB 가 비어 있지 않다(표 ${t.name} 에 자료) — 빈 DB 에 하거나 --force`);
      }
    }
    // 2) 스키마: 덤프에 적힌 마이그레이션까지만
    const mdir = path.join(here, '..', 'server', 'migrations');
    const have = fs.readdirSync(mdir).filter((n) => n.endsWith('.sql')).sort().map((n) => n.slice(0, -4));
    const newer = have.filter((n) => !doc.schemaMigrations.includes(n));
    if (newer.length) warn(`경고: 이 코드에는 덤프보다 새 마이그레이션이 있다(${newer.join(', ')}) — 깔지 않고 되넣는다. 서버 시작(npm start)이 나중에 적용한다`);
    await client.query(fs.readFileSync(path.join(here, '..', 'server', 'schema.sql'), 'utf8'));
    for (const n of doc.schemaMigrations) {
      const f = path.join(mdir, n + '.sql');
      if (!fs.existsSync(f)) throw new Error(`덤프가 쓴 마이그레이션 ${n} 이 이 코드에 없다`);
      await client.query(fs.readFileSync(f, 'utf8'));
    }
    // 3) 줄 넣기(한 트랜잭션)
    const present = new Set((await listTables(client)).map((t) => t.name));
    const names = Object.keys(doc.tables);
    const missing = names.filter((n) => !present.has(n));
    if (missing.length) throw new Error('되넣을 표가 대상 스키마에 없다: ' + missing.join(', '));
    const order = await fkOrder(client, names);
    await client.query('BEGIN');
    const counts = {};
    for (const name of order) {
      const { columns, rows } = doc.tables[name];
      counts[name] = rows.length;
      if (!rows.length) continue;
      const qt = 'public.' + client.escapeIdentifier(name);
      const colSql = columns.map((c) => client.escapeIdentifier(c.name)).join(', ');
      const per = columns.length;
      // 한 문장에 넣을 수 있는 값 수(65535)를 넘기지 않게 줄 수를 줄인다
      const step = Math.max(1, Math.min(BATCH, Math.floor(60000 / per)));
      for (let i = 0; i < rows.length; i += step) {
        const chunk = rows.slice(i, i + step);
        const args = [];
        const tuples = chunk.map((row, ri) => {
          const ph = columns.map((c, ci) => { args.push(row[c.name] ?? null); return `$${ri * per + ci + 1}::${c.type}`; });
          return '(' + ph.join(', ') + ')';
        });
        await client.query(['INSERT INTO', qt, '(' + colSql + ') OVERRIDING SYSTEM VALUE VALUES', tuples.join(', ')].join(' '), args);
      }
    }
    // 4) 일련번호를 최댓값으로
    for (const name of names) {
      const qt = 'public.' + client.escapeIdentifier(name);
      for (const c of doc.tables[name].columns) {
        const seq = (await client.query('SELECT pg_catalog.pg_get_serial_sequence($1, $2) AS s', [qt, c.name])).rows[0].s;
        if (!seq) continue;
        const col = client.escapeIdentifier(c.name);
        const mx = (await client.query(['SELECT max(', col, ') AS m FROM', qt].join(' '))).rows[0].m;
        if (mx == null) await client.query('SELECT pg_catalog.setval($1, 1, false)', [seq]);
        else await client.query('SELECT pg_catalog.setval($1, $2::bigint, true)', [seq, mx]);
      }
    }
    await client.query('COMMIT');
    for (const n of order) log(`${n.padEnd(24)} ${String(counts[n]).padStart(8)}`);
    return { counts, newer };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(red(e.message));
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const url = process.env.DATABASE_URL;
  if (!file || !url) { console.error('쓰는 법: DATABASE_URL=... node scripts/restore-db.js <파일> [--force]'); process.exit(1); }
  try {
    console.log('표                          줄 수');
    await restoreDb(url, file, { force: args.includes('--force'), log: console.log, warn: console.warn });
    console.log('되넣기 완료');
  } catch (e) {
    console.error('되넣기 실패:', e.message);
    process.exit(1);
  }
}
