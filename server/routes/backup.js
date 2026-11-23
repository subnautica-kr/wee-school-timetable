import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { requireOrgAction } from '../guard.js';
import { audit } from '../audit.js';

// 학교 자료 내려받기(백업) — 기관 관리자만, 자기 기관 줄만 JSON 한 파일로.
// 표마다 열을 손으로 고르지 않고 select * 로 전 열을 담는다(나중에 더해지는 열도 저절로 담김).
// 비밀은 열 이름 규칙(SECRET)으로 뺀다 — 새 비밀 열이 생겨도 이름이 걸리면 빠진다. 세션 표는 아예 안 담는다.
// SQL 은 표마다 고정 문자열이다(표 이름을 ${} 로 끼우지 않는다).
const TABLES = {
  term: 'SELECT * FROM term WHERE org_id = $1 ORDER BY id',
  classroom: 'SELECT * FROM classroom WHERE org_id = $1 ORDER BY id',
  subject: 'SELECT * FROM subject WHERE org_id = $1 ORDER BY id',
  special_room: 'SELECT * FROM special_room WHERE org_id = $1 ORDER BY id',
  membership: 'SELECT * FROM membership WHERE org_id = $1 ORDER BY id',
  // 사람은 org 에 안 매이지만 이 기관 소속 줄을 거쳐 이어진다(다른 기관 소속 줄은 안 건드림)
  app_user: 'SELECT * FROM app_user WHERE id IN (SELECT user_id FROM membership WHERE org_id = $1) ORDER BY id',
  teaching_load: 'SELECT * FROM teaching_load WHERE org_id = $1 ORDER BY id',
  pin: 'SELECT * FROM pin WHERE org_id = $1 ORDER BY id',
  timetable: 'SELECT * FROM timetable WHERE org_id = $1 ORDER BY id',
  cell: 'SELECT * FROM cell WHERE org_id = $1 ORDER BY id',
  substitute: 'SELECT * FROM substitute WHERE org_id = $1 ORDER BY id',
  booking: 'SELECT * FROM booking WHERE org_id = $1 ORDER BY id',
  room_lock: 'SELECT * FROM room_lock WHERE org_id = $1 ORDER BY id',
  attendance_allowed: 'SELECT * FROM attendance_allowed WHERE org_id = $1 ORDER BY id',
  attendance: 'SELECT * FROM attendance WHERE org_id = $1 ORDER BY id',
  month_close: 'SELECT * FROM month_close WHERE org_id = $1 ORDER BY id',
  audit_log: 'SELECT * FROM audit_log WHERE org_id = $1 ORDER BY id',
};
const SECRET = /hash|secret|token|csrf|^sid$|^sess|^password$|^temp/i; // must_change_password 는 비밀이 아니라 남긴다
const clean = (v) => {
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET.test(k)).map(([k, x]) => [k, clean(x)]));
  return v;
};

const migDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
export const schemaVersion = () => (fs.readdirSync(migDir).filter((n) => n.endsWith('.sql')).sort().pop() ?? '').replace(/\.sql$/, '');

export async function buildBackup(pool, orgId) {
  const org = (await pool.query('SELECT * FROM org WHERE id = $1', [orgId])).rows[0];
  if (!org) return null;
  const tables = {};
  for (const [name, sql] of Object.entries(TABLES)) tables[name] = clean((await pool.query(sql, [orgId])).rows);
  return { format: 'wee-timetable-backup', version: 1, exportedAt: new Date().toISOString(), org: clean(org), schemaVersion: schemaVersion(), tables };
}

export function backupRouter(pool) {
  const r = express.Router({ mergeParams: true });
  r.get('/backup', requireOrgAction('school.backup'), async (req, res, next) => {
    try {
      const out = await buildBackup(pool, req.orgId);
      if (!out) return res.status(404).json({ error: '없습니다' });
      const ymd = new Date().toISOString().slice(0, 10).replaceAll('-', '');
      const slug = String(out.org.name).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || `org${req.orgId}`;
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="backup-${slug}-${ymd}.json"; filename*=UTF-8''${encodeURIComponent(`backup-${out.org.name}-${ymd}.json`)}`);
      await audit(pool, { orgId: req.orgId, userId: req.session.userId, action: 'org.backup', table: 'org', rowId: req.orgId, after: { tables: Object.keys(out.tables).length } });
      res.send(JSON.stringify(out));
    } catch (e) { next(e); }
  });
  return r;
}
