import express from 'express';
import { z } from 'zod';
import { requireOrgAction } from '../guard.js';
import { fail } from '../fail.js';
import { t, 값이름 } from '../../shared/text/index.js';
import { MEMBER_STATUS, MEMBER_STATUS_LOGIN, ROLE, DORMANT_REASON, TRANSFER_STATUS } from '../../shared/codes.js';
import { moveOut } from '../accounts.js';
import { linkAccount, unlinkAccount, withTx } from '../link.js';
import { audit } from '../audit.js';
import { notify } from '../notify.js';
import { registerCleanup } from '../cleanup.js';
import { loadConfig } from '../orgConfig.js';

// 전출 요청(T-1322b①) — 받는 학교가 「아이디로 연결」에서 다른 학교 재직 계정을 고르면 그 학교(보내는 학교)에 요청이 선다.
// 보내는 학교 기관 관리자가 승인하면: 앞 학교 줄 「전출」(moveOut) → 공용 「해제」(unlinkAccount) → 받는 학교 줄에 「연결」(linkAccount).
// 계정만 옮겨 가고 앞 학교 명단 줄·시간표는 그대로 — 담임·수업은 비우지 않고 「담당 비었음」 소식으로 알린다.
// 7일 지나면 만료(읽을 때 이미 만료로 보고, 정리 작업이 상태를 닫고 받는 학교에 「다음 길」 소식).
// 받는 쪽 알림은 소식 줄이 아니라 할 일 건수다(notifications.js 가 센다).
// 경로는 기관 경로 /api/orgs/:orgId/transfers — 모든 쿼리에 from_org 또는 to_org = 세션 기관.

const idParam = z.coerce.number().int().positive();
const orgName = async (db, id) => (await db.query(`SELECT name FROM org WHERE id = $1`, [id])).rows[0]?.name ?? '';
const lineName = async (db, mid) => (await db.query(`SELECT name FROM membership WHERE id = $1`, [mid])).rows[0]?.name ?? '';
const birthText = (d) => (d ? new Date(d).toLocaleDateString('sv-SE') : '');

// 이 계정의 지금 본 소속 학교(orgId 아닌 학교의 재직·휴직 본 소속 줄) — 없으면 null
export async function homeOrgOf(db, userId, orgId) {
  const row = (await db.query(
    `SELECT org_id FROM membership WHERE user_id = $1 AND org_id <> $2 AND deleted_at IS NULL
        AND status = ANY($3::text[]) AND NOT is_concurrent AND role <> $4 ORDER BY id LIMIT 1`,
    [userId, orgId, MEMBER_STATUS_LOGIN, ROLE.SYSADMIN])).rows[0];
  return row ? Number(row.org_id) : null;
}

// 보내는 학교에 있는 그 계정의 본 소속 줄
const homeLines = async (db, userId, orgId) => (await db.query(
  `SELECT id, name FROM membership WHERE user_id = $1 AND org_id = $2 AND deleted_at IS NULL
      AND status = ANY($3::text[]) AND NOT is_concurrent AND role <> $4 ORDER BY id FOR UPDATE`,
  [userId, orgId, MEMBER_STATUS_LOGIN, ROLE.SYSADMIN])).rows;

// 줄들이 맡은 담임·수업 수(자료는 안 지운다 — 담당 비었음 표시용)
async function vacancy(db, orgId, mids) {
  if (!mids.length) return { homeroom: 0, classes: 0 };
  const h = (await db.query(`SELECT count(*)::int AS n FROM classroom WHERE org_id = $1 AND homeroom_membership_id = ANY($2::bigint[]) AND deleted_at IS NULL`, [orgId, mids])).rows[0].n;
  const l = (await db.query(`SELECT count(*)::int AS n FROM teaching_load WHERE org_id = $1 AND (membership_id = ANY($2::bigint[]) OR second_membership_id = ANY($2::bigint[])) AND deleted_at IS NULL`, [orgId, mids])).rows[0].n;
  return { homeroom: h, classes: l };
}

