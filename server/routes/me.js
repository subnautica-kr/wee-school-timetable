import express from 'express';
import { requireLogin } from '../guard.js';
import { fail } from '../fail.js';
import { t } from '../../shared/text/index.js';
import { ROLE, MEMBER_STATUS, DORMANT_REASON } from '../../shared/codes.js';
import { unlinkAccount, withTx } from '../link.js';
import { audit } from '../audit.js';
import { notify } from '../notify.js';
import { isLastAdmin, forced } from '../lastAdmin.js';

// 「내 정보」(T-1322a) — 로그인한 사람 본인의 일. 기관 경로가 아니다.
// POST /leave → { ok, orgId, dormant } — 지금 세션의 학교에서 스스로 나간다(명단 줄·시간표는 남고 계정 칸만 빈다).
//   마지막 기관 관리자면 409 needConfirm(force 로 다시 하면 나간다) · 나가면 그 학교 기관 관리자에게 소식 한 줄 · 세션 끝(다시 로그인).
export function meRouter(pool) {
  const r = express.Router();
  r.use(requireLogin);

  r.post('/leave', async (req, res, next) => {
    try {
      const orgId = req.session.orgId;
      const uid = req.session.userId;
      if (orgId == null) return fail(res, 409, 'roster.err.leave_no_org');
      const out = await withTx(pool, async (c) => {
        const ln = (await c.query(
          `SELECT id, role, name FROM membership WHERE org_id = $1 AND user_id = $2 AND deleted_at IS NULL AND role <> $3 FOR UPDATE`,
          [orgId, uid, ROLE.SYSADMIN])).rows[0];
        if (!ln) return { error: 'roster.err.leave_no_org' };
        if (ln.role === ROLE.ORG_ADMIN && !forced(req) && (await isLastAdmin(c, orgId, { mid: ln.id }))) {
          return { error: 'roster.err.last_admin_warn', extra: { needConfirm: true, lastAdmin: true, warnings: [{ text: t('roster.err.last_admin_warn') }] } };
        }
        const u = await unlinkAccount(c, { membershipId: ln.id, byUserId: uid, reason: DORMANT_REASON.LEFT });
        if (u.error) return u;
        await notify(c, { orgId, kind: 'me.leave', text: t('roster.leave_notice.left', { 이름: ln.name ?? '' }) });
        await audit(c, { orgId, userId: uid, action: 'me.leave', table: 'membership', rowId: ln.id, after: { dormant: u.dormant } });
        return { ok: true, orgId: Number(orgId), dormant: u.dormant };
      });
      if (out.error) return fail(res, 409, out.error, undefined, out.extra);
      req.session.destroy((e) => (e ? next(e) : res.clearCookie('sid').json(out)));
    } catch (e) {
      next(e);
    }
  });

  return r;
}
