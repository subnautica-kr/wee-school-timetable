// 총괄관리자 화면(T-1326) — 소속 없는 계정 · 기관 관리자 없는 학교 · 의심스러운 가입 수 · 캡차 스위치 · 계정 잠금 · 연락처.
// 길목은 routes/admin.js 가 잇는다(총괄관리자 전용 — 기관 관리자는 404). 학교 안 자료는 하나도 안 본다.
import { z } from 'zod';
import { ROLE, USER_STATUS, MEMBER_STATUS_LOGIN } from '../shared/codes.js';
import { fail } from './fail.js';
import { audit, killSessions } from './audit.js';
import { inTx } from './cascade.js';
import { PENDING_DAYS } from './routes/signup.js';
import { SETTING, getSetting, setSetting, captchaOn } from './appSetting.js';

const SUSPECT_TRIES = 5; // 하루 안에 한 곳(IP 해시)에서 이만큼 시도하면 의심
const LIST_MAX = 500;
const uidParam = z.coerce.number().int().positive();
const captchaBody = z.object({ on: z.boolean() });
const contactBody = z.object({ contact: z.string().trim().max(100) });

export function adminAccounts(pool) {
  const who = (req) => ({ userId: req.session.userId, orgId: req.session.orgId });
  const bad = (res) => fail(res, 400, 'admin.err.bad_input');
  const nf = (res) => fail(res, 404, 'admin.err.not_found');
  const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };

  return {
    unlinked: wrap(async (req, res) => {
      const { rows } = await pool.query(
        `SELECT u.id AS "userId", u.name, u.login_id AS "loginId", u.status, u.signed_up_at AS "signedUpAt",
                CASE WHEN u.first_linked_at IS NULL AND u.signed_up_at IS NOT NULL THEN u.signed_up_at + make_interval(days => $1) END AS "cleanupAt"
           FROM app_user u
          WHERE u.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM membership m WHERE m.user_id = u.id AND m.deleted_at IS NULL)
          ORDER BY u.signed_up_at DESC NULLS LAST, u.id DESC LIMIT $2`,
        [PENDING_DAYS, LIST_MAX],
      );
      res.json(rows);
    }),

    noAdminSchools: wrap(async (req, res) => {
      const { rows } = await pool.query(
        `SELECT o.id, o.name, o.status,
                (SELECT count(*) FROM membership m WHERE m.org_id = o.id AND m.deleted_at IS NULL)::int AS users
           FROM org o
          WHERE o.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM membership s WHERE s.org_id = o.id AND s.role = $1 AND s.deleted_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM membership m WHERE m.org_id = o.id AND m.role = $2 AND m.user_id IS NOT NULL AND m.status = ANY($3::text[]) AND m.deleted_at IS NULL)
          ORDER BY o.name`,
        [ROLE.SYSADMIN, ROLE.ORG_ADMIN, MEMBER_STATUS_LOGIN],
      );
      res.json(rows);
    }),

    // 최근 하루 가입 시도 — 한 곳에서 SUSPECT_TRIES 번 넘게 두드린 것을 의심으로 센다. 캡차 스위치 상태도 같이.
    watch: wrap(async (req, res) => {
      const s = (await pool.query(
        `WITH a AS (SELECT ip_hash, count(*)::int AS n FROM signup_attempt WHERE at > now() - interval '1 day' GROUP BY ip_hash)
         SELECT COALESCE(sum(n), 0)::int AS attempts,
                COALESCE(sum(n) FILTER (WHERE n >= $1), 0)::int AS suspicious,
                (count(*) FILTER (WHERE n >= $1))::int AS sources FROM a`,
        [SUSPECT_TRIES],
      )).rows[0];
      res.json({ ...s, minTries: SUSPECT_TRIES, captcha: await captchaOn(pool) });
    }),

    setCaptcha: wrap(async (req, res) => {
      const p = captchaBody.safeParse(req.body);
      if (!p.success) return bad(res);
      const before = await captchaOn(pool);
      await setSetting(pool, SETTING.CAPTCHA, p.data.on);
      await audit(pool, { ...who(req), action: 'admin.captcha', table: 'app_setting', before: { on: before }, after: { on: p.data.on } });
      res.json({ ok: true, captcha: p.data.on });
    }),

    lock: (lock) => wrap(async (req, res) => {
      const uid = uidParam.safeParse(req.params.uid);
      if (!uid.success) return nf(res);
      const out = await inTx(pool, async (c) => {
        const u = (await c.query(`SELECT id, status FROM app_user WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [uid.data])).rows[0];
        if (!u) return { gone: true };
        if (lock) {
          if (Number(u.id) === Number(req.session.userId)) return { code: 'admin.err.lock_self' };
          const sys = (await c.query(`SELECT 1 FROM membership WHERE user_id = $1 AND role = $2 AND deleted_at IS NULL LIMIT 1`, [u.id, ROLE.SYSADMIN])).rows[0];
          const other = (await c.query(
            `SELECT 1 FROM membership m JOIN app_user a ON a.id = m.user_id AND a.deleted_at IS NULL AND a.status = $2
              WHERE m.user_id <> $1 AND m.role = $3 AND m.status = ANY($4::text[]) AND m.deleted_at IS NULL LIMIT 1`,
            [u.id, USER_STATUS.USE, ROLE.SYSADMIN, MEMBER_STATUS_LOGIN],
          )).rows[0];
          if (sys && !other) return { code: 'admin.err.lock_last_sys' };
          await c.query(`UPDATE app_user SET status = $2 WHERE id = $1`, [u.id, USER_STATUS.LOCKED]);
          await killSessions(c, u.id);
        } else {
          await c.query(`UPDATE app_user SET status = $2, failed_count = 0, locked_until = NULL WHERE id = $1`, [u.id, USER_STATUS.USE]);
        }
        await audit(c, { ...who(req), action: lock ? 'admin.lock-user' : 'admin.unlock-user', table: 'app_user', rowId: u.id, before: { status: u.status }, after: { status: lock ? USER_STATUS.LOCKED : USER_STATUS.USE } });
        return { ok: true };
      });
      if (out.gone) return nf(res);
      if (out.code) return fail(res, 409, out.code);
      res.json({ ok: true });
    }),

    getContact: wrap(async (req, res) => {
      const v = await getSetting(pool, SETTING.CONTACT_SUPER);
      res.json({ contact: typeof v === 'string' ? v : '' });
    }),

    setContact: wrap(async (req, res) => {
      const p = contactBody.safeParse(req.body);
      if (!p.success) return bad(res);
      const before = await getSetting(pool, SETTING.CONTACT_SUPER);
      await setSetting(pool, SETTING.CONTACT_SUPER, p.data.contact || null);
      await audit(pool, { ...who(req), action: 'admin.contact', table: 'app_setting', before: { contact: before }, after: { contact: p.data.contact } });
      res.json({ ok: true, contact: p.data.contact });
    }),
  };
}