// 승인(거래 안). orgId = 보내는 학교(세션 기관 또는 자동 승인 때 요청의 from_org). 반환 { ok, ... } | { error, status }
export async function approveTransfer(c, { id, orgId, byUserId = null, auto = false }) {
  const rq = (await c.query(
    `SELECT id, from_org, to_org, user_id, to_membership_id, expires_at <= now() AS expired FROM transfer_request
      WHERE id = $1 AND from_org = $2 AND status = $3 FOR UPDATE`, [id, orgId, TRANSFER_STATUS.WAITING])).rows[0];
  if (!rq) return { error: 'roster.err.transfer_not_found', status: 404 };
  if (rq.expired) return { error: 'roster.err.transfer_expired', status: 409 };
  const ln = (await c.query(
    `SELECT id, user_id, name FROM membership WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL FOR UPDATE`, [rq.to_membership_id, rq.to_org])).rows[0];
  if (!ln || ln.user_id != null) return { error: 'roster.err.transfer_line_gone', status: 409 };
  const from = await homeLines(c, rq.user_id, rq.from_org);
  if (!from.length) return { error: 'roster.err.transfer_not_found', status: 409 }; // 그사이 그 학교를 떠남
  const ids = from.map((x) => Number(x.id));
  const vac = await vacancy(c, rq.from_org, ids);
  // ① 앞 학교 줄 「전출」 → ② 공용 해제(권한 교직원으로·세션 끊기) → ③ 받는 학교 줄에 본 소속으로 연결
  await moveOut(c, { from, orgId: rq.from_org, membershipId: ids[0], byUserId, action: auto ? 'transfer.auto-approve' : 'transfer.approve' });
  for (const f of from) {
    const u = await unlinkAccount(c, { membershipId: f.id, byUserId, reason: DORMANT_REASON.REMOVED });
    if (u.error) return { ...u, status: 409 };
  }
  const l = await linkAccount(c, { membershipId: ln.id, userId: rq.user_id, byUserId, concurrent: false });
  if (l.error) return { ...l, status: 409 };
  await c.query(`UPDATE transfer_request SET status = $2, decided_at = now(), decided_by = $3 WHERE id = $1`, [rq.id, TRANSFER_STATUS.APPROVED, byUserId]);
  const fromName = await orgName(c, rq.from_org);
  const toName = await orgName(c, rq.to_org);
  const 이름 = from[0].name ?? '';
  await notify(c, { orgId: rq.to_org, kind: 'transfer.approved', text: t('roster.transfer_notice.approved', { 학교: fromName, 이름: ln.name ?? '' }) });
  if (auto) await notify(c, { orgId: rq.from_org, kind: 'transfer.auto_approved', text: t('roster.transfer_notice.auto_approved', { 학교: toName, 이름 }) });
  if (vac.homeroom + vac.classes > 0) {
    const 상태 = 값이름('membership.status', MEMBER_STATUS.TRANSFERRED);
    await notify(c, { orgId: rq.from_org, kind: 'roster_vacated', text: t('roster.notice.vacated', { 이름, 상태, 담임: vac.homeroom, 수업: vac.classes }) });
  }
  await notify(c, { userId: rq.user_id, orgId: rq.to_org, kind: 'roster.approve', text: t('roster.approve_notice.in', { 학교: toName }) });
  return { ok: true, requestId: Number(rq.id), userId: Number(rq.user_id), membershipId: Number(ln.id), moved: ids, vacant: vac };
}

