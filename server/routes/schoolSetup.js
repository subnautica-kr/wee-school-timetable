import express from 'express';
import { z } from 'zod';
import { requireOrgAction } from '../guard.js';
import { audit } from '../audit.js';
import { inTx } from '../cascade.js';
import { fail } from '../fail.js';
import { loadConfig } from '../orgConfig.js';
import { weekPeriods } from '../../shared/periods.js';
import { applyPlans, makeWorkbook, markErrors, planSheet, readWorkbook, rosterSpec, undoExcel, gradeSpec, roomsSpec } from '../export/import.js';
import { loadsSpec, pinsSpec } from '../export/loadsImport.js';
import { currentTerm } from './school.js';
import { expandMaster, isIncomplete } from './loads.js';
import { t } from '../../shared/text/index.js';

// 「학교 자료 넣기」 일곱 단계의 서버(T-1308). 단계마다 내려받기·올리기(올리면 바로 저장 + 되돌리기) · 「넣은 것 확인」은 서버가 센다.
// 올리기 틀은 엑셀 바닥(import.js)을 그대로 부른다 — 이 파일은 단계 → 스펙 연결, 권한, 세기만 한다.
// 길(모두 /api/orgs/:orgId 아래):
//   GET  /school-setup/status               단계별 건수·빈 것 + 점검 항목(넣은 것 확인)
//   GET  /school-setup/:step/file           지금 값이 든 엑셀 양식(step: school·rooms·roster·loads·pins)
//   POST /school-setup/:step/preview        올린 파일 읽어 보기(쓰지 않음)
//   POST /school-setup/:step/apply          올린 파일 바로 저장. 못 읽은 줄이 있으면 409 needConfirm → ?partial=1 로 다시
//   POST /school-setup/undo  { batchId }    방금 올린 것 되돌리기
const STEPS = {
  school: { spec: gradeSpec, perm: 'school.manage' },
  rooms: { spec: roomsSpec, perm: 'school.manage' },
  roster: { spec: rosterSpec, perm: 'school.manage' },
  loads: { spec: loadsSpec, perm: 'timetable.edit' },
  pins: { spec: pinsSpec, perm: 'timetable.edit' },
};
const ITEM_LIMIT = 50; // 점검 항목은 종류마다 앞 50개만 싣고 건수는 전체로 센다

