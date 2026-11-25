// 가입 서버(T-1321①b) — 가입(숨은 칸·IP 제한·캡차 스위치 자리) · 코드 확인 · 코드 입력(대조·본인 재확인) · 승인 대기 정보
// · 7일 정리 · 평균 승인 시간. 설계 「가입 화면」 절. 실패는 { error: '<영역>.err.<키>' } 로 돌려주고 길목이 fail() 로 낸다.
import crypto from 'node:crypto';
import { captchaOn as captchaState, publicContacts } from '../appSetting.js';
import express from 'express';
import argon2 from 'argon2';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { secret } from '../db.js';
import { fail } from '../fail.js';
import { t } from '../../shared/text/index.js';
import { requireLogin } from '../guard.js';
import { passwordProblem } from '../passwords.js';
import { audit } from '../audit.js';
import { ARGON, ID_RE } from '../accounts.js';
import { matchPerson } from '../match.js';
import { notify } from '../notify.js';
import { registerCleanup } from '../cleanup.js';
import { linkAccount, withTx } from '../link.js';
import { startSession, sessionBody, noOrgKind } from './auth.js';
import { MEMBER_STATUS, MEMBER_STATUS_LOGIN, ORG_STATUS, ROLE } from '../../shared/codes.js';

export const PENDING_DAYS = 7;
const AVG_WINDOW_DAYS = 90;
const AVG_MIN_CASES = 5;

const birthText = (d) => (d ? new Date(d).toLocaleDateString('sv-SE').replaceAll('-', '') : '');
const birthSchema = z.string().regex(/^\d{8}$/).refine((v) => {
  const [y, m, d] = [Number(v.slice(0, 4)), Number(v.slice(4, 6)), Number(v.slice(6, 8))];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return y >= 1900 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && dt.getTime() <= Date.now();
});
const toDate = (v) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;

const signupBody = z.object({
  name: z.string().trim().min(1).max(50),
  birthDate: birthSchema,
  loginId: z.string().min(1).max(100).regex(ID_RE),
  password: z.string().min(1).max(200),
  code: z.string().trim().max(100).optional(),
  website: z.string().max(500).optional(), // 숨은 칸 — 사람은 안 보니 비어 있다
  captcha: z.string().max(2000).optional(),
});
const codeBody = z.object({
  code: z.string().trim().min(1).max(100),
  confirm: z.enum(['ok', 'fix']).optional(), // 본인 재확인 — 맞아요 · 고칠게요
  name: z.string().trim().min(1).max(50).optional(),
  birthDate: birthSchema.optional(),
  moveOk: z.boolean().optional(), // 「○○에서 △△로 옮겨요」 확인창 뒤
});

// 살아 있는 초대 코드와 그 명단 줄(없거나 기간 지났거나 쓰였으면 null)
const CODE_SELECT = `SELECT c.id, c.kind, c.org_id, c.membership_id, o.name AS org_name, m.name AS line_name, m.birth_date AS line_birth, m.user_id AS line_user, m.role AS line_role
       FROM invite_code c
       JOIN membership m ON m.id = c.membership_id AND m.deleted_at IS NULL
       JOIN org o ON o.id = c.org_id AND o.deleted_at IS NULL AND o.status = $2
      WHERE upper(c.code) = upper($1) AND c.used_at IS NULL AND c.revoked_at IS NULL AND c.expires_at > now()`;
const CODE_SELECT_LOCK = CODE_SELECT + ' FOR UPDATE OF c';
async function findLiveCode(db, code, lock = false) {
  const row = (await db.query(lock ? CODE_SELECT_LOCK : CODE_SELECT, [code, ORG_STATUS.USE])).rows[0];
  return row && row.line_user == null ? row : null;
}

