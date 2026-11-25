import express from 'express';
import { z } from 'zod';
import { requireOrgAction } from '../guard.js';
import { audit } from '../audit.js';
import { CLEAR_LEVELS, KINDS, clearTerm, inTx, preview, previewClear, restoreBatch, undoNewSemester, undoNewSemesterCheck } from '../cascade.js';

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
          WHERE b.org_id = $1 AND b.kind <> 'excel' ORDER BY b.created_at DESC, b.id DESC LIMIT 200`,
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

  // 학기 비우기(T-1212): 단계 timetable(시간표·칸) / hours(+시수표·고정) / classes(+반)
  const level = z.enum(CLEAR_LEVELS);
  const fail = (res, e) => (e.expose ? res.status(e.status).json({ error: e.message }) : null);

  r.get('/terms/:termId/clear-preview', manage, async (req, res, next) => {
    try {
      const tid = id.safeParse(req.params.termId);
      const lv = level.safeParse(req.query.level);
      if (!tid.success || !lv.success) return notFound(res);
      const out = await previewClear(pool, req.orgId, tid.data, lv.data);
      out ? res.json(out) : notFound(res);
    } catch (e) { next(e); }
  });

  r.post('/terms/:termId/clear', manage, async (req, res, next) => {
    try {
      const tid = id.safeParse(req.params.termId);
      const p = z.object({ level, confirm: z.string() }).safeParse(req.body ?? {});
      if (!tid.success) return notFound(res);
      // 본문이 틀려도 남의 기관·없는 학기는 먼저 404(존재를 흘리지 않는다)
      if (!(await pool.query(`SELECT 1 FROM term WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [tid.data, req.orgId])).rows[0]) return notFound(res);
      if (!p.success) return res.status(400).json({ error: '단계와 확인 글자(학기 이름)를 보내 주세요' });
      const out = await inTx(pool, (c) => clearTerm(c, req.orgId, tid.data, p.data.level, p.data.confirm.trim(), req.session.userId));
      if (!out) return notFound(res);
      await audit(pool, { orgId: req.orgId, userId: req.session.userId, action: 'term.clear', table: 'term', rowId: tid.data, after: { name: out.label, level: out.level, batch: out.batchId } });
      res.json({ ok: true, ...out });
    } catch (e) { fail(res, e) ?? next(e); }
  });

  // 방금 연 학기 되돌리기: GET = 가능한지(ok·reason) · POST = 실행(안 되면 409 + 이유)
  r.get('/terms/undo-new-semester', manage, async (req, res, next) => {
    try { res.json(await undoNewSemesterCheck(pool, req.orgId)); } catch (e) { next(e); }
  });

  r.post('/terms/undo-new-semester', manage, async (req, res, next) => {
    try {
      const out = await inTx(pool, (c) => undoNewSemester(c, req.orgId, req.session.userId));
      await audit(pool, { orgId: req.orgId, userId: req.session.userId, action: 'term.undo_new_semester', table: 'term', rowId: out.current.id, before: out.current, after: { reopened: out.reopened, batch: out.removed.batchId } });
      res.json({ ok: true, removed: out.current, reopened: out.reopened, batchId: out.removed.batchId });
    } catch (e) { fail(res, e) ?? next(e); }
  });

  return r;
}