const nf = (res) => res.status(404).json({ error: '없습니다' }); // 문구-예외: 앱 가드와 같은 404 본문
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function schoolSetupRouter(pool) {
  const r = express.Router({ mergeParams: true });
  const view = requireOrgAction('timetable.view');
  const rawXlsx = express.raw({ type: () => true, limit: '5mb' });
  const excelErr = (res, next, e) => (e.status && e.expose ? res.status(e.status).json({ error: e.message, code: e.code }) : next(e));
  // 단계 이름으로 스펙을 고르고 그 단계 권한으로 거른다. 모르는 단계·권한 없음은 404(앱 가드와 같다)
  const gate = (req, res, next) => {
    const st = Object.hasOwn(STEPS, req.params.step) ? STEPS[req.params.step] : null;
    if (!st) return nf(res);
    req.step = st;
    return requireOrgAction(st.perm)(req, res, next);
  };
  const lineCount = (plans) => new Set(plans.flatMap((p) => p.errors.map((e) => e.line))).size;
  const planOf = async (db, orgId, spec, buf) => {
    const book = await readWorkbook(buf);
    if (!book[spec.sheet]) throw Object.assign(new Error(t('school.excel_err.no_sheet', { 시트: spec.sheet })), { status: 400, expose: true, code: 'school.excel_err.no_sheet' });
    return planSheet(db, orgId, spec, book[spec.sheet]);
  };

  // ── 넣은 것 확인 ──
  async function status(orgId) {
    const term = await currentTerm(pool, orgId);
    const cfg = await loadConfig(pool, orgId);
    const pc = (await pool.query(`SELECT period_config FROM org WHERE id = $1`, [orgId])).rows[0]?.period_config ?? {};
    const rooms = (await pool.query(`SELECT id, grade, class_no, homeroom_membership_id FROM classroom WHERE org_id = $1 AND term_id = $2 AND deleted_at IS NULL ORDER BY grade, class_no`, [orgId, term.id])).rows;
    const people = (await pool.query(`SELECT id, name, duty FROM membership WHERE org_id = $1 AND deleted_at IS NULL AND status = '사용' AND role <> '시스템관리자' ORDER BY name, id`, [orgId])).rows; // 문구-예외: 저장 값
    const special = (await pool.query(`SELECT id, name FROM special_room WHERE org_id = $1 AND deleted_at IS NULL ORDER BY id`, [orgId])).rows;
    const lines = (await pool.query(`SELECT id, membership_id, second_membership_id, second_hours, subject_id, classroom_id, special_room_id, weekly_hours FROM teaching_load WHERE org_id = $1 AND term_id = $2 AND deleted_at IS NULL ORDER BY id`, [orgId, term.id])).rows
      .map((l) => ({ ...l, id: Number(l.id), classroom_id: l.classroom_id == null ? null : Number(l.classroom_id), membership_id: l.membership_id == null ? null : Number(l.membership_id), weekly_hours: Number(l.weekly_hours) || 0 }));
    const pinN = (await pool.query(`SELECT count(*)::int AS n FROM pin WHERE org_id = $1 AND term_id = $2 AND deleted_at IS NULL`, [orgId, term.id])).rows[0].n;
    const ttN = (await pool.query(`SELECT count(*)::int AS n FROM timetable WHERE org_id = $1 AND term_id = $2 AND deleted_at IS NULL`, [orgId, term.id])).rows[0].n;

    const days = cfg.weekdays.length;
    const grades = [...new Set(rooms.map((c) => c.grade))];
    const slotsOf = (grade) => weekPeriods(pc, grade, days);
    const maxSlots = Math.max(0, ...grades.map(slotsOf)) || weekPeriods(pc, 0, days);
    const eff = expandMaster(lines, rooms.map((c) => ({ ...c, id: Number(c.id) })));

    const issues = {};
    // 주당 칸보다 시수 많은 반
    const sumByClass = new Map();
    for (const l of eff) sumByClass.set(l.classroom_id, (sumByClass.get(l.classroom_id) ?? 0) + l.weekly_hours);
    issues.over_class = rooms.filter((c) => (sumByClass.get(Number(c.id)) ?? 0) > slotsOf(c.grade))
      .map((c) => ({ id: Number(c.id), grade: c.grade, class_no: c.class_no, hours: sumByClass.get(Number(c.id)), cap: slotsOf(c.grade) }));
    // 들어갈 칸보다 맡은 시수 많은 교사 — 둘째 교사는 함께 시수(비우면 전부)만큼
    const sumByTeacher = new Map();
    const addT = (id, h) => { if (id != null) sumByTeacher.set(Number(id), (sumByTeacher.get(Number(id)) ?? 0) + h); };
    for (const l of eff) { addT(l.membership_id, l.weekly_hours); addT(l.second_membership_id, l.second_hours ?? l.weekly_hours); }
    issues.over_teacher = people.filter((p) => (sumByTeacher.get(Number(p.id)) ?? 0) > maxSlots)
      .map((p) => ({ id: Number(p.id), name: p.name, hours: sumByTeacher.get(Number(p.id)), cap: maxSlots }));
    // 교사·교과(·시수)가 빈 줄
    issues.incomplete = lines.filter(isIncomplete).map((l) => ({ id: l.id, no_teacher: !l.membership_id, no_subject: !l.subject_id, no_hours: !(l.weekly_hours > 0) }));
    // 받을 수 있는 수업보다 많은 특별실 — 한 번에 한 반, 주 칸 수 기준
    const sumByRoom = new Map();
    for (const l of eff) if (l.special_room_id) sumByRoom.set(Number(l.special_room_id), (sumByRoom.get(Number(l.special_room_id)) ?? 0) + l.weekly_hours);
    issues.over_room = special.filter((s) => (sumByRoom.get(Number(s.id)) ?? 0) > maxSlots).map((s) => ({ id: Number(s.id), name: s.name, hours: sumByRoom.get(Number(s.id)), cap: maxSlots }));
    // 담임 없는 반 · 반 없는 담임
    issues.no_homeroom = rooms.filter((c) => !c.homeroom_membership_id).map((c) => ({ id: Number(c.id), grade: c.grade, class_no: c.class_no }));
    const homeIds = new Set(rooms.map((c) => Number(c.homeroom_membership_id)).filter(Boolean));
    issues.no_class = people.filter((p) => p.duty === '담임' && !homeIds.has(Number(p.id))).map((p) => ({ id: Number(p.id), name: p.name })); // 문구-예외: 저장 값
    const checks = Object.entries(issues).map(([key, items]) => ({ key, label: t(`school.setup_issue.${key}`), count: items.length, items: items.slice(0, ITEM_LIMIT) }));
    const issueTotal = checks.reduce((a, c) => a + c.count, 0);

    const base = [
      { key: 'school', count: grades.length, extra: { classes: rooms.length } },
      { key: 'rooms', count: special.length, optional: true },
      { key: 'roster', count: people.length },
      { key: 'loads', count: lines.length },
      { key: 'pins', count: pinN, optional: true },
    ].map((s, i) => ({ no: i + 1, ...s, label: t(`school.setup_step.${s.key}`), empty: s.count === 0, done: s.count > 0 }));
    const must = base.filter((s) => !s.optional);
    const filled = must.every((s) => s.done);
    const steps = [
      ...base,
      { no: 6, key: 'check', label: t('school.setup_step.check'), count: issueTotal, empty: false, done: filled && issueTotal === 0 },
      { no: 7, key: 'generate', label: t('school.setup_step.generate'), count: ttN, empty: ttN === 0, done: ttN > 0 },
    ];
    return { term: { id: Number(term.id), year: term.year, semester: term.semester }, steps, checks, issueTotal, ready: filled };
  }

  r.get('/school-setup/status', view, async (req, res, next) => {
    try { res.json(await status(req.orgId)); } catch (e) { next(e); }
  });

  // ── 단계별 내려받기 ──
  r.get('/school-setup/:step/file', gate, async (req, res, next) => {
    try {
      const { spec } = req.step;
      await currentTerm(pool, req.orgId);
      const rows = await spec.rows(pool, req.orgId, await spec.context(pool, req.orgId));
      const name = t('school.setup_file.name', { 단계: t(`school.setup_step.${req.params.step}`) });
      res.set('Content-Type', XLSX_MIME);
      res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.send(await makeWorkbook([spec], { [spec.name]: rows }));
    } catch (e) { next(e); }
  });

  const sheetJson = (p) => ({ sheet: p.sheet, name: p.spec.name, add: p.add.length, change: p.change.length, remove: p.remove.length, same: p.same.length, errors: p.errors });
  r.post('/school-setup/:step/preview', gate, rawXlsx, async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return fail(res, 400, 'school.excel_err.empty_file');
      await currentTerm(pool, req.orgId);
      const p = await planOf(pool, req.orgId, req.step.spec, req.body);
      res.json({ ...sheetJson(p), ...(p.errors.length ? { marked: (await markErrors(req.body, [p])).toString('base64'), markedName: t('school.excel.file_marked') } : {}) });
    } catch (e) { excelErr(res, next, e); }
  });

  // ── 올리면 바로 저장 ──
  r.post('/school-setup/:step/apply', gate, rawXlsx, async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return fail(res, 400, 'school.excel_err.empty_file');
      const { spec } = req.step;
      await currentTerm(pool, req.orgId);
      const partial = req.query.partial === '1';
      let held = null;
      const out = await inTx(pool, async (c) => {
        const p = await planOf(c, req.orgId, spec, req.body);
        const todo = p.add.length + p.change.length + p.remove.length;
        if (p.errors.length && (!todo || !partial)) { held = { p, todo }; return null; }
        if (!todo) return { batchId: null, added: 0, changed: 0, removed: 0, failed: [], same: p.same.length, errors: [] };
        const done = await applyPlans(c, req.orgId, req.session.userId, [p], { remove: true });
        return { ...done, same: p.same.length, errors: p.errors };
      });
      if (held) {
        const extra = { errors: held.p.errors, readable: held.todo, marked: (await markErrors(req.body, [held.p])).toString('base64'), markedName: t('school.excel.file_marked') };
        return held.todo
          ? fail(res, 409, 'school.setup_err.partial', { 읽은: held.todo, 못읽은: lineCount([held.p]) }, { needConfirm: true, ...extra })
          : fail(res, 400, 'school.setup_err.unreadable', {}, extra);
      }
      if (out.batchId) await audit(pool, { orgId: req.orgId, userId: req.session.userId, action: `school-setup.${req.params.step}`, table: 'delete_batch', rowId: out.batchId, after: { added: out.added, changed: out.changed, removed: out.removed, failed: out.failed.length } });
      res.json({ step: req.params.step, ...out });
    } catch (e) { excelErr(res, next, e); }
  });

  // 되돌리기 — 올린 단계의 권한이 아니라 두 권한 중 하나(둘 다 기관 관리자 몫)
  r.post('/school-setup/undo', requireOrgAction('school.manage'), async (req, res, next) => {
    try {
      const p = z.object({ batchId: z.coerce.number().int().positive() }).safeParse(req.body);
      if (!p.success) return fail(res, 400, 'school.excel_err.no_batch');
      const out = await inTx(pool, (c) => undoExcel(c, req.orgId, p.data.batchId));
      await audit(pool, { orgId: req.orgId, userId: req.session.userId, action: 'school-setup.undo', table: 'delete_batch', rowId: p.data.batchId, after: { undone: out.undone, skipped: out.skipped.length } });
      res.json(out);
    } catch (e) { excelErr(res, next, e); }
  });

  return r;
}
