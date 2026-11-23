import express from 'express';
import { z } from 'zod';
import { requireSystemAction } from '../guard.js';
import { NEW_ORG_FEATURES } from '../orgConfig.js';
import { createAccount, resetPassword, ID_RE } from '../accounts.js';
import { auditPage } from './audit-log.js';
import { audit, killSessions, killOrgSessions } from '../audit.js';
import { inTx, httpError } from '../cascade.js';

// 시스템 관리자(상위 기관) — 기관 관리 넷뿐: 기관 등록 · 기관 상태 · 첫 관리자 만들기 · 관리자 비밀번호 초기화.
// 기관 안 데이터(시간표·보결·근태·명단)는 못 본다. 명단·시간표 경로는 하나도 없고,
// 관리자 목록도 「이름·ID·상태」만 낸다(이 기관 관리자 비밀번호 초기화를 고르는 데 필요한 만큼).
const idParam = z.coerce.number().int().positive();
const orgBody = z.object({
  name: z.string().trim().min(1).max(100),
  ilgoaName: z.string().trim().max(100).optional().nullable(),
  orgCode: z.string().trim().max(50).optional().nullable(),
  kind: z.enum(['초', '중']),
});
const firstAdminBody = z.object({ name: z.string().trim().min(1).max(50), loginId: z.string().trim().regex(ID_RE) });

const concurrentBody = z.object({ loginId: z.string().trim().regex(ID_RE), role: z.enum(['기관관리자', '교직원', '보기만']) });

// 기관 삭제가 표시 삭제(deleted_at)하는 기관 자료 표 — 감사 기록(audit_log)·지운 묶음은 일부러 뺀다. 이 목록은 코드 상수다.
const ORG_DATA = ['cell', 'timetable', 'pin', 'teaching_load', 'substitute', 'booking', 'room_lock', 'attendance_allowed', 'attendance', 'month_close', 'classroom', 'term', 'subject', 'special_room'];
const confirmBody = z.object({ confirm: z.string() });
// 지우는 기관에만 속한 계정(다른 살아 있는 기관 소속이 없는 사람). 나머지는 겸임 계정
const SOLE_USERS = `SELECT m.user_id FROM membership m WHERE m.org_id = $1 AND m.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM membership o JOIN org oo ON oo.id = o.org_id AND oo.deleted_at IS NULL WHERE o.user_id = m.user_id AND o.org_id <> $1 AND o.deleted_at IS NULL)`;

// 계정 표시 삭제 — 로그인 ID 는 다시 쓸 수 있게 뒤에 번호를 붙여 비킨다. 소속·세션도 같이 정리.
async function dropUsers(c, ids) {
  if (!ids.length) return;
  await c.query(`UPDATE membership SET deleted_at = now() WHERE user_id = ANY($1::bigint[]) AND deleted_at IS NULL`, [ids]);
  await c.query(`UPDATE app_user SET deleted_at = now(), login_id = login_id || '~삭제' || id WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL`, [ids]);
  for (const id of ids) await killSessions(c, id);
}