// 코드를 계정에 적용한다(가입 직후·로그인 상태 코드 입력 공용).
//   명단과 대조해 둘 다 맞으면 바로 연결, 하나라도 다르면 본인 재확인 → 「맞아요」·고쳐도 다르면 승인 대기
//   전입 코드인데 지금 다른 학교 재직이면 확인 한 번(moveOk) 뒤 앞 학교 줄을 「전출」로(승인 대기면 승인되는 순간 몫 — 대기 중엔 안 건드림)
// 반환 { error } | { recheck:{name,birthDate} } | { move:{from,to} } | { linked:{orgId,role,moved} } | { pending:{orgId} }
export async function applyCode(pool, userId, { code, confirm, name, birthDate, moveOk = false }) {
  return withTx(pool, async (c) => {
    const cd = await findLiveCode(c, code, true);
    if (!cd) return { error: 'signup.err.code_invalid' };
    const from = cd.kind === 'move_in'
      ? (await c.query(
        `SELECT m.id, o.name AS org_name FROM membership m JOIN org o ON o.id = m.org_id
          WHERE m.user_id = $1 AND m.org_id <> $2 AND m.deleted_at IS NULL AND NOT m.is_concurrent
            AND m.status = ANY($3::text[]) AND m.role <> $4`,
        [userId, cd.org_id, MEMBER_STATUS_LOGIN, ROLE.SYSADMIN],
      )).rows
      : [];
    if (from.length && !moveOk) return { move: { from: from[0].org_name, to: cd.org_name } };

    if (confirm === 'fix' && name && birthDate) {
      await c.query(`UPDATE app_user SET name = $2, birth_date = $3 WHERE id = $1`, [userId, name, toDate(birthDate)]);
      await audit(c, { userId, action: 'signup.fix', table: 'app_user', rowId: userId });
    }
    const { check } = await matchPerson(c, { name: cd.line_name, birthDate: cd.line_birth, userId });
    // 명단에 생년월일이 없으면 이름만 본다
    const same = !!check && check.name && (!cd.line_birth || check.birth === true);
    if (!same && !confirm) {
      const u = (await c.query(`SELECT name, birth_date FROM app_user WHERE id = $1`, [userId])).rows[0];
      return { recheck: { name: u.name, birthDate: birthText(u.birth_date) } }; // 명단 값은 안 보인다
    }
    await c.query(`UPDATE invite_code SET used_at = now(), used_by = $2 WHERE id = $1`, [cd.id, userId]);
    if (!same) {
      await c.query(`UPDATE unlinked_account SET resolved_at = now() WHERE user_id = $1 AND org_id = $2 AND reason = 'pending_approval' AND resolved_at IS NULL`, [userId, cd.org_id]);
      await c.query(
        `INSERT INTO unlinked_account (org_id, user_id, reason, membership_id, expires_at) VALUES ($1,$2,'pending_approval',$3, now() + make_interval(days => $4))`,
        [cd.org_id, userId, cd.membership_id, PENDING_DAYS],
      );
      const who = (await c.query(`SELECT name FROM app_user WHERE id = $1`, [userId])).rows[0];
      await notify(c, { orgId: cd.org_id, kind: 'signup.pending', text: t('signup.notice.pending', { 이름: who.name }) });
      await audit(c, { orgId: cd.org_id, userId, action: 'signup.pending', table: 'membership', rowId: cd.membership_id });
      return { pending: { orgId: Number(cd.org_id) } };
    }
    if (from.length) {
      await c.query(`UPDATE membership SET status = $2 WHERE id = ANY($1::bigint[])`, [from.map((x) => x.id), MEMBER_STATUS.TRANSFERRED]);
      await audit(c, { orgId: cd.org_id, userId, action: 'signup.move', table: 'membership', rowId: cd.membership_id, after: { from: from.map((x) => Number(x.id)) } });
    }
    const r = await linkAccount(c, { membershipId: cd.membership_id, userId, byUserId: userId });
    if (r.error) return r;
    return { linked: { orgId: Number(cd.org_id), role: cd.line_role, moved: from.length > 0 } };
  });
}

// 이 학교의 평균 승인 시간(일) — 최근 90일에 승인으로 닫힌 건이 5건 이상일 때만, 가운데 값을 올림. 아니면 null.
// 승인 = 닫힌 승인 대기 줄이 가리킨 명단 줄에 그 계정이 실제로 연결됨. 만료 정리는 만료 시각에 닫으므로(resolved_at = expires_at) 걸러진다.
export async function avgApprovalDays(db, orgId, now = new Date()) {
  const { rows } = await db.query(
    `SELECT extract(epoch FROM (u.resolved_at - u.created_at)) / 86400 AS d
       FROM unlinked_account u JOIN membership m ON m.id = u.membership_id AND m.user_id = u.user_id
      WHERE u.org_id = $1 AND u.reason = 'pending_approval' AND u.resolved_at IS NOT NULL AND u.resolved_at < u.expires_at
        AND u.resolved_at >= $2::timestamptz - make_interval(days => $3)
      ORDER BY d`,
    [orgId, now, AVG_WINDOW_DAYS],
  );
  if (rows.length < AVG_MIN_CASES) return null;
  const d = rows.map((x) => Number(x.d));
  const mid = d.length % 2 ? d[(d.length - 1) / 2] : (d[d.length / 2 - 1] + d[d.length / 2]) / 2;
  return Math.max(1, Math.ceil(mid));
}

