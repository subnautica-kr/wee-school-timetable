import express from 'express';
import { z } from 'zod';
import { requireOrgAction } from '../guard.js';
import { audit } from '../audit.js';
import { KINDS, inTx, preview, restoreBatch } from '../cascade.js';

// 지우기 뼈대 공통 경로(T-1211): 지우기 전 영향 세기 · 휴지통(지운 묶음) 목록 · 묶음 되살리기.
// 개별 대상 지우기는 각 경로(반·교과·특별실·시간표 DELETE)가 removeWithCascade 로 한다.
const id = z.coerce.number().int().positive();
const notFound = (res) => res.status(404).json({ error: '없습니다' });

export function trashRouter(pool) {
  const r = express.Router({ mergeParams: true });
  const manage = requireOrgAction('school.manage');

  r.get('/delete-preview', manage, async (req, res, next) => {
    try {
      const p = z.object({ kind: z.enum(KINDS), id }).safeParse(req.query);
      if (!p.success) return notFound(res);
      const out = await preview(pool, req.orgId, p.data.kind, p.data.id);
      out ? res.json(out) : notFound(res);
    } catch (e) { next(e); }
  });

  r.get('/trash', manage, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT b.id, b.kind, b.target_id, b.label, b.summary AS effects, b.created_at, b.restored_at, u.name AS created_by_name
           FROM delete_batch b LEFT JOIN app_user u ON u.id = b.created_by
          WHERE b.org_id = $1 ORDER BY b.created_at DESC, b.id DESC LIMIT 200`,
        [req.orgId],
      );
      res.json(rows);
    } catch (e) { next(e); }
  });

  r.post('/trash/:bid/restore', manage, async (req, res, next) => {
    try {
      const bid = id.safeParse(req.params.bid);
      if (!bid.success) return notFound(res);
      const out = await inTx(pool, (c) => restoreBatch(c, req.orgId, bid.data));
      if (!out) return notFound(res);
      await audit(pool, { orgId: req.orgId, userId: req.session.userId, action: 'trash.restore', table: 'delete_batch', rowId: out.batchId, after: { name: out.label } });
      res.json({ ok: true, ...out });
    } catch (e) { e.expose ? res.status(e.status).json({ error: e.message }) : next(e); }
  });

  return r;
}