export function adminRouter(pool) {
  const r = express.Router();
  r.use(requireSystemAction('org.manage'));
  const who = (req) => ({ userId: req.session.userId, orgId: req.session.orgId });
  const nf = (res) => res.status(404).json({ error: '없습니다' });

  // 감사 로그 — 기관을 골라서(audit-log.js 와 같은 조회)
  r.get('/orgs/:id/audit', async (req, res, next) => {
    try {
      const id = idParam.safeParse(req.params.id);
      if (!id.success) return nf(res);
      const out = await auditPage(pool, id.data, req.query);
      // 시스템 관리자는 기관 안 데이터를 못 본다(설계) — 상세 값은 비우고 누가·언제·무엇만
      if (out.items) out.items = out.items.map((it) => ({ ...it, before: null, after: null }));
      res.status(out.error ? 400 : 200).json(out);
    } catch (e) { next(e); }
  });

  r.get('/orgs', async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT o.id, o.name, o.ilgoa_name AS "ilgoaName", o.org_code AS "orgCode", o.kind, o.status,
                (SELECT count(*) FROM membership m WHERE m.org_id = o.id AND m.role = '기관관리자' AND m.deleted_at IS NULL)::int AS admins,
                (SELECT count(*) FROM membership m WHERE m.org_id = o.id AND m.deleted_at IS NULL)::int AS users,
                (SELECT max(u.last_login_at) FROM membership m JOIN app_user u ON u.id = m.user_id WHERE m.org_id = o.id AND m.deleted_at IS NULL) AS "lastActive"
           FROM org o WHERE o.deleted_at IS NULL ORDER BY (o.kind = '상위 기관') DESC, o.id`,
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  // 기관 등록
  r.post('/orgs', async (req, res, next) => {
    try {
      const p = orgBody.safeParse(req.body);
      if (!p.success) return res.status(400).json({ error: '입력을 확인해 주세요' });
      const d = p.data;
      const dup = await pool.query(`SELECT 1 FROM org WHERE name = $1 AND deleted_at IS NULL`, [d.name]);
      if (dup.rows[0]) return res.status(409).json({ error: '같은 이름의 기관이 이미 있습니다' });
      const { rows } = await pool.query(`INSERT INTO org (name, ilgoa_name, org_code, kind, config) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, kind, status`, [d.name, d.ilgoaName || null, d.orgCode || null, d.kind, JSON.stringify({ features: NEW_ORG_FEATURES })]);
      await audit(pool, { ...who(req), action: 'org.create', table: 'org', rowId: rows[0].id, after: rows[0] });
      res.status(201).json(rows[0]);
    } catch (e) {
      next(e);
    }
  });

  // 기관 상태(사용/중지) · 이름·표기·코드 고치기. 상위 기관 자기 자신은 못 멈춘다.
  r.patch('/orgs/:id', async (req, res, next) => {
    try {
      const id = idParam.safeParse(req.params.id);
      const p = orgBody.partial().extend({ status: z.enum(['사용', '중지']).optional() }).safeParse(req.body);
      if (!id.success || !p.success) return res.status(400).json({ error: '입력을 확인해 주세요' });
      const org = (await pool.query(`SELECT id, kind, status FROM org WHERE id = $1 AND deleted_at IS NULL`, [id.data])).rows[0];
      if (!org) return nf(res);
      const d = p.data;
      if (org.kind === '상위 기관' && (d.status === '중지' || d.kind)) return res.status(400).json({ error: '상위 기관 자신은 멈추거나 종류를 바꿀 수 없습니다' });
      if (d.name) {
        const dup = await pool.query(`SELECT 1 FROM org WHERE name = $1 AND id <> $2 AND deleted_at IS NULL`, [d.name, id.data]);
        if (dup.rows[0]) return res.status(409).json({ error: '같은 이름의 기관이 이미 있습니다' });
      }
      await pool.query(
        `UPDATE org SET name = COALESCE($2, name), ilgoa_name = CASE WHEN $3::boolean THEN $4 ELSE ilgoa_name END,
                org_code = CASE WHEN $5::boolean THEN $6 ELSE org_code END, kind = COALESCE($7, kind), status = COALESCE($8, status)
          WHERE id = $1`,
        [id.data, d.name ?? null, 'ilgoaName' in d, d.ilgoaName || null, 'orgCode' in d, d.orgCode || null, d.kind ?? null, d.status ?? null],
      );
      if (d.status === '중지') await killOrgSessions(pool, id.data);
      await audit(pool, { ...who(req), action: 'org.update', table: 'org', rowId: id.data, before: { status: org.status }, after: d });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // 기관 관리자 목록(이름·ID·상태만) — 비밀번호 초기화 대상을 고르는 용도
  r.get('/orgs/:id/admins', async (req, res, next) => {
    try {
      const id = idParam.safeParse(req.params.id);
      if (!id.success) return nf(res);
      const { rows } = await pool.query(
        `SELECT u.id AS "userId", u.name, u.login_id AS "loginId", u.status, u.must_change_password AS "mustChange"
           FROM membership m JOIN app_user u ON u.id = m.user_id AND u.deleted_at IS NULL
          WHERE m.org_id = $1 AND m.role = '기관관리자' AND m.deleted_at IS NULL ORDER BY u.id`,
        [id.data],
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  // 첫 관리자 만들기(이미 있는 ID 면 그 사람에게 소속만 더한다 — 겸임)
  r.post('/orgs/:id/first-admin', async (req, res, next) => {
    try {
      const id = idParam.safeParse(req.params.id);
      const p = firstAdminBody.safeParse(req.body);
      if (!id.success || !p.success) return res.status(400).json({ error: '입력을 확인해 주세요(ID 에는 공백·따옴표·슬래시를 쓸 수 없습니다)' });
      const org = (await pool.query(`SELECT id, kind FROM org WHERE id = $1 AND deleted_at IS NULL`, [id.data])).rows[0];
      if (!org || org.kind === '상위 기관') return nf(res);
      const a = await createAccount(pool, { orgId: id.data, name: p.data.name, loginId: p.data.loginId, role: '기관관리자', existing: 'add' });
      if (a.error) return res.status(409).json({ error: a.error });
      await audit(pool, { ...who(req), action: 'org.first-admin', table: 'membership', rowId: a.membershipId, after: { orgId: id.data, loginId: p.data.loginId } });
      res.status(201).json({ userId: a.userId, loginId: p.data.loginId, temp: a.temp, existing: a.temp === null });
    } catch (e) {
      next(e);
    }
  });

  // 겸임 소속 추가 — 이미 있는 계정(로그인 ID)에 이 기관 소속을 더한다. 역할을 고른다.
  // 계정 ID·기관·역할만 다룬다(이름·비밀번호는 안 낸다 — 기존 계정은 비밀번호 그대로).
  r.post('/orgs/:id/members', async (req, res, next) => {
    try {
      const id = idParam.safeParse(req.params.id);
      const p = concurrentBody.safeParse(req.body);
      if (!id.success || !p.success) return res.status(400).json({ error: '입력을 확인해 주세요' });
      const org = (await pool.query(`SELECT id, kind FROM org WHERE id = $1 AND deleted_at IS NULL`, [id.data])).rows[0];
      if (!org || org.kind === '상위 기관') return nf(res);
      const u = (await pool.query(`SELECT id, login_id FROM app_user WHERE lower(login_id) = lower($1) AND deleted_at IS NULL`, [p.data.loginId])).rows[0];
      if (!u) return res.status(404).json({ error: '그 ID 의 계정이 없습니다' });
      const a = await createAccount(pool, { orgId: id.data, name: '', loginId: u.login_id, role: p.data.role, existing: 'add' });
      if (a.error) return res.status(409).json({ error: a.error });
      await audit(pool, { ...who(req), action: 'org.concurrent-add', table: 'membership', rowId: a.membershipId, after: { orgId: id.data, loginId: u.login_id, role: p.data.role } });
      res.status(201).json({ userId: a.userId, loginId: u.login_id, role: p.data.role });
    } catch (e) {
      next(e);
    }
  });

  // 비밀번호 초기화(비상문, 겸임 계정 포함) — 임시 비밀번호가 한 번 보인다
  r.post('/orgs/:id/reset-password', async (req, res, next) => {
    try {
      const id = idParam.safeParse(req.params.id);
      const uid = idParam.safeParse(req.body?.userId);
      if (!id.success || !uid.success) return res.status(400).json({ error: '입력을 확인해 주세요' });
      // 겸임 계정도 푼다(시스템 관리자 비상문). 시스템 관리자 계정 자체는 제외 — 감사 기록에 겸임 여부를 남긴다.
      const m = (await pool.query(`SELECT 1 FROM membership WHERE org_id = $1 AND user_id = $2 AND role <> '시스템관리자' AND deleted_at IS NULL`, [id.data, uid.data])).rows[0];
      if (!m) return nf(res);
      if ((await pool.query(`SELECT 1 FROM membership WHERE user_id = $1 AND role = '시스템관리자' AND deleted_at IS NULL LIMIT 1`, [uid.data])).rows[0]) return nf(res);
      const shared = !!(await pool.query(`SELECT 1 FROM membership WHERE user_id = $1 AND org_id <> $2 AND deleted_at IS NULL LIMIT 1`, [uid.data, id.data])).rows[0];
      const temp = await resetPassword(pool, uid.data);
      await killSessions(pool, uid.data);
      await audit(pool, { ...who(req), action: 'admin.reset-password', table: 'app_user', rowId: uid.data, after: { orgId: id.data, shared } });
      res.json({ temp });
    } catch (e) {
      next(e);
    }
  });

  // ── 지우기(T-1213) ──
  const fail = (res, next, e) => (e.expose ? res.status(e.status).json({ error: e.message }) : next(e)); // httpError 의 한국어 이유를 그대로 낸다
  const adminCount = async (db, orgId, exceptUser) => (await db.query(
    `SELECT count(*)::int AS n FROM membership WHERE org_id = $1 AND role = '기관관리자' AND status = '사용' AND deleted_at IS NULL AND user_id <> $2`, [orgId, exceptUser])).rows[0].n;

  // 기관 삭제 미리보기 — 영향 수만(내용은 안 냄)
  r.get('/orgs/:id/delete-preview', async (req, res, next) => {
    try {
      const id = idParam.safeParse(req.params.id);
      const org = id.success && (await pool.query(`SELECT id, name, kind, status FROM org WHERE id = $1 AND deleted_at IS NULL`, [id.data])).rows[0];
      if (!org || org.kind === '상위 기관') return nf(res);
      const cnt = async (table) => (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1 AND deleted_at IS NULL`, [org.id])).rows[0].n;
      const sole = (await pool.query(SOLE_USERS, [org.id])).rows.length;
      const members = await cnt('membership');
      res.json({
        target: { id: Number(org.id), name: org.name, status: org.status }, confirmText: org.name,
        canDelete: org.status === '중지',
        warnings: org.status === '중지' ? [] : ['먼저 중지하세요'],
        counts: { accounts: sole, concurrentKept: members - sole, classrooms: await cnt('classroom'), terms: await cnt('term'), timetables: await cnt('timetable'), subjects: await cnt('subject'), specialRooms: await cnt('special_room') },
      });
    } catch (e) { fail(res, next, e); }
  });

  // 기관 삭제 — 중지된 기관만 · 확인 글자 = 기관 이름. 표시 삭제(deleted_at)라 감사 기록은 그대로 남고 기관 줄도 남는다.
  r.delete('/orgs/:id', async (req, res, next) => {
    try {
      const id = idParam.safeParse(req.params.id);
      const p = confirmBody.safeParse(req.body);
      if (!id.success || !p.success) return res.status(400).json({ error: '입력을 확인해 주세요' });
      const out = await inTx(pool, async (c) => {
        const org = (await c.query(`SELECT id, name, kind, status FROM org WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id.data])).rows[0];
        if (!org || org.kind === '상위 기관') return null;
        if (org.status !== '중지') throw httpError(409, '활성 기관은 지울 수 없습니다. 먼저 중지하세요');
        if (p.data.confirm !== org.name) throw httpError(400, `확인 글자가 다릅니다. 「${org.name}」을 그대로 입력해 주세요`);
        const sole = (await c.query(SOLE_USERS, [org.id])).rows.map((x) => x.user_id);
        await dropUsers(c, sole);
        await c.query(`UPDATE membership SET deleted_at = now() WHERE org_id = $1 AND deleted_at IS NULL`, [org.id]); // 겸임 계정은 소속만
        for (const table of ORG_DATA) await c.query(`UPDATE ${table} SET deleted_at = now() WHERE org_id = $1 AND deleted_at IS NULL`, [org.id]);
        await c.query(`UPDATE org SET deleted_at = now() WHERE id = $1`, [org.id]);
        await killOrgSessions(c, org.id);
        await audit(c, { ...who(req), action: 'org.delete', table: 'org', rowId: org.id, before: { name: org.name, status: org.status }, after: { accounts: sole.length } });
        return { name: org.name, accounts: sole.length };
      });
      if (!out) return nf(res);
      res.json({ ok: true, ...out });
    } catch (e) { fail(res, next, e); }
  });

  // 계정 삭제 — 확인 글자 = 로그인 ID. 자기 자신·마지막 시스템 관리자·어느 기관의 마지막 관리자는 409.
  r.delete('/users/:uid', async (req, res, next) => {
    try {
      const uid = idParam.safeParse(req.params.uid);
      const p = confirmBody.safeParse(req.body);
      if (!uid.success || !p.success) return res.status(400).json({ error: '입력을 확인해 주세요' });
      const out = await inTx(pool, async (c) => {
        const u = (await c.query(`SELECT id, login_id FROM app_user WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [uid.data])).rows[0];
        if (!u) return null;
        if (Number(u.id) === Number(req.session.userId)) throw httpError(409, '자기 자신은 지울 수 없습니다');
        const isSys = (await c.query(`SELECT 1 FROM membership WHERE user_id = $1 AND role = '시스템관리자' AND deleted_at IS NULL LIMIT 1`, [u.id])).rows[0];
        if (isSys && !(await c.query(`SELECT 1 FROM membership WHERE user_id <> $1 AND role = '시스템관리자' AND status = '사용' AND deleted_at IS NULL LIMIT 1`, [u.id])).rows[0]) throw httpError(409, '마지막 시스템 관리자는 지울 수 없습니다');
        const mine = (await c.query(`SELECT o.id, o.name FROM membership m JOIN org o ON o.id = m.org_id AND o.deleted_at IS NULL WHERE m.user_id = $1 AND m.role = '기관관리자' AND m.deleted_at IS NULL`, [u.id])).rows;
        for (const o of mine) if (!(await adminCount(c, o.id, u.id))) throw httpError(409, `「${o.name}」의 마지막 관리자라 지울 수 없습니다. 먼저 다른 관리자를 세워 주세요`);
        if (p.data.confirm !== u.login_id) throw httpError(400, `확인 글자가 다릅니다. 아이디 「${u.login_id}」를 그대로 입력해 주세요`);
        await dropUsers(c, [u.id]);
        await audit(c, { ...who(req), action: 'admin.delete-user', table: 'app_user', rowId: u.id, before: { loginId: u.login_id } });
        return { loginId: u.login_id };
      });
      if (!out) return nf(res);
      res.json({ ok: true, ...out });
    } catch (e) { fail(res, next, e); }
  });

  // 기관 관리자 떼기 — 계정·소속은 남기고 역할만 교직원으로. 마지막 관리자면 409.
  r.post('/orgs/:id/admins/:uid/demote', async (req, res, next) => {
    try {
      const id = idParam.safeParse(req.params.id);
      const uid = idParam.safeParse(req.params.uid);
      if (!id.success || !uid.success) return nf(res);
      const ok = await inTx(pool, async (c) => {
        const m = (await c.query(`SELECT m.id FROM membership m JOIN org o ON o.id = m.org_id AND o.deleted_at IS NULL WHERE m.org_id = $1 AND m.user_id = $2 AND m.role = '기관관리자' AND m.deleted_at IS NULL FOR UPDATE OF m`, [id.data, uid.data])).rows[0];
        if (!m) return false;
        if (!(await adminCount(c, id.data, uid.data))) throw httpError(409, '마지막 관리자는 뗄 수 없습니다. 먼저 다른 관리자를 세워 주세요');
        await c.query(`UPDATE membership SET role = '교직원' WHERE id = $1`, [m.id]);
        await killSessions(c, uid.data);
        await audit(c, { ...who(req), action: 'admin.demote', table: 'membership', rowId: m.id, before: { role: '기관관리자' }, after: { orgId: id.data, role: '교직원' } });
        return true;
      });
      if (!ok) return nf(res);
      res.json({ ok: true });
    } catch (e) { fail(res, next, e); }
  });
  return r;
}
