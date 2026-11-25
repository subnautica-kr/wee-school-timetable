import express from 'express';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { requireOrgAction } from '../guard.js';
import { createAccount, createLine, createUserOnly, releaseUnlinked, resetPassword, moveInFrom, moveOut, ID_RE } from '../accounts.js';
import { issueInvite } from '../invite.js';
import { takeContactNudge } from '../orgContact.js';
import { getRuleLevels } from '../rules.js';
import { currentTerm } from './school.js';
import { audit, killSessions } from '../audit.js';
import { inTx, removeWithCascade } from '../cascade.js';
import { EXCEL_SPECS, rosterSpec, applyPlans, makeWorkbook, markErrors, planSheet, readWorkbook, undoExcel } from '../export/import.js';
import { fail } from '../fail.js';
import { t, 값이름 } from '../../shared/text/index.js';
import { MEMBER_STATUS, MEMBER_STATUS_LOGIN, ROLE, DORMANT_REASON, TRANSFER_STATUS, UNLINKED_REASON, INVITE_KIND } from '../../shared/codes.js';
import { linkAccount, unlinkAccount, withTx, hasPrimaryLine } from '../link.js';
import { homeOrgOf, requestTransfer } from './transfer.js';
import { notify } from '../notify.js';
import { resolveUntil, notifyConcurrent } from '../concurrent.js';
import { isLastAdmin, forced } from '../lastAdmin.js';
import { sameName, sameBirth, matchPerson } from '../match.js';
import { CEIL, dutyFromText, dutyKnown, dutyWarnings, limitWarnings, loadConfig, withWarnings } from '../orgConfig.js';

// 명단 탭 — 줄 = 계정. 관리자만(school.manage). 모든 쿼리에 membership.org_id = req.orgId.
// 시스템관리자 줄은 명단에 안 나오고 못 건드린다.
const idParam = z.coerce.number().int().positive();
const ROLES = ['기관관리자', '교직원', '보기만'];
const dutyIn = z.string().trim().min(1).max(20); // 목록 밖이면 거부 대신 경고(기관 설정 duties)
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const isDate = (s) => { const m = DATE_RE.exec(s); const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return !!d && d.getUTCDate() === +m[3] && d.getUTCMonth() === +m[2] - 1; };
const birthIn = z.string().trim().refine(isDate).nullable().optional();
const STATUSES = Object.values(MEMBER_STATUS); // 재직(사용)·휴직·전출·퇴직(숨김) — 저장 값
const STATUS_ORDER = [MEMBER_STATUS.ACTIVE, MEMBER_STATUS.LEAVE, MEMBER_STATUS.TRANSFERRED, MEMBER_STATUS.RETIRED];
// 줄 넣기 — loginId 가 없으면 계정 없는 줄(새 길) · 있으면 「계정 만들어 주기」(옛 길: 계정 + 임시 비밀번호)
const personBody = z.object({
  name: z.string().trim().min(1).max(50),
  loginId: z.string().trim().regex(ID_RE).optional(),
  birthDate: birthIn,
  role: z.enum(ROLES).default('교직원'),
  duty: dutyIn.nullable().optional(),
});
const patchBody = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  loginId: z.string().trim().regex(ID_RE).optional(),
  role: z.enum(ROLES).optional(),
  duty: dutyIn.nullable().optional(),
  hidden: z.boolean().optional(), // 옛 요청 — true = 퇴직, false = 재직
  status: z.enum(STATUSES).optional(), // 재직 상태 저장 값(MEMBER_STATUS)
  birthDate: birthIn,
});
const bulkStatusBody = z.object({ ids: z.array(idParam).min(1).max(CEIL.rosterRows), status: z.enum(STATUSES) });

const MAX_ROWS = CEIL.rosterRows; // 안전 천장. 기관 limits.rosterRows 를 넘으면 경고
const MAX_COLS = 20;

