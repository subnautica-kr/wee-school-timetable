import express from 'express';
import { z } from 'zod';
import { requireLogin } from '../guard.js';
import { fail } from '../fail.js';
import { t } from '../../shared/text/index.js';
import { VISIBLE_SQL, NEWS_KEEP_DAYS } from '../notify.js';
import { ROLE, MEMBER_STATUS } from '../../shared/codes.js';

// 알림(종) — 로그인한 사람 본인의 것만. 기관 경로가 아니다(총괄관리자도 종이 있다).
// GET /     → { badge, unread, todos: [{ kind, count, text, tab }], items: [{ id, kind, text, link, createdAt, read }] }
// POST /read → { ids: [...] } 또는 { all: true } — 내가 볼 수 있는 소식만 읽음 표시. 남의 것이 하나라도 끼면 404.
// 할 일은 소식이 아니라 지금 기다리는 건수다(누가 처리하면 모두에게서 사라진다 · 읽음 없음).
const readBody = z.union([z.object({ all: z.literal(true) }), z.object({ ids: z.array(z.coerce.number().int().positive()).min(1).max(200) })]);

export function notificationsRouter(pool) {
  const r = express.Router();
  r.use(requireLogin);
  const who = (req) => [req.session.userId, req.session.role === ROLE.SYSADMIN, ROLE.ORG_ADMIN, MEMBER_STATUS.ACTIVE];
  const recent = `n.created_at > now() - interval '${NEWS_KEEP_DAYS} days'`;
  const where = `${VISIBLE_SQL} AND ${recent}`; // 볼 수 있는 것 + 90일 안

  r.get('/', async (req, res, next) => {
    try {
      const me = who(req);
      const items = (await pool.query(
        `SELECT n.id, n.kind, n.text, n.link, n.created_at, (nr.user_id IS NOT NULL) AS read
           FROM notification n LEFT JOIN notification_read nr ON nr.notification_id = n.id AND nr.user_id = $1
          WHERE ${where} ORDER BY n.created_at DESC, n.id DESC LIMIT 50`, me)).rows;
      const unread = (await pool.query(
        `SELECT count(*)::int AS n FROM notification n
          WHERE ${where} AND NOT EXISTS (SELECT 1 FROM notification_read nr WHERE nr.notification_id = n.id AND nr.user_id = $1)`, me)).rows[0].n;
      const todos = [];
      if (req.session.role === ROLE.ORG_ADMIN && req.session.orgId) {
        const org = req.session.orgId;
        const signup = (await pool.query(
          `SELECT count(*)::int AS n FROM unlinked_account WHERE org_id = $1 AND reason = 'pending_approval' AND resolved_at IS NULL AND expires_at > now()`, [org])).rows[0].n;
        const move = (await pool.query(
          `SELECT count(*)::int AS n FROM transfer_request WHERE from_org = $1 AND status = 'waiting' AND expires_at > now()`, [org])).rows[0].n;
        if (signup) todos.push({ kind: 'signup', count: signup, text: t('notify.todo.signup', { 건수: signup }), tab: 'roster' });
        if (move) todos.push({ kind: 'transfer', count: move, text: t('notify.todo.transfer', { 건수: move }), tab: 'roster' });
      }
      const todoSum = todos.reduce((a, x) => a + x.count, 0);
      res.json({
        badge: unread + todoSum, unread, todos,
        items: items.map((x) => ({ id: Number(x.id), kind: x.kind, text: x.text, link: x.link, createdAt: x.created_at, read: x.read })),
      });
    } catch (e) { next(e); }
  });

  r.post('/read', async (req, res, next) => {
    try {
      const p = readBody.safeParse(req.body);
      if (!p.success) return fail(res, 400, 'notify.err.bad_input');
      const me = who(req);
      if (p.data.all) {
        await pool.query(
          `INSERT INTO notification_read (notification_id, user_id) SELECT n.id, $1 FROM notification n WHERE ${where} ON CONFLICT DO NOTHING`, me);
        return res.json({ ok: true });
      }
      const ids = [...new Set(p.data.ids)];
      const ok = (await pool.query(`SELECT n.id FROM notification n WHERE n.id = ANY($5::bigint[]) AND ${where}`, [...me, ids])).rows.map((x) => Number(x.id));
      if (ok.length !== ids.length) return fail(res, 404, 'notify.err.not_found');
      await pool.query(`INSERT INTO notification_read (notification_id, user_id) SELECT unnest($2::bigint[]), $1 ON CONFLICT DO NOTHING`, [me[0], ids]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return r;
}