// 보내기(거래 안) — 받는 학교(toOrg)의 줄 toMembershipId 에 계정 userId 를 잇고 싶다고 보내는 학교(fromOrg)에 청한다.
// 같은 계정·같은 받는 학교로 기다리는 요청이 있으면 그것을 돌려준다. 보내는 학교가 자동 승인을 켰으면 그 자리에서 승인.
// 반환 { requested, requestId, expiresAt } | { ok, autoApproved, ... } | { error, status }
export async function requestTransfer(c, { fromOrg, toOrg, userId, toMembershipId, byUserId }) {
  const has = (await c.query(
    `SELECT id, expires_at FROM transfer_request WHERE user_id = $1 AND to_org = $2 AND status = $3 AND expires_at > now() ORDER BY id DESC LIMIT 1`,
    [userId, toOrg, TRANSFER_STATUS.WAITING])).rows[0];
  if (has) return { requested: true, requestId: Number(has.id), expiresAt: has.expires_at, again: true };
  const ins = (await c.query(
    `INSERT INTO transfer_request (from_org, to_org, user_id, to_membership_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, expires_at`,
    [fromOrg, toOrg, userId, toMembershipId, byUserId])).rows[0];
  await audit(c, { orgId: toOrg, userId: byUserId, action: 'transfer.request', table: 'transfer_request', rowId: ins.id, after: { userId: Number(userId), membershipId: Number(toMembershipId) } });
  if ((await loadConfig(c, fromOrg)).transferAutoApprove) {
    const a = await approveTransfer(c, { id: ins.id, orgId: fromOrg, auto: true });
    return a.error ? a : { ...a, autoApproved: true };
  }
  return { requested: true, requestId: Number(ins.id), expiresAt: ins.expires_at };
}

// 7일 만료 — 기다리던 요청을 닫고 받는 학교에 「다음 길(초대 코드)」 소식
registerCleanup('transfer-7d', async (db, now) => {
  const due = (await db.query(
    `UPDATE transfer_request SET status = $3, decided_at = $2 WHERE status = $1 AND expires_at <= $2 RETURNING id, from_org, to_org, to_membership_id`,
    [TRANSFER_STATUS.WAITING, now, TRANSFER_STATUS.EXPIRED])).rows;
  for (const d of due) {
    const 학교 = await orgName(db, d.from_org);
    const 이름 = d.to_membership_id ? await lineName(db, d.to_membership_id) : '';
    await notify(db, { orgId: d.to_org, kind: 'transfer.expired', text: t('roster.transfer_notice.expired', { 학교, 이름 }) });
  }
  return due.length;
});

