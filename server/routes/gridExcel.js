// 시간표 격자 엑셀 왕복 길목(T-1304b) — 내려받기 · 미리 보기(쓰지 않음) · 반영(트랜잭션) · 되돌리기. 본보기는 roster.js 의 명단 엑셀.
// 확정본 반영은 ?confirm=1 없으면 409 needConfirm(schoolSetup.js 꼴). 보관 학기 POST 는 app.js 가 먼저 409 로 막는다.
import express from 'express';
import { z } from 'zod';
import { requireOrgAction } from '../guard.js';
import { applyLevels, getRuleLevels } from '../rules.js';
import { findOverlapsFor } from '../violations.js';
import { audit } from '../audit.js';
import { inTx } from '../cascade.js';
import { fail } from '../fail.js';
import { t } from '../../shared/text/index.js';
import { undoExcel } from '../export/import.js';
import { applyGrid, loadGrid, makeGridWorkbook, planGrid } from '../export/gridExcel.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CONFIRMED = '확정'; // 문구-예외: 저장 값
const CELL_COLS = 'classroom_id, weekday, period, subject_id, membership_id, second_membership_id, special_room_id';
const tidOk = z.coerce.number().int().positive();

export function gridExcelRouter(pool) {
  const r = express.Router({ mergeParams: true });
  const view = requireOrgAction('timetable.view');
  const edit = requireOrgAction('timetable.edit');
  const rawXlsx = express.raw({ type: () => true, limit: '5mb' });
  const me = (req) => ({ orgId: req.orgId, userId: req.session.userId });
  const getTt = async (req) => {
    const p = tidOk.safeParse(req.params.tid);
    if (!p.success) return null;
    return (await pool.query(`SELECT id, name, status FROM timetable WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [p.data, req.orgId])).rows[0] ?? null;
  };
  const notFound = (res) => fail(res, 404, 'grid.excel_err.no_timetable');
  const excelErr = (res, next, e) => (e.status && e.expose ? res.status(e.status).json({ error: e.message, code: e.code }) : next(e));
  const noFile = (req) => !Buffer.isBuffer(req.body) || !req.body.length;
  // 위반을 다시 세어 저장 — timetables.js recheck 와 같은 계산
  const recheck = async (orgId, ttId) => {
    const cells = (await pool.query(`SELECT ${CELL_COLS} FROM cell WHERE org_id = $1 AND timetable_id = $2 AND deleted_at IS NULL`, [orgId, ttId])).rows;
    const raw = await findOverlapsFor(pool, orgId, cells);
    await pool.query(`UPDATE timetable SET violations = $3 WHERE id = $1 AND org_id = $2`, [ttId, orgId, JSON.stringify(raw)]);
    return applyLevels(await getRuleLevels(pool, orgId), raw);
  };
  const auditEdit = async (req, tt, action, after) => {
    await audit(pool, { ...me(req), action, table: 'timetable', rowId: tt.id, after });
    if (tt.status === CONFIRMED) await audit(pool, { ...me(req), action: 'timetable.edit_confirmed', table: 'timetable', rowId: tt.id, after: { name: tt.name, excel: true } });
  };

  r.get('/timetables/:tid/grid-excel', view, async (req, res, next) => {
    try {
      const tt = await getTt(req);
      if (!tt) return notFound(res);
      const d = await loadGrid(pool, req.orgId, tt.id);
      res.set('Content-Type', XLSX_MIME);
      const name = encodeURIComponent(t('grid.excel.file', { 이름: tt.name }));
      res.set('Content-Disposition', `attachment; filename*=UTF-8''${name}`);
      res.send(await makeGridWorkbook(d));
    } catch (e) { next(e); }
  });

  r.post('/timetables/:tid/grid-excel/preview', edit, rawXlsx, async (req, res, next) => {
    try {
      const tt = await getTt(req);
      if (!tt) return notFound(res);
      if (noFile(req)) return fail(res, 400, 'school.excel_err.empty_file');
      const plan = await planGrid(pool, req.orgId, tt.id, req.body);
      res.json({ change: plan.changes.length, same: plan.same, errors: plan.errors, confirmed: tt.status === CONFIRMED });
    } catch (e) { excelErr(res, next, e); }
  });

  r.post('/timetables/:tid/grid-excel/apply', edit, rawXlsx, async (req, res, next) => {
    try {
      const tt = await getTt(req);
      if (!tt) return notFound(res);
      if (noFile(req)) return fail(res, 400, 'school.excel_err.empty_file');
      if (tt.status === CONFIRMED && req.query.confirm !== '1') return fail(res, 409, 'grid.excel_err.confirm', undefined, { needConfirm: true });
      const out = await inTx(pool, async (c) => {
        await c.query(`SELECT id FROM timetable WHERE id = $1 AND org_id = $2 FOR UPDATE`, [tt.id, req.orgId]);
        return applyGrid(c, req.orgId, req.session.userId, await planGrid(c, req.orgId, tt.id, req.body));
      });
      await auditEdit(req, tt, 'timetable.excel', { name: tt.name, batch: out.batchId, changed: out.changed, skipped: out.skipped });
      res.json({ ...out, violations: await recheck(req.orgId, tt.id) });
    } catch (e) {
      if (e.code === '23505') return fail(res, 409, 'school.excel_err.duplicate');
      excelErr(res, next, e);
    }
  });

  r.post('/timetables/:tid/grid-excel/undo', edit, async (req, res, next) => {
    try {
      const tt = await getTt(req);
      if (!tt) return notFound(res);
      const p = z.object({ batchId: z.coerce.number().int().positive() }).safeParse(req.body);
      if (!p.success) return fail(res, 400, 'school.excel_err.no_batch');
      const out = await inTx(pool, async (c) => {
        const own = (await c.query(`SELECT 1 FROM delete_batch WHERE id = $1 AND org_id = $2 AND kind = 'excel' AND target_id = $3`, [p.data.batchId, req.orgId, tt.id])).rows[0];
        if (!own) throw Object.assign(new Error(t('school.excel_err.batch_missing')), { status: 404, expose: true, code: 'school.excel_err.batch_missing' });
        return undoExcel(c, req.orgId, p.data.batchId);
      });
      await auditEdit(req, tt, 'timetable.excel-undo', { name: tt.name, batch: out.batchId, undone: out.undone, skipped: out.skipped.length });
      res.json({ ...out, violations: await recheck(req.orgId, tt.id) });
    } catch (e) {
      if (e.code === '23505') return fail(res, 409, 'grid.excel_err.conflict');
      excelErr(res, next, e);
    }
  });

  return r;
}