export function rosterRouter(pool) {
  const r = express.Router({ mergeParams: true });
  r.use(requireOrgAction('school.manage'));
  const nf = (res) => res.status(404).json({ error: '없습니다' });
  const me = (req) => ({ orgId: req.orgId, userId: req.session.userId });

  // 이 기관의 줄 하나(시스템관리자 줄 제외)
  const target = async (req, db = pool) =>
    (
      await db.query(
        `SELECT m.id, m.org_id, m.user_id, m.role, m.status AS m_status, u.login_id, m.name
           FROM membership m LEFT JOIN app_user u ON u.id = m.user_id AND u.deleted_at IS NULL
          WHERE m.id = $1 AND m.org_id = $2 AND m.deleted_at IS NULL AND m.role <> '시스템관리자' AND (m.user_id IS NULL OR u.id IS NOT NULL)`,
        [req.params.mid, req.orgId],
      )
    ).rows[0];

  // 겸임(다른 기관에도 소속) 계정은 계정 전체에 닿는 일(비번·잠금·ID·이름)을 이 기관 관리자가 못 한다.
  // 막지 않으면 A 관리자가 비번을 초기화해 그 사람의 B 기관 권한(예: B 관리자)으로 로그인할 수 있다.
  const SHARED = '다른 기관에도 소속된 계정입니다. 비밀번호·잠금·ID·이름은 시스템 관리자에게 부탁해 주세요';
  const sharedElsewhere = async (t) =>
    !!(await pool.query(`SELECT 1 FROM membership WHERE user_id = $1 AND org_id <> $2 AND deleted_at IS NULL LIMIT 1`, [t.user_id, t.org_id ?? 0])).rows[0];

  // 마지막 기관 관리자 경고(409 needConfirm · 되물은 뒤 force 로 진행) — 문구는 roster.err.last_admin_warn
  const lastWarn = () => ({ needConfirm: true, lastAdmin: true, warnings: [{ text: t('roster.err.last_admin_warn') }] });

  r.get('/', async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT m.id, m.name, u.login_id AS "loginId", m.role, m.duty, m.status AS "listStatus",
                to_char(m.birth_date, 'YYYY-MM-DD') AS "birthDate", (m.user_id IS NOT NULL) AS "hasAccount",
                CASE WHEN m.user_id IS NULL THEN $2::text
                     WHEN u.status = '잠김' OR (u.locked_until IS NOT NULL AND u.locked_until > now()) THEN '잠김'
                     WHEN u.last_login_at IS NULL THEN '첫 로그인 전' ELSE '사용 중' END AS "state",
                COALESCE(u.status = '잠김', FALSE) AS "manualLock", u.last_login_at AS "lastLogin",
                (m.user_id IS NOT NULL AND m.is_concurrent) AS "isConcurrent", to_char(m.concurrent_until, 'YYYY-MM-DD') AS "concurrentUntil"
           FROM membership m LEFT JOIN app_user u ON u.id = m.user_id AND u.deleted_at IS NULL
          WHERE m.org_id = $1 AND m.deleted_at IS NULL AND m.role <> '시스템관리자' AND (m.user_id IS NULL OR u.id IS NOT NULL)
          ORDER BY array_position($3::text[], m.status), m.name, m.id`,
        [req.orgId, t('roster.state.none'), STATUS_ORDER],
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  r.post('/', async (req, res, next) => {
    try {
      const p = personBody.safeParse(req.body);
      if (!p.success) return res.status(400).json({ error: '입력을 확인해 주세요(ID 에는 공백·따옴표·슬래시를 쓸 수 없습니다)' });
      const d = p.data;
      const warn = async () => dutyWarnings(await loadConfig(pool, req.orgId), d.duty);
      if (!d.loginId) {
        const l = await createLine(pool, { orgId: req.orgId, name: d.name, role: d.role, duty: d.duty ?? null, birthDate: d.birthDate ?? null });
        await audit(pool, { ...me(req), action: 'roster.create-line', table: 'membership', rowId: l.membershipId, after: { name: d.name, role: d.role } });
        return res.status(201).json(withWarnings({ id: l.membershipId, loginId: null, temp: null }, await warn()));
      }
      const a = await createAccount(pool, { orgId: req.orgId, name: d.name, loginId: d.loginId, role: d.role, duty: d.duty ?? null });
      if (a.error) return res.status(409).json({ error: a.error });
      if (d.birthDate) await pool.query(`UPDATE membership SET birth_date = $2 WHERE id = $1`, [a.membershipId, d.birthDate]);
      await audit(pool, { ...me(req), action: 'roster.create', table: 'membership', rowId: a.membershipId, after: { loginId: d.loginId, role: d.role } });
      res.status(201).json(withWarnings({ id: a.membershipId, loginId: d.loginId, temp: a.temp }, await warn()));
    } catch (e) {
      next(e);
    }
  });

  // 겸임 데려오기 — 다른 기관 사람을 ID 로 찾아 이 기관 소속으로 더한다(계정·비밀번호는 그대로). 감사 로그에 남는다.
  r.post('/concurrent', async (req, res, next) => {
    try {
      const p = z.object({ loginId: z.string().trim().regex(ID_RE), role: z.enum(ROLES).default('교직원') }).safeParse(req.body);
      if (!p.success) return res.status(400).json({ error: '입력을 확인해 주세요' });
      const u = (await pool.query(`SELECT login_id, name FROM app_user WHERE lower(login_id) = lower($1) AND deleted_at IS NULL`, [p.data.loginId])).rows[0];
      const none = () => res.status(404).json({ error: '데려올 수 없습니다. ID 를 확인해 주세요' }); // 없음·이미 소속·실패를 한 응답으로(ID 존재 여부를 드러내지 않는다)
      if (!u) return none();
      const a = await createAccount(pool, { orgId: req.orgId, name: '', loginId: u.login_id, role: p.data.role, existing: 'add' });
      if (a.error) return none();
      await audit(pool, { ...me(req), action: 'roster.concurrent-add', table: 'membership', rowId: a.membershipId, after: { loginId: u.login_id, role: p.data.role } });
      res.status(201).json({ id: a.membershipId, loginId: u.login_id, name: u.name, role: p.data.role });
    } catch (e) {
      next(e);
    }
  });

  // 재직 상태 바꾸기 한 줄(거래 안 client c) — 퇴직이면 공용 해제(휴면 사유 retired), 로그인 안 되는 상태면 세션 끊기.
  // 맡은 담임·수업 수를 같이 돌려준다(자료는 안 지운다 — 시수표·시간표 칸은 그 줄을 그대로 가리킨다).
  // 반환 { id, name, before, status, homeroom, classes, unlinked } 또는 { error: '<문구 키>' }
  const changeStatus = async (c, orgId, byUserId, ln, status, force = false) => {
    const base = { id: Number(ln.id), name: ln.name, before: ln.m_status, status };
    const counts = async () => {
      const h = (await c.query(`SELECT count(*)::int AS n FROM classroom WHERE org_id = $1 AND homeroom_membership_id = $2 AND deleted_at IS NULL`, [orgId, ln.id])).rows[0].n;
      const l = (await c.query(`SELECT count(*)::int AS n FROM teaching_load WHERE org_id = $1 AND (membership_id = $2 OR second_membership_id = $2) AND deleted_at IS NULL`, [orgId, ln.id])).rows[0].n;
      return { homeroom: h, classes: l };
    };
    if (ln.m_status === status) return { ...base, ...(await counts()), unlinked: false, same: true };
    const off = !MEMBER_STATUS_LOGIN.includes(status);
    if (off && ln.user_id != null && Number(ln.user_id) === Number(byUserId)) return { error: 'roster.err.self_status' };
    if (off && ln.role === ROLE.ORG_ADMIN && !force && (await isLastAdmin(c, orgId, { mid: ln.id }))) return { error: 'roster.err.last_admin_warn', extra: lastWarn() };
    // 숨김·전출에서 재직·휴직으로 되돌릴 때 다른 본 소속이 있으면 겸임으로 선다(013 트리거 대신 · T-1322b②)
    const conc = !off && !MEMBER_STATUS_LOGIN.includes(ln.m_status) && ln.user_id != null && (await hasPrimaryLine(c, ln.user_id, ln.id));
    await c.query(`UPDATE membership SET status = $2, is_concurrent = is_concurrent OR $3 WHERE id = $1`, [ln.id, status, conc]);
    let unlinked = false;
    if (status === MEMBER_STATUS.RETIRED && ln.user_id != null) {
      const u = await unlinkAccount(c, { membershipId: ln.id, byUserId, reason: DORMANT_REASON.RETIRED });
      if (u.error) return u;
      unlinked = true;
    } else if (off && ln.user_id != null) await killSessions(c, ln.user_id);
    await audit(c, { orgId, userId: byUserId, action: 'roster.status', table: 'membership', rowId: ln.id, before: { status: ln.m_status }, after: { status, unlinked } });
    return { ...base, ...(await counts()), unlinked };
  };
  // 담당이 빈 줄을 모아 학교 소식 한 줄(재직으로 되돌린 줄은 안 셈)
  const noticeVacated = async (orgId, done) => {
    const hit = done.filter((x) => !x.same && x.status !== MEMBER_STATUS.ACTIVE && x.homeroom + x.classes > 0);
    if (!hit.length) return null;
    const 담임 = hit.reduce((a, x) => a + x.homeroom, 0);
    const 수업 = hit.reduce((a, x) => a + x.classes, 0);
    const 상태 = 값이름('membership.status', hit[0].status);
    const text = hit.length === 1
      ? t('roster.notice.vacated', { 이름: hit[0].name ?? '', 상태, 담임, 수업 })
      : t('roster.notice.vacated_many', { 명: hit.length, 담임, 수업 });
    return (await notify(pool, { orgId, kind: 'roster_vacated', text, link: 'tab:school:vacant' })).id;
  };
  const lineOf = async (db, orgId, mid) => (await db.query(
    `SELECT id, user_id, role, status AS m_status, name FROM membership
      WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL AND role <> $3 FOR UPDATE`, [mid, orgId, ROLE.SYSADMIN])).rows[0];

  r.patch('/:mid', async (req, res, next) => {
    try {
      const p = patchBody.safeParse(req.body);
      if (!p.success) return fail(res, 400, 'roster.err.bad_input');
      const ln = await target(req);
      if (!ln) return nf(res);
      const d = p.data;
      const status = d.status ?? (d.hidden === undefined ? undefined : d.hidden ? MEMBER_STATUS.RETIRED : MEMBER_STATUS.ACTIVE);
      const losesAdmin = ln.role === ROLE.ORG_ADMIN && d.role && d.role !== ROLE.ORG_ADMIN;
      // 이름은 줄 이름(학교가 적은 이름)이라 계정에 안 닿는다 — 계정에 닿는 건 아이디뿐
      if (d.loginId && !ln.user_id) return nf(res); // 계정 없는 줄엔 아이디가 없다(연결은 따로 하는 일)
      const touchesAccount = !!(d.loginId && d.loginId !== ln.login_id);
      if (touchesAccount && (await sharedElsewhere(ln))) return res.status(409).json({ error: SHARED });
      if (losesAdmin && !forced(req) && (await isLastAdmin(pool, req.orgId, { mid: ln.id }))) return fail(res, 409, 'roster.err.last_admin_warn', undefined, lastWarn());
      if (d.loginId && d.loginId.toLowerCase() !== ln.login_id.toLowerCase()) {
        const dup = await pool.query(`SELECT 1 FROM app_user WHERE lower(login_id) = lower($1)`, [d.loginId]);
        if (dup.rows[0]) return res.status(409).json({ error: '이미 쓰고 있는 ID 입니다' });
      }
      // 재직 상태 먼저(거절되면 아무것도 안 바뀐다)
      let st = null;
      if (status !== undefined) {
        st = await withTx(pool, async (c) => {
          const cur = await lineOf(c, req.orgId, ln.id);
          return cur ? changeStatus(c, req.orgId, req.session.userId, cur, status, forced(req)) : { error: 'roster.err.line_not_found' };
        });
        if (st.error) return fail(res, 409, st.error, undefined, st.extra);
      }
      if (d.loginId && !st?.unlinked) await pool.query(`UPDATE app_user SET login_id = $2 WHERE id = $1`, [ln.user_id, d.loginId]);
      await pool.query(
        `UPDATE membership SET role = CASE WHEN $7::boolean THEN role ELSE COALESCE($2, role) END, duty = CASE WHEN $3::boolean THEN $4 ELSE duty END,
                name = COALESCE($5, name), birth_date = CASE WHEN $6::boolean THEN $8::date ELSE birth_date END WHERE id = $1`,
        [ln.id, d.role ?? null, 'duty' in d, d.duty ?? null, d.name || null, 'birthDate' in d, !!st?.unlinked, d.birthDate ?? null],
      );
      if (ln.user_id && d.role && d.role !== ln.role && ROLES.indexOf(d.role) > ROLES.indexOf(ln.role)) await killSessions(pool, ln.user_id); // 역할이 내려가면 세션 끊기
      await audit(pool, { ...me(req), action: 'roster.update', table: 'membership', rowId: ln.id, before: { role: ln.role, loginId: ln.login_id }, after: d });
      const notice = st ? await noticeVacated(req.orgId, [st]) : null;
      res.json(withWarnings({ ok: true, ...(st ? { status: { ...st, notice } } : {}) }, 'duty' in d ? dutyWarnings(await loadConfig(pool, req.orgId), d.duty) : []));
    } catch (e) {
      next(e);
    }
  });

  // 여러 줄 재직 상태 한 번에(학년 말 퇴직·전출 몰림) — 줄마다 거래 하나(한 줄이 거절돼도 나머지는 바뀐다). 담당이 빈 것은 모아 소식 한 줄.
  r.post('/status', async (req, res, next) => {
    try {
      const p = bulkStatusBody.safeParse(req.body);
      if (!p.success) return fail(res, 400, 'roster.err.bad_input');
      const results = [];
      for (const id of [...new Set(p.data.ids)]) {
        const out = await withTx(pool, async (c) => {
          const cur = await lineOf(c, req.orgId, id);
          return cur ? changeStatus(c, req.orgId, req.session.userId, cur, p.data.status, forced(req)) : { error: 'roster.err.line_not_found' };
        });
        results.push(out.error ? { id, ok: false, code: out.error, error: t(out.error), ...out.extra } : { ok: true, ...out });
      }
      const done = results.filter((x) => x.ok);
      const notice = await noticeVacated(req.orgId, done);
      res.json({
        results, changed: done.filter((x) => !x.same).length, failed: results.length - done.length,
        homeroom: done.reduce((a, x) => a + x.homeroom, 0), classes: done.reduce((a, x) => a + x.classes, 0), notice,
      });
    } catch (e) {
      next(e);
    }
  });

  // 소속 떼기 — 이 기관 멤버십만 지운다(계정·다른 기관 소속은 그대로). 딸린 것은 cascade 묶음으로 남아 휴지통에서 되살린다.
  // 계정이 연결된 줄이면 공용 「해제」가 같이 되어 그 계정은 「연결 안 된 계정」 묶음에 선다(되살리면 줄만 돌아온다 · T-1302b①).
  r.delete('/:mid', async (req, res, next) => {
    try {
      const t = await target(req);
      if (!t) return nf(res);
      if (t.user_id === req.session.userId) return res.status(409).json({ error: '내 소속은 뗄 수 없습니다' });
      if (t.role === ROLE.ORG_ADMIN && !forced(req) && (await isLastAdmin(pool, req.orgId, { mid: t.id }))) return fail(res, 409, 'roster.err.last_admin_warn', undefined, lastWarn());
      const out = await inTx(pool, async (c) => {
        if (t.user_id != null) {
          const u = await unlinkAccount(c, { membershipId: t.id, byUserId: req.session.userId, reason: DORMANT_REASON.REMOVED, listUnlinked: true });
          if (u.error) return u;
        }
        return removeWithCascade(c, req.orgId, 'membership', t.id, req.session.userId);
      });
      if (out?.error) return fail(res, 409, out.error);
      if (!out) return nf(res);
      await audit(pool, { ...me(req), action: 'membership.delete', table: 'membership', rowId: t.id, after: { name: out.label, batch: out.batchId } });
      res.json({ ok: true, batchId: out.batchId, unlinked: t.user_id != null });
    } catch (e) {
      e.expose ? res.status(e.status).json({ error: e.message }) : next(e);
    }
  });
  // 기관 관리자의 계정 「잠금」·「잠금 풂」 길은 걷었다(T-1302b① · 잠금은 총괄관리자만 — T-1326). 학교에서 못 쓰게 하는 길은 재직 상태·연결 해제.

  // ── 계정 연결(T-1302b①) — 「계정 연결」 창 세 갈래 · 연결 해제 · 「연결 안 된 계정」 묶음 ──
  const lineFor = async (mid, orgId, db = pool) => {
    const ok = idParam.safeParse(mid);
    if (!ok.success) return null;
    return (await db.query(
      `SELECT id, user_id, role, name, birth_date FROM membership
        WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL AND role <> $3`, [ok.data, orgId, ROLE.SYSADMIN])).rows[0];
  };
  const userByLogin = async (loginId) =>
    (await pool.query(`SELECT id, login_id, name FROM app_user WHERE lower(login_id) = lower($1) AND deleted_at IS NULL`, [loginId])).rows[0];
  const linkIn = z.object({ loginId: z.string().trim().regex(ID_RE), force: z.boolean().optional(), concurrent: z.boolean().optional(), until: z.string().trim().optional() });

  // 대조 경고 둘(이름·생년월일 다름 / 같은 사람 계정이 또 있음) — 막지 않고 알린다. 경고가 있으면 409 needConfirm, force 면 그대로 잇는다.
  const linkChecked = async (req, res, ln, user, force, concurrent = false, until = null) => {
    if (ln.user_id != null) return fail(res, 409, Number(ln.user_id) === Number(user.id) ? 'roster.err.already_linked' : 'roster.err.line_taken');
    if (!force) {
      const m = await matchPerson(pool, { name: ln.name, birthDate: ln.birth_date, userId: user.id });
      const warnings = [];
      if (m.check?.name === false) warnings.push({ code: 'name', text: t('roster.link_warn.name', { 계정이름: user.name ?? '' }) });
      if (m.check?.birth === false) warnings.push({ code: 'birth', text: t('roster.link_warn.birth') });
      const others = m.candidates.filter((x) => x.userId !== Number(user.id));
      if (others.length) {
        const 아이디 = others.map((x) => x.loginId).join(', ');
        warnings.push({
          code: 'other', text: t('roster.link_warn.other', { 아이디 }),
          accounts: others.map((x) => ({ loginId: x.loginId, linkedCount: x.linkedCount })),
        });
      }
      if (warnings.length) return fail(res, 409, 'roster.err.need_confirm', undefined, { needConfirm: true, warnings });
    }
    // 다른 학교 재직(본 소속) 계정 — 「겸임으로 연결」이 아니면 그 학교에 전출 요청(T-1322b①). 겸임 여부는 여기서 직접 넣는다.
    const by = req.session.userId;
    const cu = resolveUntil(until);
    if (cu.error) return fail(res, 400, cu.error);
    const inOrg = (await pool.query(`SELECT 1 FROM membership WHERE user_id = $1 AND org_id = $2 AND deleted_at IS NULL`, [user.id, req.orgId])).rows[0];
    if (inOrg) return fail(res, 409, 'roster.err.account_in_org');
    const home = await homeOrgOf(pool, user.id, req.orgId);
    if (home != null && !concurrent) {
      const out = await withTx(pool, (c) => requestTransfer(c, { fromOrg: home, toOrg: req.orgId, userId: user.id, toMembershipId: ln.id, byUserId: by }));
      if (out.error) return fail(res, out.status === 404 ? 409 : out.status ?? 409, out.error);
      if (out.autoApproved) return res.json({ ok: true, membershipId: out.membershipId, userId: out.userId, isConcurrent: false, loginId: user.login_id, autoApproved: true });
      return res.status(202).json({ transferRequested: true, requestId: out.requestId, expiresAt: out.expiresAt, loginId: user.login_id });
    }
    // 겸임으로 이어지면 기한을 적고 양쪽 학교에 소식(기한을 안 줬으면 그 학년도 2월 말일) — 연결과 한 거래
    const out = await withTx(pool, async (c) => {
      const l = await linkAccount(c, { membershipId: ln.id, userId: user.id, byUserId: by, concurrent: home != null });
      if (l.error || !l.isConcurrent) return l;
      await c.query(`UPDATE membership SET concurrent_until = $2::date, concurrent_warned_until = NULL WHERE id = $1`, [ln.id, cu.until]);
      await notifyConcurrent(c, { key: 'linked', orgId: req.orgId, userId: user.id, name: ln.name, until: cu.until });
      return { ...l, concurrentUntil: cu.until };
    });
    if (out.error) return fail(res, 409, out.error);
    res.json({ ...out, loginId: user.login_id });
  };

  // 갈래 ① 아이디로 연결 — { loginId, force?, concurrent?(「겸임으로 연결」) } → { ok, membershipId, userId, isConcurrent, loginId } · 경고면 409 { needConfirm, warnings }
  //   다른 학교 재직 계정이고 concurrent 가 아니면 202 { transferRequested, requestId, expiresAt, loginId }(전출 요청 · 승인 대기)
  //   보내는 학교가 자동 승인을 켰으면 그 자리에서 옮겨 와 200 { ok, …, autoApproved: true }
  r.post('/:mid/link', async (req, res, next) => {
    try {
      const ln = await lineFor(req.params.mid, req.orgId);
      if (!ln) return nf(res);
      const p = linkIn.safeParse(req.body);
      if (!p.success) return fail(res, 400, 'roster.err.bad_input');
      const user = await userByLogin(p.data.loginId);
      if (!user) return fail(res, 404, 'roster.err.account_not_found');
      await linkChecked(req, res, ln, user, p.data.force, p.data.concurrent, p.data.until);
    } catch (e) {
      next(e);
    }
  });

  // 겸임 기간 바꾸기(늘리기) — { until: 'YYYY-MM-DD' } → { ok, membershipId, concurrentUntil } · 양쪽 학교에 소식 · 끝 30일 전 알림은 다시 나간다
  r.put('/:mid/concurrent', async (req, res, next) => {
    try {
      const ln = await lineFor(req.params.mid, req.orgId);
      if (!ln) return nf(res);
      const cur = (await pool.query(`SELECT is_concurrent FROM membership WHERE id = $1`, [ln.id])).rows[0];
      if (ln.user_id == null || !cur?.is_concurrent) return fail(res, 409, 'roster.err.not_concurrent');
      if (typeof req.body?.until !== 'string') return fail(res, 400, 'roster.err.concurrent_until_bad');
      const cu = resolveUntil(req.body.until);
      if (cu.error) return fail(res, 400, cu.error);
      await withTx(pool, async (c) => {
        await c.query(`UPDATE membership SET concurrent_until = $2::date, concurrent_warned_until = NULL WHERE id = $1`, [ln.id, cu.until]);
        await audit(c, { ...me(req), action: 'roster.concurrent-until', table: 'membership', rowId: ln.id, after: { date: cu.until } });
        await notifyConcurrent(c, { key: 'extended', orgId: req.orgId, userId: ln.user_id, name: ln.name, until: cu.until });
        return { ok: true };
      });
      res.json({ ok: true, membershipId: Number(ln.id), concurrentUntil: cu.until });
    } catch (e) {
      next(e);
    }
  });

  // 갈래 ② 계정 만들어 주기 — { loginId } → 201 { ok, membershipId, userId, loginId, temp }(임시 비밀번호는 한 번만)
  r.post('/:mid/account', async (req, res, next) => {
    try {
      const ln = await lineFor(req.params.mid, req.orgId);
      if (!ln) return nf(res);
      if (ln.user_id != null) return fail(res, 409, 'roster.err.line_taken');
      const p = z.object({ loginId: z.string().trim().regex(ID_RE) }).safeParse(req.body);
      if (!p.success) return fail(res, 400, 'roster.err.bad_input');
      const out = await withTx(pool, async (c) => {
        const a = await createUserOnly(c, { name: ln.name ?? '', loginId: p.data.loginId, birthDate: ln.birth_date });
        if (a.error) return a;
        const l = await linkAccount(c, { membershipId: ln.id, userId: a.userId, byUserId: req.session.userId });
        if (l.error) return l;
        await audit(c, { ...me(req), action: 'roster.create-account', table: 'membership', rowId: ln.id, after: { loginId: p.data.loginId } });
        return { ...l, loginId: p.data.loginId, temp: a.temp };
      });
      if (out.error) return fail(res, 409, out.error);
      res.status(201).json(out);
    } catch (e) {
      next(e);
    }
  });

  // 갈래 ③ 초대 코드 발급·재발급 — 그 줄의 앞 코드는 무효 · 7일 → 201 { code, expiresAt, first }
  r.post('/:mid/invite', async (req, res, next) => {
    try {
      const ln = await lineFor(req.params.mid, req.orgId);
      if (!ln) return nf(res);
      const out = await withTx(pool, async (c) => {
        const i = await issueInvite(c, { orgId: req.orgId, membershipId: ln.id, byUserId: req.session.userId });
        if (i.error) return i;
        await audit(c, { ...me(req), action: 'roster.invite', table: 'membership', rowId: ln.id });
        return i;
      });
      if (out.error) return fail(res, 409, out.error);
      res.status(201).json({ ...out, nudge: out.first ? await takeContactNudge(pool, req.orgId) : false }); // nudge: 연락처 적기 권유 — 서버가 한 번만 true
    } catch (e) {
      next(e);
    }
  });

  // 연결 해제 — 그 계정은 「연결 안 된 계정」 묶음(30일)에 선다 → { ok, membershipId, userId, dormant }
  r.delete('/:mid/link', async (req, res, next) => {
    try {
      const ln = await lineFor(req.params.mid, req.orgId);
      if (!ln) return nf(res);
      if (ln.user_id == null) return fail(res, 409, 'roster.err.not_linked');
      if (Number(ln.user_id) === Number(req.session.userId)) return fail(res, 409, 'roster.err.self_unlink');
      if (ln.role === ROLE.ORG_ADMIN && !forced(req) && (await isLastAdmin(pool, req.orgId, { mid: ln.id }))) return fail(res, 409, 'roster.err.last_admin_warn', undefined, lastWarn());
      const u = await unlinkAccount(pool, { membershipId: ln.id, byUserId: req.session.userId, reason: DORMANT_REASON.REMOVED, listUnlinked: true });
      if (u.error) return fail(res, 409, u.error);
      res.json(u);
    } catch (e) {
      next(e);
    }
  });

  // 「연결 안 된 계정」 묶음 — [{ userId, loginId, name, since, expiresAt, fromLineId, fromLineName }]
  r.get('/unlinked', async (req, res, next) => {
    try {
      const rows = (await pool.query(
        `SELECT ua.user_id, ua.membership_id, ua.created_at, ua.expires_at, u.login_id, u.name
           FROM unlinked_account ua JOIN app_user u ON u.id = ua.user_id AND u.deleted_at IS NULL
          WHERE ua.org_id = $1 AND ua.reason = $2 AND ua.resolved_at IS NULL
          ORDER BY ua.created_at, ua.id`, [req.orgId, UNLINKED_REASON.UNLINKED])).rows;
      const ids = rows.map((x) => x.membership_id).filter((x) => x != null);
      const lines = new Map((await pool.query(`SELECT id, name FROM membership WHERE id = ANY($1::bigint[])`, [ids])).rows.map((x) => [String(x.id), x.name]));
      res.json(rows.map((x) => ({
        userId: Number(x.user_id), loginId: x.login_id, name: x.name, since: x.created_at, expiresAt: x.expires_at,
        fromLineId: x.membership_id == null ? null : Number(x.membership_id), fromLineName: lines.get(String(x.membership_id)) ?? null,
      })));
    } catch (e) {
      next(e);
    }
  });
  const openUnlinked = async (orgId, uid) => {
    const ok = idParam.safeParse(uid);
    if (!ok.success) return null;
    return (await pool.query(
      `SELECT ua.user_id FROM unlinked_account ua WHERE ua.org_id = $1 AND ua.user_id = $2 AND ua.reason = $3 AND ua.resolved_at IS NULL LIMIT 1`,
      [orgId, ok.data, UNLINKED_REASON.UNLINKED])).rows[0];
  };

  // 묶음 → 명단에 연결 — { membershipId, force? } · 응답은 아이디로 연결과 같다
  r.post('/unlinked/:uid/link', async (req, res, next) => {
    try {
      const open = await openUnlinked(req.orgId, req.params.uid);
      if (!open) return nf(res);
      const p = z.object({ membershipId: idParam, force: z.boolean().optional() }).safeParse(req.body);
      if (!p.success) return fail(res, 400, 'roster.err.bad_input');
      const ln = await lineFor(p.data.membershipId, req.orgId);
      if (!ln) return fail(res, 404, 'roster.err.line_not_found');
      const user = (await pool.query(`SELECT id, login_id, name FROM app_user WHERE id = $1 AND deleted_at IS NULL`, [open.user_id])).rows[0];
      if (!user) return nf(res);
      await linkChecked(req, res, ln, user, p.data.force);
    } catch (e) {
      next(e);
    }
  });

  // 묶음 → 학교에서 내보내기(다른 소속이 없으면 휴면) → { ok, userId, dormant }
  r.post('/unlinked/:uid/release', async (req, res, next) => {
    try {
      const open = await openUnlinked(req.orgId, req.params.uid);
      if (!open) return nf(res);
      const out = await withTx(pool, (c) => releaseUnlinked(c, { orgId: req.orgId, userId: open.user_id, byUserId: req.session.userId }));
      if (out.error) return fail(res, 409, out.error);
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  // ── 가입 승인(T-1322a) — 승인 대기(pending_approval) 건을 기관 관리자가 명단 줄에 잇는다 ──
  // 계정 표와 명단 표는 한 SQL 에서 같이 읽지 않는다(name-source) — 계정 값·줄 값을 따로 읽어 맞춘다.
  const birthText = (d) => (d ? new Date(d).toLocaleDateString('sv-SE').replaceAll('-', '') : '');
  // 승인 대기 건 하나(거래 안에서 잠근다)
  const pendingFor = async (db, orgId, uid) => {
    const ok = idParam.safeParse(uid);
    if (!ok.success) return null;
    return (await db.query(
      `SELECT id, user_id, membership_id, created_at FROM unlinked_account
        WHERE org_id = $1 AND user_id = $2 AND reason = $3 AND resolved_at IS NULL AND expires_at > now()
        ORDER BY id DESC LIMIT 1 FOR UPDATE`, [orgId, ok.data, UNLINKED_REASON.PENDING_APPROVAL])).rows[0];
  };
  const userRow = async (db, uid) =>
    (await db.query(`SELECT id, login_id, name, birth_date, created_at FROM app_user WHERE id = $1 AND deleted_at IS NULL`, [uid])).rows[0];
  // 계정마다 지금 소속 학교 이름(재직·휴직 줄) — Map(userId → [학교])
  const orgsOf = async (db, ids) => {
    const m = new Map(ids.map((x) => [Number(x), []]));
    const rows = (await db.query(
      `SELECT m.user_id, o.name FROM membership m JOIN org o ON o.id = m.org_id
        WHERE m.user_id = ANY($1::bigint[]) AND m.deleted_at IS NULL AND m.status = ANY($2::text[]) AND m.role <> $3 ORDER BY m.id`,
      [ids, MEMBER_STATUS_LOGIN, ROLE.SYSADMIN])).rows;
    for (const x of rows) m.get(Number(x.user_id))?.push(x.name);
    return m;
  };
  // 경고 둘 — 이름·생년월일 다름 / 같은 사람 계정이 또 있음(다른 계정마다 한 줄 · 다른 학교 계정 정보가 보이는 유일한 자리)
  const approveWarnings = async (db, ln, user) => {
    const m = await matchPerson(db, { name: ln.name, birthDate: ln.birth_date, userId: user.id });
    const out = [];
    if (m.check?.name === false) out.push({ code: 'name', text: t('roster.approve_warn.name', { 계정: user.name ?? '', 명단: ln.name ?? '' }) });
    if (m.check?.birth === false) out.push({ code: 'birth', text: t('roster.approve_warn.birth', { 계정: birthText(user.birth_date), 명단: birthText(ln.birth_date) }) });
    const others = m.candidates.filter((x) => x.userId !== Number(user.id));
    if (others.length) {
      const ids = others.map((x) => x.userId);
      const births = new Map((await db.query(`SELECT id, birth_date FROM app_user WHERE id = ANY($1::bigint[])`, [ids])).rows.map((x) => [Number(x.id), x.birth_date]));
      const orgs = await orgsOf(db, ids);
      for (const o of others) {
        const birthDate = birthText(births.get(o.userId)) || null;
        const 학교 = orgs.get(o.userId) ?? [];
        const vars = { 이름: o.name ?? '', 생년월일: birthDate ?? t('roster.approve.birth_unknown'), 학교: 학교.join(', '), 아이디: o.loginId };
        out.push({
          code: 'other', text: t(학교.length ? 'roster.approve_warn.other' : 'roster.approve_warn.other_none', vars),
          accounts: [{ userId: o.userId, loginId: o.loginId, birthDate, orgs: 학교 }],
        });
      }
    }
    return out;
  };
  // 이 계정이 쓴 마지막 초대 코드의 종류(전입·겸임) — 대기 건은 코드를 쓴 뒤 생긴다
  const codeKind = async (db, orgId, uid) =>
    (await db.query(
      `SELECT kind FROM invite_code WHERE org_id = $1 AND used_by = $2 AND used_at IS NOT NULL ORDER BY used_at DESC, id DESC LIMIT 1`, [orgId, uid])).rows[0]?.kind ?? null;
  const orgName = async (db, orgId) => (await db.query(`SELECT name FROM org WHERE id = $1`, [orgId])).rows[0]?.name ?? '';
  const pickBody = z.object({ membershipId: idParam.optional(), force: z.boolean().optional() });

  // 한 건 승인(거래 안). 반환 { ok, ... } | { error, status, extra }
  const approveOne = async (c, { orgId, uid, membershipId, force, byUserId }) => {
    const p = await pendingFor(c, orgId, uid);
    if (!p) return { error: 'roster.err.pending_not_found', status: 404 };
    const ln = await lineFor(membershipId ?? p.membership_id, orgId, c);
    if (!ln) return { error: 'roster.err.line_not_found', status: 404 };
    if (ln.user_id != null) return { error: 'roster.err.line_taken_pick', status: 409, vars: { 이름: ln.name ?? '' }, extra: { lineTaken: true, membershipId: Number(ln.id) } };
    const user = await userRow(c, p.user_id);
    if (!user) return { error: 'roster.err.pending_not_found', status: 404 };
    if (!force) {
      const warnings = await approveWarnings(c, ln, user);
      if (warnings.length) return { error: 'roster.err.need_confirm', status: 409, extra: { needConfirm: true, warnings } };
    }
    if (Number(ln.id) !== Number(p.membership_id)) await c.query(`UPDATE unlinked_account SET membership_id = $2 WHERE id = $1`, [p.id, ln.id]);
    const from = (await codeKind(c, orgId, user.id)) === INVITE_KIND.MOVE_IN ? await moveInFrom(c, user.id, orgId) : [];
    await moveOut(c, { from, orgId, membershipId: ln.id, byUserId });
    const l = await linkAccount(c, { membershipId: ln.id, userId: user.id, byUserId });
    if (l.error) return { ...l, status: 409 };
    await audit(c, { orgId, userId: byUserId, action: 'roster.approve', table: 'membership', rowId: ln.id, after: { userId: Number(user.id), moved: from.map((x) => Number(x.id)) } });
    const 학교 = await orgName(c, orgId);
    await notify(c, { userId: user.id, orgId, kind: 'roster.approve', text: t('roster.approve_notice.in', { 학교 }) });
    await killSessions(c, user.id); // 새 소속·권한은 다시 로그인해야 선다
    return { ok: true, userId: Number(user.id), membershipId: Number(ln.id), loginId: user.login_id, moved: from.length > 0 };
  };
  const sendFail = (res, out) => fail(res, out.status ?? 409, out.error, out.vars, out.extra);

  // 연락처 적기 권유 — 승인 탭에 첫 승인 대기가 보일 때 한 번만 { show: true }(연락처가 비었고 아직 안 보였을 때)
  r.post('/contact-nudge', async (req, res, next) => {
    try {
      res.json({ show: await takeContactNudge(pool, req.orgId) });
    } catch (e) {
      next(e);
    }
  });

  // 승인 대기 목록 — [{ userId, account:{loginId,name,birthDate,signedUpAt,orgs}, line:{id,name,birthDate,duty,taken}, kind, moveFrom:[학교], birthOnly, warnings }]
  r.get('/approvals', async (req, res, next) => {
    try {
      const rows = (await pool.query(
        `SELECT user_id, membership_id FROM unlinked_account
          WHERE org_id = $1 AND reason = $2 AND resolved_at IS NULL AND expires_at > now() ORDER BY created_at, id`,
        [req.orgId, UNLINKED_REASON.PENDING_APPROVAL])).rows;
      const ids = rows.map((x) => Number(x.user_id));
      const orgs = await orgsOf(pool, ids);
      const out = [];
      for (const x of rows) {
        const user = await userRow(pool, x.user_id);
        const ln = (await pool.query(`SELECT id, user_id, name, birth_date, duty FROM membership WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [x.membership_id, req.orgId])).rows[0];
        if (!user || !ln) continue;
        const kind = await codeKind(pool, req.orgId, user.id);
        const moveFrom = kind === INVITE_KIND.MOVE_IN ? (await moveInFrom(pool, user.id, req.orgId)).map((f) => f.org_name) : [];
        out.push({
          userId: Number(user.id),
          account: { loginId: user.login_id, name: user.name, birthDate: birthText(user.birth_date) || null, signedUpAt: user.created_at, orgs: orgs.get(Number(user.id)) ?? [] },
          line: { id: Number(ln.id), name: ln.name, birthDate: birthText(ln.birth_date) || null, duty: ln.duty, taken: ln.user_id != null },
          kind, moveFrom, birthOnly: !ln.birth_date,
          warnings: ln.user_id != null ? [] : await approveWarnings(pool, ln, user),
        });
      }
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  // 한 건 승인 — { membershipId?(줄 다시 고름), force? } → { ok, userId, membershipId, loginId, moved }
  //   409 line_taken_pick { lineTaken, membershipId } · 409 need_confirm { needConfirm, warnings }
  r.post('/approvals/:uid/approve', async (req, res, next) => {
    try {
      const p = pickBody.safeParse(req.body ?? {});
      if (!p.success) return fail(res, 400, 'roster.err.bad_input');
      const out = await withTx(pool, (c) => approveOne(c, { orgId: req.orgId, uid: req.params.uid, ...p.data, byUserId: req.session.userId }));
      if (out.error) return out.status === 404 ? nf(res) : sendFail(res, out);
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  // 일괄 승인 — { userIds:[...] } → { done:[{userId,membershipId,moved}], skipped:[{userId, code, text}] } · 경고·줄 찬 건은 빠진다
  r.post('/approvals/bulk', async (req, res, next) => {
    try {
      const p = z.object({ userIds: z.array(idParam).min(1).max(CEIL.rosterRows) }).safeParse(req.body);
      if (!p.success) return fail(res, 400, 'roster.err.bad_input');
      const done = [];
      const skipped = [];
      for (const uid of [...new Set(p.data.userIds)]) {
        const out = await withTx(pool, (c) => approveOne(c, { orgId: req.orgId, uid, force: false, byUserId: req.session.userId }));
        if (out.error) {
          const code = out.error.replace(/^roster\.err\./, '');
          const text = out.extra?.warnings ? out.extra.warnings.map((w) => w.text).join(' ') : t(out.error, out.vars);
          skipped.push({ userId: uid, code, text });
        } else done.push({ userId: out.userId, membershipId: out.membershipId, moved: out.moved });
      }
      res.json({ done, skipped });
    } catch (e) {
      next(e);
    }
  });

  // 「이 계정으로 연결」 — { userId(같은 사람으로 보이는 다른 계정), membershipId? } → { ok, userId, membershipId, loginId }
  //   그 계정이 다른 학교에 재직 중이면 409 other_active(전출 요청은 1322b①) · 원래 대기 건은 닫힌다(새 중복 계정은 7일 정리가 맡음)
  r.post('/approvals/:uid/use-other', async (req, res, next) => {
    try {
      if (!(await pendingFor(pool, req.orgId, req.params.uid))) return nf(res); // 남의 기관 건이면 입력 검사보다 먼저 404
      const p = z.object({ userId: idParam, membershipId: idParam.optional() }).safeParse(req.body);
      if (!p.success) return fail(res, 400, 'roster.err.bad_input');
      const by = req.session.userId;
      const out = await withTx(pool, async (c) => {
        const pend = await pendingFor(c, req.orgId, req.params.uid);
        if (!pend) return { error: 'roster.err.pending_not_found', status: 404 };
        const ln = await lineFor(p.data.membershipId ?? pend.membership_id, req.orgId, c);
        if (!ln) return { error: 'roster.err.line_not_found', status: 404 };
        if (ln.user_id != null) return { error: 'roster.err.line_taken_pick', status: 409, vars: { 이름: ln.name ?? '' }, extra: { lineTaken: true, membershipId: Number(ln.id) } };
        // 학교 경계의 유일한 예외 — 대조 후보(같은 이름·생년월일 안 다름)에 든 계정만 받는다
        const m = await matchPerson(c, { name: ln.name, birthDate: ln.birth_date, userId: pend.user_id });
        const other = m.candidates.find((x) => x.userId === p.data.userId && x.userId !== Number(pend.user_id));
        if (!other) return { error: 'roster.err.other_not_found', status: 409 };
        // 다른 학교 재직(본 소속) 계정이면 「아이디로 연결」과 같은 길 — 그 학교에 전출 요청(T-1322b①). 이 계정을 고른 순간 원래 대기 건은 닫는다.
        const home = await homeOrgOf(c, other.userId, req.orgId);
        if (home != null) {
          const tr = await requestTransfer(c, { fromOrg: home, toOrg: req.orgId, userId: other.userId, toMembershipId: ln.id, byUserId: by });
          if (tr.error) return { ...tr, status: tr.status === 404 ? 409 : tr.status };
          await c.query(`UPDATE unlinked_account SET resolved_at = now() WHERE id = $1 AND resolved_at IS NULL`, [pend.id]);
          if (tr.autoApproved) return { ok: true, userId: other.userId, membershipId: Number(ln.id), loginId: other.loginId, autoApproved: true };
          return { transferRequested: true, requestId: tr.requestId, expiresAt: tr.expiresAt, loginId: other.loginId };
        }
        const l = await linkAccount(c, { membershipId: ln.id, userId: other.userId, byUserId: by, concurrent: false });
        if (l.error) return { ...l, status: 409 };
        await c.query(`UPDATE unlinked_account SET resolved_at = now() WHERE id = $1 AND resolved_at IS NULL`, [pend.id]);
        await audit(c, { orgId: req.orgId, userId: by, action: 'roster.approve-other', table: 'membership', rowId: ln.id, after: { userId: other.userId, pendingUserId: Number(pend.user_id) } });
        const 학교 = await orgName(c, req.orgId);
        await notify(c, { userId: other.userId, orgId: req.orgId, kind: 'roster.approve', text: t('roster.approve_notice.in', { 학교 }) });
        await killSessions(c, other.userId);
        return { ok: true, userId: other.userId, membershipId: Number(ln.id), loginId: other.loginId };
      });
      if (out.error) return out.status === 404 ? nf(res) : sendFail(res, out);
      res.status(out.transferRequested ? 202 : 200).json(out);
    } catch (e) {
      next(e);
    }
  });

  // 비밀번호 초기화 — 임시 비밀번호는 응답에 한 번만 나온다(저장 안 함)
  r.post('/:mid/reset-password', async (req, res, next) => {
    try {
      const t = await target(req);
      if (!t?.user_id) return nf(res); // 계정 없는 줄엔 비밀번호가 없다
      if (t.user_id === req.session.userId) return res.status(409).json({ error: '내 비밀번호는 「내 정보」에서 바꿔 주세요' });
      if (await sharedElsewhere(t)) return res.status(409).json({ error: SHARED });
      const temp = await resetPassword(pool, t.user_id);
      await killSessions(pool, t.user_id);
      await audit(pool, { ...me(req), action: 'roster.reset-password', table: 'app_user', rowId: t.user_id });
      res.json({ loginId: t.login_id, temp });
    } catch (e) {
      next(e);
    }
  });

  // ── 엑셀 바닥(T-1301b③) — 명단·시수표·고정금지 시트 한 파일. 내려받기 → 미리 보기(쓰지 않음) → 반영(트랜잭션) → 되돌리기 ──
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const sendXlsx = (res, name, buf) => {
    res.set('Content-Type', XLSX_MIME);
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(buf);
  };
  const excelErr = (res, next, e) => (e.status && e.expose ? res.status(e.status).json({ error: e.message, code: e.code }) : next(e));
  // 올린 파일에서 시트가 있는 스펙만 계획으로 만든다(시트가 하나도 없으면 400). 명단 아이디 연결용으로 시트 원본도 같이.
  const plansOf = async (db, orgId, buf) => {
    const book = await readWorkbook(buf);
    const specs = EXCEL_SPECS.filter((s) => book[s.sheet]);
    if (!specs.length) throw Object.assign(new Error(t('school.excel_err.no_sheet', { 시트: EXCEL_SPECS.map((s) => s.sheet).join('·') })), { status: 400, expose: true, code: 'school.excel_err.no_sheet' });
    const plans = [];
    for (const spec of specs) plans.push(await planSheet(db, orgId, spec, book[spec.sheet]));
    return Object.assign(plans, { book });
  };

  // 명단 시트 아이디 칸 → 연결 계획(다시 올리기 규칙 셋 · 11-25 재검)
  //  ① 아이디 칸이 비면 아무것도 안 한다(이미 된 연결도 그대로 — 해제는 줄 메뉴에서만)
  //  ② 줄마다 kind: linked(연결) · pending(다른 학교 재직 → 전출 요청 · 승인 대기) · check(이름·생년월일 다름 → 하나씩 봄)
  //                 missing(계정 없음 → 줄만) · taken(줄에 다른 계정) · in_org(이 학교 다른 줄에 연결됨) — 뒤 넷은 반영 안 함
  //  ③ 되돌리기는 줄 값만(아이디 열은 dbcols 가 없어 되돌리기 기록에 안 든다)
  // 결과 셋(일괄 연결과 같은 group 칸): linked · pending · check — 계획 kind 중 linked·pending 말고는 전부 확인 필요
  const BULK_GROUP = { linked: 'linked', pending: 'pending' };
  const linkPlan = async (db, orgId, plans) => {
    const plan = plans.find((p) => p.spec.name === rosterSpec.name);
    const rows = plan && plans.book[plan.sheet];
    if (!rows) return [];
    const head = rows[0] ?? [];
    const col = (key, dflt) => { const c = plan.spec.cols.find((x) => x.key === key); const i = head.indexOf(c.head); return i >= 0 ? i : dflt; };
    const [li, ni, bi] = [col('loginId', 4), col('name', 1), col('birth', 3)];
    const bad = new Set(plan.errors.map((e) => e.line));
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] ?? [];
      const line = i + 1;
      const loginId = String(r[li] ?? '').trim();
      if (!loginId || bad.has(line)) continue;
      const id = Number(String(r[0] ?? '').trim()) || null;
      const cur = id ? (await db.query(`SELECT m.name, m.birth_date, m.user_id, u.login_id FROM membership m LEFT JOIN app_user u ON u.id = m.user_id WHERE m.id = $1 AND m.org_id = $2`, [id, orgId])).rows[0] : null;
      if (cur?.user_id != null && String(cur.login_id ?? '').toLowerCase() === loginId.toLowerCase()) continue; // 이미 그 계정
      const name = String(r[ni] ?? '').trim() || cur?.name;
      const birth = String(r[bi] ?? '').trim() || cur?.birth_date || null;
      const push = (kind, extra = {}) => out.push({ line, id, loginId, kind, group: BULK_GROUP[kind] ?? 'check', msg: t(`roster.excel_link.${kind}`), ...extra });
      if (cur?.user_id != null) { push('taken'); continue; }
      const u = (await db.query(`SELECT id, name, birth_date FROM app_user WHERE lower(login_id) = lower($1) AND deleted_at IS NULL`, [loginId])).rows[0];
      if (!u) { push('missing'); continue; }
      const userId = Number(u.id);
      if ((await db.query(`SELECT 1 FROM membership WHERE user_id = $1 AND org_id = $2 AND deleted_at IS NULL`, [userId, orgId])).rows[0]) { push('in_org'); continue; }
      if (sameName(name, u.name) === false || sameBirth(birth, u.birth_date) === false) { push('check', { userId }); continue; }
      const home = (await db.query(
        `SELECT org_id FROM membership WHERE user_id = $1 AND org_id <> $2 AND deleted_at IS NULL AND status = ANY($3::text[]) AND NOT is_concurrent ORDER BY id LIMIT 1`,
        [userId, orgId, MEMBER_STATUS_LOGIN])).rows[0];
      if (home) push('pending', { userId, fromOrg: Number(home.org_id) });
      else push('linked', { userId });
    }
    return out;
  };
  // 반영 뒤 연결 계획 실행(같은 거래 안) — 새 줄은 applyPlans 가 적은 id 로 찾는다. 결과에 done(true/false)을 붙인다.
  const runLinks = async (c, orgId, byUserId, plans, links) => {
    const roster = plans.find((p) => p.spec.name === rosterSpec.name);
    const addId = new Map((roster?.add ?? []).filter((x) => x.id).map((x) => [x.line, x.id]));
    const out = [];
    for (const l of links) {
      const mid = l.id ?? addId.get(l.line);
      if (!mid || !['linked', 'pending'].includes(l.kind)) { out.push({ ...l, id: mid ?? null, done: false }); continue; }
      if (l.kind === 'linked') {
        const r = await linkAccount(c, { membershipId: mid, userId: l.userId, byUserId });
        out.push(r.error ? { ...l, id: mid, done: false, code: r.error, msg: t(r.error) } : { ...l, id: mid, done: true });
      } else {
        // 전출 요청 — 보내는 학교가 자동 승인을 켰으면 requestTransfer 가 그 자리에서 승인한다(T-1322b①)
        const tr = await requestTransfer(c, { fromOrg: l.fromOrg, toOrg: orgId, userId: l.userId, toMembershipId: mid, byUserId });
        if (tr.error) { out.push({ ...l, id: mid, done: false, code: tr.error, msg: t(tr.error) }); continue; }
        out.push({ ...l, id: mid, done: true });
      }
    }
    return out;
  };
  const hideIds = ({ userId, fromOrg, ...x }) => x; // 계정 번호는 화면에 안 낸다
  const rawXlsx = express.raw({ type: () => true, limit: '5mb' });

  r.get('/excel', async (req, res, next) => {
    try {
      const data = {};
      for (const spec of EXCEL_SPECS) data[spec.name] = await spec.rows(pool, req.orgId, await spec.context(pool, req.orgId));
      sendXlsx(res, t('school.excel.file_school'), await makeWorkbook(EXCEL_SPECS, data));
    } catch (e) { next(e); }
  });

  r.post('/excel/preview', rawXlsx, async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return fail(res, 400, 'school.excel_err.empty_file');
      const plans = await plansOf(pool, req.orgId, req.body);
      const hasErr = plans.some((p) => p.errors.length);
      const links = (await linkPlan(pool, req.orgId, plans)).map(hideIds);
      res.json({
        sheets: plans.map((p) => ({ sheet: p.sheet, name: p.spec.name, removable: p.spec.removable, add: p.add.map((x) => x.line), change: p.change.map((x) => ({ line: x.line, id: x.id })), remove: p.remove, same: p.same.length, errors: p.errors })),
        links,
        ...(links.length ? { undoNote: t('roster.excel.undo_note') } : {}),
        ...(hasErr ? { marked: (await markErrors(req.body, plans)).toString('base64'), markedName: t('school.excel.file_marked') } : {}),
      });
    } catch (e) { excelErr(res, next, e); }
  });

  // remove: 「all」 또는 지울 시트 이름을 쉼표로(?remove=시수표,고정·금지). 오류 줄은 건너뛰고 나머지만 넣는다.
  r.post('/excel/apply', rawXlsx, async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return fail(res, 400, 'school.excel_err.empty_file');
      const rm = String(req.query.remove ?? '');
      const remove = rm === 'all' ? true : rm.split(',').filter(Boolean);
      const out = await inTx(pool, async (c) => {
        const plans = await plansOf(c, req.orgId, req.body);
        const links = await linkPlan(c, req.orgId, plans); // 반영 전에 가른다(새 줄 이름·생년월일은 시트 값으로 대조)
        const o = await applyPlans(c, req.orgId, req.session.userId, plans, { remove });
        o.links = (await runLinks(c, req.orgId, req.session.userId, plans, links)).map(hideIds);
        return o;
      });
      await audit(pool, { ...me(req), action: 'roster.excel', table: 'delete_batch', rowId: out.batchId, after: { added: out.added, changed: out.changed, removed: out.removed, failed: out.failed.length, linked: out.links.filter((x) => x.done && x.kind === 'linked').length } });
      res.json(out);
    } catch (e) { excelErr(res, next, e); }
  });

  r.post('/excel/undo', async (req, res, next) => {
    try {
      const p = z.object({ batchId: z.coerce.number().int().positive() }).safeParse(req.body);
      if (!p.success) return fail(res, 400, 'school.excel_err.no_batch');
      // 규칙 ③ — 되돌리기는 줄 값만. 그 올리기로 넣은 줄에 그사이 계정이 연결됐으면 줄을 안 지운다(연결을 안 되돌림 → skipped)
      const out = await inTx(pool, async (c) => {
        const linkedNew = (await c.query(
          `SELECT m.id FROM delete_batch_item i JOIN membership m ON m.id = i.row_id
            WHERE i.batch_id = $1 AND i.table_name = 'membership' AND i.column_name IS NULL AND m.org_id = $2 AND m.deleted_at IS NULL AND m.user_id IS NOT NULL`,
          [p.data.batchId, req.orgId])).rows.map((x) => Number(x.id));
        const o = await undoExcel(c, req.orgId, p.data.batchId);
        if (linkedNew.length) {
          await c.query(`UPDATE membership SET deleted_at = NULL WHERE id = ANY($1::bigint[]) AND org_id = $2`, [linkedNew, req.orgId]);
          o.undone -= linkedNew.length;
          o.skipped.push(...linkedNew.map((id) => ({ table: 'membership', rowId: id, column: null, linked: true })));
        }
        return o;
      });
      await audit(pool, { ...me(req), action: 'roster.excel-undo', table: 'delete_batch', rowId: p.data.batchId, after: { undone: out.undone, skipped: out.skipped.length } });
      res.json(out);
    } catch (e) { excelErr(res, next, e); }
  });

  // ── 엑셀 ─────────────────────────────────────────
  r.get('/template', async (req, res, next) => {
    try {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('명단');
      ws.addRow(['이름', 'ID', '역할', '담임/전담', '반']);
      ws.addRow(['홍길동', '홍길동', '교직원', '담임', '3-1']);
      ws.addRow(['(예시 줄은 지우고 채우세요. 역할: 기관관리자·교직원·보기만 / 담임·전담·비교과는 비워도 됩니다. ID 를 비우면 이름이 ID 가 됩니다. 「반」은 선택 — 3-1 꼴로 적으면 그 반 담임으로 붙고, 비워도 됩니다)']);
      ws.getRow(1).font = { bold: true };
      ws.columns.forEach((c, i) => (c.width = [14, 16, 14, 14, 10][i]));
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('명단 양식.xlsx')}`);
      res.send(Buffer.from(await wb.xlsx.writeBuffer()));
    } catch (e) {
      next(e);
    }
  });

  // 올린 파일을 읽어 열 이름 + 줄만 돌려준다(저장 안 함). 열 맞추기는 화면이 하고 /import 로 보낸다.
  r.post('/import/preview', express.raw({ type: () => true, limit: '2mb' }), async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: '파일이 비어 있습니다' });
      const wb = new ExcelJS.Workbook();
      try {
        await wb.xlsx.load(req.body);
      } catch {
        return res.status(400).json({ error: '엑셀(.xlsx) 파일을 읽지 못했습니다' });
      }
      const ws = wb.worksheets[0];
      if (!ws) return res.status(400).json({ error: '시트가 없습니다' });
      const cell = (v) => {
        if (v == null) return '';
        if (typeof v === 'object') return String(v.text ?? v.result ?? (v.richText ? v.richText.map((x) => x.text).join('') : '')).trim();
        return String(v).trim();
      };
      const all = [];
      ws.eachRow({ includeEmpty: false }, (row) => {
        if (all.length > MAX_ROWS) return;
        const vals = [];
        for (let c = 1; c <= Math.min(MAX_COLS, ws.columnCount); c++) vals.push(cell(row.getCell(c).value));
        if (vals.some(Boolean)) all.push(vals);
      });
      if (all.length < 2) return res.status(400).json({ error: '머리 줄 아래에 사람 줄이 없습니다' });
      const headers = all[0];
      const guess = (names) => headers.findIndex((h) => names.some((n) => h.replace(/\s/g, '').includes(n)));
      res.json({
        headers,
        rows: all.slice(1, MAX_ROWS + 1),
        truncated: all.length > MAX_ROWS + 1,
        ...(limitWarnings(await loadConfig(pool, req.orgId), { rosterRows: all.length - 1 }).length ? { warnings: limitWarnings(await loadConfig(pool, req.orgId), { rosterRows: all.length - 1 }) } : {}),
        mapping: { name: guess(['이름', '성명']), loginId: guess(['ID', 'id', '아이디']), role: guess(['역할']), duty: guess(['담임', '전담']), classroom: guess(['반']) },
      });
    } catch (e) {
      next(e);
    }
  });

  // 줄별로 만든다. 못 읽은 줄은 거부하지 않고 줄 번호와 이유를 돌려준다(나머지는 그대로 만든다).
  // 응답의 temp 는 한 번뿐 — 「ID·임시 비밀번호」 목록은 화면이 이 응답으로 내려받게 만든다.
  r.post('/import', async (req, res, next) => {
    try {
      const p = z.object({ rows: z.array(z.object({ name: z.string().max(200), loginId: z.string().max(200).optional(), role: z.string().max(50).optional(), duty: z.string().max(50).optional(), classroom: z.string().max(50).optional() })).max(MAX_ROWS), confirm: z.boolean().optional() }).safeParse(req.body);
      if (!p.success) return res.status(400).json({ error: '입력을 확인해 주세요' });
      const cfg = await loadConfig(pool, req.orgId);
      const warnings = limitWarnings(cfg, { rosterRows: p.data.rows.length });
      const results = [];
      // 목록 밖 담당 구분(오타) — 수위가 재확인이면 한 번 되묻고(아무것도 만들지 않음) confirm 으로 다시 오면 만든다. 끔이면 말없이.
      const dutyLevel = (await getRuleLevels(pool, req.orgId)).duty_unknown;
      const odd = p.data.rows.map((raw, i) => ({ line: i + 1, name: (raw.name || '').trim(), duty: dutyFromText(cfg, (raw.duty || '').trim()) })).filter((x) => x.duty && !dutyKnown(cfg, x.duty));
      if (odd.length && dutyLevel === '재확인' && !p.data.confirm) {
        return res.status(409).json({ needConfirm: true, odd: odd.map((x) => ({ ...x, msg: dutyWarnings(cfg, x.duty)[0].msg })), duties: cfg.duties });
      }
      // argon2 해시가 줄당 ~80ms 라 1000줄 77초 — 8줄씩 묶어 동시에 만든다(결과는 줄 순서 그대로). 같은 ID 가 한 묶음에 겹치면 어느 줄이 이길지는 정해지지 않고 한 줄만 만들어진다.
      const term = await currentTerm(pool, req.orgId);
      const doRow = async (raw, i) => {
        const line = i + 1;
        const name = (raw.name || '').trim();
        const loginId = (raw.loginId || '').trim() || name;
        const role = (raw.role || '').trim() || '교직원';
        const dutyText = (raw.duty || '').trim();
        // 담임·전담/비교과는 옛 말 그대로 읽고, 그 밖의 글은 기관 목록에서 찾는다. 목록에 없어도 거부하지 않고 줄에 경고를 붙인다.
        const duty = dutyFromText(cfg, dutyText);
        const bad = !name ? '이름이 비었습니다' : !ID_RE.test(loginId) ? 'ID 에 쓸 수 없는 글자가 있습니다' : !ROLES.includes(role) ? `역할을 알 수 없습니다(${ROLES.join('·')})` : duty === undefined ? '담임/전담 칸을 알 수 없습니다' : null;
        if (bad) {
          return { line, name, loginId, ok: false, error: bad };
        }
        let a = await createAccount(pool, { orgId: req.orgId, name, loginId, role, duty });
        const dw = dutyLevel === '끔' ? [] : dutyWarnings(cfg, duty);
        if (a.error) return { line, name, loginId, ok: false, error: a.error };
        // 선택 열 「반」: 있는 반이면 그 반 담임으로 붙인다. 없는 반이면 사람은 받고 못 찾았다고만 알린다.
        const room = (raw.classroom || '').trim();
        let classroom;
        if (room) {
          const m = room.match(/^(\d{1,2})\s*(?:학년|-|\s)\s*(\d{1,2})\s*(?:반)?$/);
          const hit = m && (await pool.query(`UPDATE classroom SET homeroom_membership_id = $4 WHERE org_id = $1 AND term_id = $2 AND grade = $3 AND class_no = $5 AND deleted_at IS NULL RETURNING id`, [req.orgId, term.id, Number(m[1]), a.membershipId, Number(m[2])])).rows[0];
          classroom = hit ? { text: room, found: true } : { text: room, found: false };
        }
        return { line, name, loginId, role, ok: true, temp: a.temp, ...(dw.length ? { warnings: dw } : {}), ...(classroom ? { classroom } : {}) };
      };
      const rows = p.data.rows;
      for (let i = 0; i < rows.length; i += 8) results.push(...(await Promise.all(rows.slice(i, i + 8).map((raw, j) => doRow(raw, i + j)))));
      const made = results.filter((x) => x.ok).length;
      await audit(pool, { ...me(req), action: 'roster.import', table: 'membership', after: { made, failed: results.length - made } });
      const classMissing = results.filter((x) => x.classroom && !x.classroom.found).map((x) => ({ line: x.line, name: x.name, classroom: x.classroom.text }));
      res.json(withWarnings({ results, made, failed: results.length - made, classMissing }, warnings));
    } catch (e) {
      next(e);
    }
  });


  // ── 일괄 연결(T-1322b②-D) — 계정 여럿을 명단 줄에 한 번에 잇는다. 줄마다 거래를 따로 걸어 한 줄이 막혀도 나머지는 간다.
  //   입력 { rows:[{ membershipId?|name, loginId }], concurrent? } → { results:[{ index, membershipId, name, loginId, group, code?, msg, ... }], counts:{ linked, pending, check } }
  //   group: linked(연결됨) · pending(다른 학교 재직 → 전출 요청 보냄, 승인 대기 · requestId·expiresAt) · check(확인 필요 — code 와 한 줄 msg)
  //   보내는 학교가 자동 승인을 켜 둔 전출 요청은 그 자리에서 연결되어 group linked + autoApproved. 경고 판정은 「아이디로 연결」과 같은 matchPerson.
  const bulkRow = z.object({
    membershipId: z.coerce.number().int().positive().optional().catch(undefined),
    name: z.string().trim().max(50).optional().catch(undefined),
    loginId: z.string().trim().max(200).optional().catch(undefined),
  });
  const bulkLinkIn = z.object({ rows: z.array(z.unknown()).min(1).max(MAX_ROWS), concurrent: z.boolean().optional() });
  const bulkOne = async (c, orgId, by, raw, concurrent) => {
    const row = bulkRow.parse(raw ?? {});
    const base = { membershipId: row.membershipId ?? null, name: row.name ?? '', loginId: row.loginId ?? '' };
    const check = (code, extra = {}) => ({ ...base, group: 'check', code, msg: t(`roster.bulk_link.${code}`), ...extra });
    if (!ID_RE.test(base.loginId)) return check('bad_input');
    let ln;
    if (row.membershipId) ln = await lineFor(row.membershipId, orgId, c);
    else if (base.name) {
      const cand = (await c.query(
        `SELECT id, user_id, role, name, birth_date FROM membership
          WHERE org_id = $1 AND deleted_at IS NULL AND role <> $2 AND user_id IS NULL AND status = ANY($3::text[])`, [orgId, ROLE.SYSADMIN, MEMBER_STATUS_LOGIN])).rows.filter((x) => sameName(x.name, base.name));
      if (cand.length > 1) return check('line_ambiguous');
      ln = cand[0];
    } else return check('bad_input');
    if (!ln) return check('line_not_found');
    base.membershipId = Number(ln.id);
    base.name = ln.name ?? base.name;
    const user = (await c.query(`SELECT id, login_id, name FROM app_user WHERE lower(login_id) = lower($1) AND deleted_at IS NULL`, [base.loginId])).rows[0];
    if (!user) return check('account_not_found');
    if (ln.user_id != null) return check(Number(ln.user_id) === Number(user.id) ? 'already_linked' : 'line_taken');
    if ((await c.query(`SELECT 1 FROM membership WHERE user_id = $1 AND org_id = $2 AND deleted_at IS NULL`, [user.id, orgId])).rows[0]) return check('account_in_org');
    const m = await matchPerson(c, { name: ln.name, birthDate: ln.birth_date, userId: user.id });
    if (m.check?.name === false) return check('name');
    if (m.check?.birth === false) return check('birth');
    const others = m.candidates.filter((x) => x.userId !== Number(user.id));
    if (others.length) return check('other', { accounts: others.map((x) => ({ loginId: x.loginId, linkedCount: x.linkedCount })) });
    const home = await homeOrgOf(c, user.id, orgId);
    if (home != null && !concurrent) {
      const out = await requestTransfer(c, { fromOrg: home, toOrg: orgId, userId: user.id, toMembershipId: ln.id, byUserId: by });
      if (out.error) return { error: out.error, check: check('transfer_failed') };
      if (out.autoApproved) return { ...base, group: 'linked', autoApproved: true, msg: t('roster.bulk_link.linked') };
      return { ...base, group: 'pending', requestId: out.requestId, expiresAt: out.expiresAt, msg: t('roster.bulk_link.pending') };
    }
    const l = await linkAccount(c, { membershipId: ln.id, userId: user.id, byUserId: by, concurrent: home != null });
    if (l.error) return { error: l.error, check: check('link_failed', { reason: l.error }) };
    return { ...base, group: 'linked', isConcurrent: !!l.isConcurrent, msg: t('roster.bulk_link.linked') };
  };
  r.post('/bulk-link', async (req, res, next) => {
    try {
      const p = bulkLinkIn.safeParse(req.body);
      if (!p.success) return fail(res, 400, 'roster.err.bad_input');
      const results = [];
      for (const [index, raw] of p.data.rows.entries()) {
        const out = await withTx(pool, (c) => bulkOne(c, req.orgId, req.session.userId, raw, !!p.data.concurrent));
        results.push({ index, ...(out.check ?? out) });
      }
      const counts = { linked: 0, pending: 0, check: 0 };
      for (const x of results) counts[x.group]++;
      await audit(pool, { ...me(req), action: 'roster.bulk-link', table: 'membership', after: { ...counts, concurrent: !!p.data.concurrent } });
      res.json({ results, counts });
    } catch (e) {
      next(e);
    }
  });

  // 초대 코드 일괄 발급 — 계정 안 이어진 줄(또는 받은 lineIds)마다 코드 하나. 살아 있는 코드가 있으면 그대로 돌려준다(단건 /:mid/invite 는 늘 새로 낸다)
  // → { items: [{ lineId, name, code, expiresAt }], xlsx: base64, xlsxName }
  r.post('/invites/bulk', async (req, res, next) => {
    try {
      const p = z.object({ lineIds: z.array(idParam).max(2000).optional() }).safeParse(req.body ?? {});
      if (!p.success) return fail(res, 400, 'roster.err.bad_input');
      const items = await withTx(pool, async (c) => {
        const lines = (await c.query(
          `SELECT id, name FROM membership
            WHERE org_id = $1 AND user_id IS NULL AND deleted_at IS NULL AND role <> $2 AND ($3::bigint[] IS NULL OR id = ANY($3::bigint[]))
            ORDER BY id`, [req.orgId, ROLE.SYSADMIN, p.data.lineIds ?? null])).rows;
        const out = [];
        for (const ln of lines) {
          let live = (await c.query(
            `SELECT code, expires_at FROM invite_code WHERE membership_id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`, [ln.id])).rows[0];
          if (!live) {
            const i = await issueInvite(c, { orgId: req.orgId, membershipId: ln.id, byUserId: req.session.userId });
            if (i.error) continue;
            live = { code: i.code, expires_at: i.expiresAt };
            await audit(c, { ...me(req), action: 'roster.invite', table: 'membership', rowId: ln.id });
          }
          out.push({ lineId: Number(ln.id), name: ln.name, code: live.code, expiresAt: live.expires_at });
        }
        return out;
      });
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet(t('roster.invite_bulk.sheet'));
      ws.addRow([t('roster.invite_bulk.col_name'), t('roster.invite_bulk.col_code'), t('roster.invite_bulk.col_expires')]);
      for (const x of items) ws.addRow([x.name, x.code, new Date(x.expiresAt).toISOString().slice(0, 10)]);
      ws.getRow(1).font = { bold: true };
      ws.columns.forEach((c, i) => (c.width = [16, 14, 14][i]));
      res.json({ items, xlsx: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64'), xlsxName: t('roster.invite_bulk.file') });
    } catch (e) {
      next(e);
    }
  });

  return r;
}