// 7일 정리 — 한 번도 학교에 연결된 적 없는 가입 계정만 표시 삭제(아이디는 다시 쓸 수 있게 비킨다)
// · 만료된 승인 요청은 요청만 닫는다 · 오래된 가입 시도 기록
registerCleanup('signup.unapproved', async (db, now) => {
  let n = (await db.query(
    `UPDATE unlinked_account SET resolved_at = expires_at WHERE reason = 'pending_approval' AND resolved_at IS NULL AND expires_at < $1`, [now],
  )).rowCount;
  const gone = (await db.query(
    `UPDATE app_user u SET deleted_at = $1, login_id = left(login_id, 80) || '~del' || id
      WHERE deleted_at IS NULL AND first_linked_at IS NULL AND signed_up_at IS NOT NULL
        AND signed_up_at < $1::timestamptz - make_interval(days => $2)
        AND NOT EXISTS (SELECT 1 FROM membership m WHERE m.user_id = u.id AND m.deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM unlinked_account x WHERE x.user_id = u.id AND x.resolved_at IS NULL AND x.expires_at > $1)
      RETURNING id`,
    [now, PENDING_DAYS],
  )).rows;
  for (const g of gone) await db.query(`DELETE FROM session WHERE (sess->>'userId') = $1`, [String(g.id)]);
  n += gone.length;
  n += (await db.query(`DELETE FROM signup_attempt WHERE at < $1::timestamptz - interval '2 days'`, [now])).rowCount;
  return n;
});