export function transferRouter(pool) {
  const r = express.Router({ mergeParams: true });
  const gate = requireOrgAction('member.transfer');
  const nf = (res) => res.status(404).json({ error: '없습니다' });
  const send = (res, out) => (out.status === 404 ? nf(res) : fail(res, out.status ?? 409, out.error));

  // 목록 — { received:[{ id, toOrg, membershipId, name, birthDate, loginId, vacant:{homeroom,classes}, createdAt, expiresAt, text }],
  //          sent:[{ id, fromOrg, membershipId, name, status, createdAt, expiresAt, decidedAt }], autoApprove }
  r.get('/transfers', gate, async (req, res, next) => {
    try {
      const recv = (await pool.query(
        `SELECT id, to_org, user_id, created_at, expires_at FROM transfer_request
          WHERE from_org = $1 AND status = $2 AND expires_at > now() ORDER BY id`, [req.orgId, TRANSFER_STATUS.WAITING])).rows;
      const received = [];
      for (const x of recv) {
        // 계정 값과 줄 값은 따로 읽는다(name-source)
        const u = (await pool.query(`SELECT login_id, birth_date FROM app_user WHERE id = $1`, [x.user_id])).rows[0];
        const ln = (await pool.query(
          `SELECT id, name FROM membership WHERE user_id = $1 AND org_id = $2 AND deleted_at IS NULL AND NOT is_concurrent ORDER BY id LIMIT 1`,
          [x.user_id, req.orgId])).rows[0];
        const vacant = await vacancy(pool, req.orgId, ln ? [Number(ln.id)] : []);
        const 학교 = await orgName(pool, x.to_org);
        const birthDate = birthText(u?.birth_date) || null;
        const 건수 = vacant.homeroom + vacant.classes;
        const vars = { 학교, 이름: ln?.name ?? '', 생년월일: birthDate ?? t('roster.approve.birth_unknown'), 아이디: u?.login_id ?? '', 건수 };
        received.push({
          id: Number(x.id), toOrg: 학교, membershipId: ln ? Number(ln.id) : null, name: ln?.name ?? null, birthDate, loginId: u?.login_id ?? null,
          vacant, createdAt: x.created_at, expiresAt: x.expires_at, text: t(건수 ? 'roster.transfer.request' : 'roster.transfer.request_none', vars),
        });
      }
      const sentRows = (await pool.query(
        `SELECT id, from_org, to_membership_id, CASE WHEN status = $2 AND expires_at <= now() THEN $3 ELSE status END AS status,
                created_at, expires_at, decided_at
           FROM transfer_request WHERE to_org = $1 ORDER BY id DESC LIMIT 100`, [req.orgId, TRANSFER_STATUS.WAITING, TRANSFER_STATUS.EXPIRED])).rows;
      const sent = [];
      for (const x of sentRows) {
        sent.push({
          id: Number(x.id), fromOrg: await orgName(pool, x.from_org), membershipId: x.to_membership_id ? Number(x.to_membership_id) : null,
          name: x.to_membership_id ? await lineName(pool, x.to_membership_id) : null, status: x.status,
          createdAt: x.created_at, expiresAt: x.expires_at, decidedAt: x.decided_at,
        });
      }
      res.json({ received, sent, autoApprove: (await loadConfig(pool, req.orgId)).transferAutoApprove === true });
    } catch (e) {
      next(e);
    }
  });

  // 전출 승인 — 보내는 학교 기관 관리자 → { ok, requestId, userId, membershipId, moved:[앞 줄 id], vacant }
  r.post('/transfers/:id/approve', gate, async (req, res, next) => {
    try {
      const p = idParam.safeParse(req.params.id);
      if (!p.success) return nf(res);
      const out = await withTx(pool, (c) => approveTransfer(c, { id: p.data, orgId: req.orgId, byUserId: req.session.userId }));
      if (out.error) return send(res, out);
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  // 거절 — 줄은 그대로 · 요청한 학교에 소식 → { ok, requestId }
  r.post('/transfers/:id/reject', gate, async (req, res, next) => {
    try {
      const p = idParam.safeParse(req.params.id);
      if (!p.success) return nf(res);
      const out = await withTx(pool, async (c) => {
        const rq = (await c.query(
          `SELECT id, to_org, to_membership_id, expires_at <= now() AS expired FROM transfer_request
            WHERE id = $1 AND from_org = $2 AND status = $3 FOR UPDATE`, [p.data, req.orgId, TRANSFER_STATUS.WAITING])).rows[0];
        if (!rq) return { error: 'roster.err.transfer_not_found', status: 404 };
        if (rq.expired) return { error: 'roster.err.transfer_expired', status: 409 };
        await c.query(`UPDATE transfer_request SET status = $2, decided_at = now(), decided_by = $3 WHERE id = $1`, [rq.id, TRANSFER_STATUS.REJECTED, req.session.userId]);
        await audit(c, { orgId: req.orgId, userId: req.session.userId, action: 'transfer.reject', table: 'transfer_request', rowId: rq.id });
        const 학교 = await orgName(c, req.orgId);
        const 이름 = rq.to_membership_id ? await lineName(c, rq.to_membership_id) : '';
        await notify(c, { orgId: rq.to_org, kind: 'transfer.rejected', text: t('roster.transfer_notice.rejected', { 학교, 이름 }) });
        return { ok: true, requestId: Number(rq.id) };
      });
      if (out.error) return send(res, out);
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  // 전출 요청 자동 승인 설정 — { on } → { autoApprove }
  r.put('/transfers/auto-approve', gate, async (req, res, next) => {
    try {
      const p = z.object({ on: z.boolean() }).safeParse(req.body);
      if (!p.success) return fail(res, 400, 'roster.err.bad_input');
      await pool.query(`UPDATE org SET config = COALESCE(config, '{}'::jsonb) || jsonb_build_object('transferAutoApprove', $2::boolean) WHERE id = $1`, [req.orgId, p.data.on]);
      await audit(pool, { orgId: req.orgId, userId: req.session.userId, action: 'transfer.auto-setting', table: 'org', rowId: req.orgId, after: { on: p.data.on } });
      res.json({ autoApprove: p.data.on });
    } catch (e) {
      next(e);
    }
  });

  return r;
}