export function signupRouter(pool, opts = {}) {
  const r = express.Router();
  const dailyLimit = opts.signupDailyLimit ?? (Number(process.env.SIGNUP_DAILY_LIMIT) || 30);
  const captchaOn = () => captchaState(pool, opts.signupCaptcha); // 총괄관리자 스위치(app_setting) > 환경변수 · 끔이 기본
  const ipHash = (req) => crypto.createHmac('sha256', secret('SESSION_SECRET') || 'test-secret').update(String(req.ip)).digest('hex');
  const codeLimit = rateLimit({ windowMs: 15 * 60_000, limit: opts.signupCodeLimit ?? 60, standardHeaders: true, legacyHeaders: false });

  // 가입 화면이 켜진 스위치를 알아야 한다
  r.get('/config', async (req, res, next) => {
    try { res.json({ captcha: await captchaOn() }); } catch (e) { next(e); }
  });

  // 가입 화면이 보여 줄 연락처(로그인 전에도 읽힌다) — 값만
  r.get('/contacts', async (req, res, next) => {
    try { res.json(await publicContacts(pool)); } catch (e) { next(e); }
  });

  // 코드 확인(로그인 전) — 학교 이름과 갈래만. 명단 줄의 이름·생년월일은 안 준다
  r.get('/code/:code', codeLimit, async (req, res, next) => {
    try {
      const cd = await findLiveCode(pool, String(req.params.code).trim().slice(0, 100));
      if (!cd) return fail(res, 404, 'signup.err.code_invalid');
      res.json({ ok: true, kind: cd.kind, orgName: cd.org_name });
    } catch (e) { next(e); }
  });

  // 코드 적용 결과를 세션·응답에 반영한다
  async function finishCode(req, res, userId, args) {
    const remember = !!req.session.cookie.maxAge;
    const out = await applyCode(pool, userId, args);
    if (out.error) return fail(res, 409, out.error);
    if (out.recheck) return res.json({ ...sessionBody(req), result: 'recheck', recheck: out.recheck });
    if (out.move) return res.json({ ...sessionBody(req), result: 'move', move: out.move });
    if (out.pending) {
      if (req.session.noOrg) {
        req.session.noOrg = 'pending_approval'; // 로그인 때 한 번만 계산되는 값이라 여기서 갱신
        await new Promise((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())));
      }
      return res.json({ ...sessionBody(req), result: 'pending' });
    }
    // 연결됨 — 학교 없는 세션이거나 학교를 옮겼으면 새 학교 소속으로 세션을 다시 연다. 겸임이면 지금 학교를 그대로 둔다.
    if (req.session.noOrg || out.linked.moved) {
      await startSession(req, { id: userId, name: req.session.name, mustChange: !!req.session.mustChange, remember }, out.linked.orgId, out.linked.role);
    }
    return res.json({ ...sessionBody(req), result: 'linked', linked: out.linked });
  }

  // 가입 — 칸 넷(+선택 코드). 서버에서만 판단한다
  r.post('/', async (req, res, next) => {
    try {
      const p = signupBody.safeParse(req.body);
      if (!p.success) return fail(res, 400, 'signup.err.bad_input');
      const b = p.data;
      const hash = ipHash(req);
      if (b.website) { // 숨은 칸이 찼으면 봇 — 만들지 않고 성공인 척
        await pool.query(`INSERT INTO signup_attempt (ip_hash) VALUES ($1)`, [hash]);
        return res.json({ ok: true });
      }
      const tries = (await pool.query(`SELECT count(*)::int AS n FROM signup_attempt WHERE ip_hash = $1 AND at > now() - interval '1 day'`, [hash])).rows[0].n;
      if (tries >= dailyLimit) return fail(res, 429, 'signup.err.too_many');
      await pool.query(`INSERT INTO signup_attempt (ip_hash) VALUES ($1)`, [hash]);
      if ((await captchaOn()) && !b.captcha) return fail(res, 400, 'signup.err.captcha');
      const problem = passwordProblem(b.password, b.loginId);
      if (problem) return res.status(400).json({ error: problem });
      if (b.code && !(await findLiveCode(pool, b.code))) return fail(res, 409, 'signup.err.code_invalid');

      const ins = await pool.query(
        `INSERT INTO app_user (name, login_id, password_hash, must_change_password, birth_date, signed_up_at)
         VALUES ($1,$2,$3,FALSE,$4, now()) ON CONFLICT (lower(login_id)) DO NOTHING RETURNING id`,
        [b.name, b.loginId, await argon2.hash(b.password, ARGON), toDate(b.birthDate)],
      );
      if (!ins.rows[0]) return fail(res, 409, 'signup.err.id_taken'); // 같은 이름 계정 얘기는 안 한다
      const id = Number(ins.rows[0].id);
      await audit(pool, { userId: id, action: 'signup.create', table: 'app_user', rowId: id });
      await startSession(req, { id, name: b.name, mustChange: false, remember: false }, null, null, { noOrg: 'none' });
      if (!b.code) return res.json(sessionBody(req));
      return await finishCode(req, res, id, { code: b.code });
    } catch (e) { next(e); }
  });

  // 로그인 상태에서 코드 입력(내 정보 · 승인 대기 화면) — 본인 재확인·이동 확인도 같은 길로 다시 부른다
  r.post('/code', codeLimit, requireLogin, async (req, res, next) => {
    try {
      const p = codeBody.safeParse(req.body);
      if (!p.success) return fail(res, 400, 'signup.err.bad_input');
      await finishCode(req, res, Number(req.session.userId), p.data);
    } catch (e) { next(e); }
  });

  // 승인 대기 화면 재료 — 코드로 온 사람은 학교 이름·평균 승인 시간(표본 있을 때만)·7일 문구 갈래
  r.get('/pending', requireLogin, async (req, res, next) => {
    try {
      const uid = Number(req.session.userId);
      const u = (await pool.query(`SELECT first_linked_at, dormant_at FROM app_user WHERE id = $1`, [uid])).rows[0];
      const row = (await pool.query(
        `SELECT x.org_id, x.expires_at, o.name AS org_name FROM unlinked_account x JOIN org o ON o.id = x.org_id
          WHERE x.user_id = $1 AND x.reason = 'pending_approval' AND x.resolved_at IS NULL AND x.expires_at > now() ORDER BY x.id DESC LIMIT 1`,
        [uid],
      )).rows[0];
      const noOrg = req.session.noOrg ?? (await noOrgKind(pool, { id: uid, dormant_at: u?.dormant_at }));
      res.json({
        noOrg,
        pending: row ? { orgName: row.org_name, expiresAt: row.expires_at, avgDays: await avgApprovalDays(pool, row.org_id) } : null,
        contacts: await publicContacts(pool), // 승인 대기 화면의 연락처 줄
        everLinked: !!u?.first_linked_at, // 7일 문구: false 면 「다시 가입」 · true 면 「코드를 다시 받아야」
      });
    } catch (e) { next(e); }
  });

  return r;
}
