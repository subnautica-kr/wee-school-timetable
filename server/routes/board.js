import express from 'express';
import { z } from 'zod';
import { requireLogin } from '../guard.js';
import { can, ROLES } from '../permissions.js';
import { audit } from '../audit.js';
import { fail } from '../fail.js';
import { notify } from '../notify.js';
import { t } from '../../shared/text/index.js';

// 도움·요청(요청 보드) 서버 — 기관 경로가 아니라 /api/board 다(총괄관리자는 기관 경로에서 404 라서).
// 글쓴이 이름·번호는 응답에 싣지 않는다 — 학교 이름과 mine(내 글인가)만.
// 보는 사람: 글쓴이 본인(늘) · 공개 범위가 허락한 쪽(아래 VIS).
const KINDS = ['bug', 'usability', 'feature', 'question'];
const VISIBILITIES = ['org_admins', 'sysadmin', 'org_and_sysadmin', 'public'];
const STAGES = ['received', 'reviewing', 'working', 'done', 'hold'];
const SYS = ROLES[0]; // 시스템관리자
const ADMIN = ROLES[1]; // 기관관리자

const id = z.coerce.number().int().positive();
const postIn = z.object({
  kind: z.enum(KINDS),
  visibility: z.enum(VISIBILITIES), // 기본값 없음 — 꼭 고른다
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20000).default(''),
  context: z.record(z.string(), z.unknown()).default({}),
});

const who = (req) => ({ uid: req.session.userId, orgId: req.session.orgId ?? null, sys: req.session.role === SYS, admin: req.session.role === ADMIN && req.session.orgId != null });

// 보는 줄 조건(p = board_post). 자리표시자 $1 보는 사람 · $2 총괄관리자인가 · $3 기관 관리자인가 · $4 내 학교
const VIS = `(p.author_user_id = $1 OR p.visibility = 'public'
  OR ($2::boolean AND p.visibility IN ('sysadmin','org_and_sysadmin'))
  OR ($3::boolean AND p.org_id = $4 AND p.visibility IN ('org_admins','org_and_sysadmin')))`;
const visArgs = (w) => [w.uid, w.sys, w.admin, w.orgId];

const COLS = `p.id, p.kind, p.visibility, p.stage, p.title, p.body, p.tags, p.group_id AS "groupId", p.context, p.created_at AS "createdAt", p.updated_at AS "updatedAt",
  o.name AS "school", (p.author_user_id = $1) AS mine,
  (SELECT count(*)::int FROM board_post c WHERE c.group_id = p.id AND c.deleted_at IS NULL) AS "groupCount",
  (SELECT count(*)::int FROM board_comment k WHERE k.post_id = p.id AND k.deleted_at IS NULL) AS "commentCount"`;

// 세로 순서: 손에 잡힌 글(검토 중·처리 중) → 접수·보류 → 완료
const ORDER = `CASE p.stage WHEN 'reviewing' THEN 0 WHEN 'working' THEN 0 WHEN 'received' THEN 1 WHEN 'hold' THEN 1 ELSE 2 END`;

// SQL 조각 상수(VIS·COLS·ORDER)만 이름으로 끼운다 — 요청 값은 전부 $n 자리표시자
const q = (sql) => sql.replaceAll('{VIS}', VIS).replaceAll('{COLS}', COLS).replaceAll('{ORDER}', ORDER);

const show = (r) => ({ ...r, id: Number(r.id), groupId: r.groupId == null ? null : Number(r.groupId) });

async function findVisible(pool, w, postId) {
  const { rows } = await pool.query(
    q(`SELECT {COLS}, p.org_id AS "orgId", p.author_user_id AS "authorId" FROM board_post p JOIN org o ON o.id = p.org_id WHERE p.id = $5 AND p.deleted_at IS NULL AND {VIS}`),
    [...visArgs(w), postId],
  );
  return rows[0] ?? null;
}

// 총괄관리자는 보이는 글 모두, 기관 관리자는 우리 학교 글 가운데 자기가 볼 수 있는 글만
const mayManage = (w, p) => w.sys || (w.admin && p.orgId != null && String(p.orgId) === String(w.orgId));

const words = (s) => [...new Set(String(s).toLowerCase().split(/[^0-9a-z가-힣]+/).filter((x) => x.length >= 2))];

export function boardRouter(pool) {
  const r = express.Router();
  r.use(requireLogin);
  const bad = (res) => fail(res, 400, 'board.err.bad_input');
  const missing = (res) => fail(res, 404, 'board.err.not_found');
  const guard = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };

  // 목록 — 내가 볼 수 있는 글(거르기: stage · kind · tag · mine=1)
  r.get('/posts', guard(async (req, res) => {
    const p = z.object({
      stage: z.enum(STAGES).optional(), kind: z.enum(KINDS).optional(), tag: z.string().trim().max(30).optional(),
      mine: z.enum(['1']).optional(), limit: z.coerce.number().int().min(1).max(200).default(100),
    }).safeParse(req.query);
    if (!p.success) return bad(res);
    const w = who(req);
    const d = p.data;
    const { rows } = await pool.query(
      q(`SELECT {COLS} FROM board_post p JOIN org o ON o.id = p.org_id
        WHERE p.deleted_at IS NULL AND {VIS}
          AND ($5::text IS NULL OR p.stage = $5) AND ($6::text IS NULL OR p.kind = $6) AND ($7::text IS NULL OR $7 = ANY(p.tags))
          AND (NOT $8::boolean OR p.author_user_id = $1)
        ORDER BY {ORDER}, p.created_at DESC, p.id DESC LIMIT $9`),
      [...visArgs(w), d.stage ?? null, d.kind ?? null, d.tag || null, d.mine === '1', d.limit],
    );
    res.json({ items: rows.map((x) => { const { body, context, ...head } = show(x); return head; }) });
  }));

  // 비슷한 글 — 제목 낱말이 겹치는 글(내가 볼 수 있는 글 가운데)
  r.get('/similar', guard(async (req, res) => {
    const p = z.object({ title: z.string().trim().min(1).max(200) }).safeParse(req.query);
    if (!p.success) return bad(res);
    const w = who(req);
    const mine = words(p.data.title);
    if (!mine.length) return res.json({ items: [] });
    const { rows } = await pool.query(
      q(`SELECT p.id, p.title, p.stage, p.kind, o.name AS school FROM board_post p JOIN org o ON o.id = p.org_id
        WHERE p.deleted_at IS NULL AND p.group_id IS NULL AND {VIS} ORDER BY p.created_at DESC LIMIT 300`),
      visArgs(w),
    );
    const need = mine.length === 1 ? 1 : 2;
    const items = rows
      .map((x) => ({ ...x, id: Number(x.id), overlap: words(x.title).filter((k) => mine.includes(k)).length }))
      .filter((x) => x.overlap >= need)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 5);
    res.json({ items });
  }));

  // 한 글 + 답글(쓴 사람은 총괄관리자/기관 관리자 구분만) + 묶인 글
  r.get('/posts/:id', guard(async (req, res) => {
    const pid = id.safeParse(req.params.id);
    if (!pid.success) return missing(res);
    const w = who(req);
    const post = await findVisible(pool, w, pid.data);
    if (!post) return missing(res);
    const cm = await pool.query(
      `SELECT c.id, c.body, c.created_at AS "createdAt", (c.author_user_id = $2) AS mine,
              EXISTS (SELECT 1 FROM membership m WHERE m.user_id = c.author_user_id AND m.role = $3) AS "bySysadmin"
         FROM board_comment c WHERE c.post_id = $1 AND c.deleted_at IS NULL ORDER BY c.created_at, c.id`,
      [pid.data, w.uid, SYS],
    );
    const kids = await pool.query(
      q(`SELECT p.id, p.title, p.stage FROM board_post p WHERE p.group_id = $5 AND p.deleted_at IS NULL AND {VIS} ORDER BY p.created_at`),
      [...visArgs(w), pid.data],
    );
    const { orgId, authorId, ...head } = show(post);
    res.json({
      post: { ...head, canManage: mayManage(w, post), canStage: w.sys || (mayManage(w, post) && post.visibility === 'org_admins'), canReply: mayManage(w, post) },
      comments: cm.rows.map((c) => ({ ...c, id: Number(c.id) })),
      grouped: kids.rows.map((k) => ({ ...k, id: Number(k.id) })),
    });
  }));

  // 글쓰기 — 소속 없는 계정·승인 대기 계정은 못 쓴다
  r.post('/posts', guard(async (req, res) => {
    const w = who(req);
    if (w.orgId == null || !can(req.session.role, 'board.write')) return fail(res, 403, 'board.err.no_school');
    const p = postIn.safeParse(req.body);
    if (!p.success) return bad(res);
    const d = p.data;
    const ins = await pool.query(
      `INSERT INTO board_post (org_id, author_user_id, kind, visibility, title, body, context) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [w.orgId, w.uid, d.kind, d.visibility, d.title, d.body, JSON.stringify(d.context)],
    );
    const postId = Number(ins.rows[0].id);
    const text = t('board.notify.new_post', { 제목: d.title });
    if (d.visibility !== 'org_admins') await notify(pool, { sysadmin: true, kind: 'board.new_post', text, link: `board:${postId}` });
    if (d.visibility !== 'sysadmin') await notify(pool, { orgId: w.orgId, kind: 'board.new_post', text, link: `board:${postId}` });
    await audit(pool, { orgId: w.orgId, userId: w.uid, action: 'board.post', table: 'board_post', rowId: postId, after: { kind: d.kind, visibility: d.visibility } });
    res.status(201).json({ id: postId });
  }));

  // 답글 — 총괄관리자 · 기관 관리자(우리 학교 글 가운데 내가 볼 수 있는 글만)
  r.post('/posts/:id/comments', guard(async (req, res) => {
    const pid = id.safeParse(req.params.id);
    const p = z.object({ body: z.string().trim().min(1).max(5000) }).safeParse(req.body);
    if (!pid.success) return missing(res);
    if (!p.success) return bad(res);
    const w = who(req);
    const post = await findVisible(pool, w, pid.data);
    if (!post) return missing(res);
    if (!mayManage(w, post)) return fail(res, 403, 'board.err.forbidden');
    const ins = await pool.query(`INSERT INTO board_comment (post_id, author_user_id, body) VALUES ($1,$2,$3) RETURNING id`, [pid.data, w.uid, p.data.body]);
    await pool.query(`UPDATE board_post SET updated_at = now() WHERE id = $1`, [pid.data]);
    if (post.authorId != null && String(post.authorId) !== String(w.uid)) {
      await notify(pool, { userId: Number(post.authorId), orgId: post.orgId, kind: 'board.reply', text: t('board.notify.reply', { 제목: post.title }), link: `board:${pid.data}` });
    }
    await audit(pool, { orgId: w.orgId, userId: w.uid, action: 'board.reply', table: 'board_post', rowId: pid.data });
    res.status(201).json({ id: Number(ins.rows[0].id) });
  }));

  // 처리 상태 — 총괄관리자 · (예외) 공개 범위 「기관 관리자만」 글은 그 학교 기관 관리자
  r.patch('/posts/:id/stage', guard(async (req, res) => {
    const pid = id.safeParse(req.params.id);
    const p = z.object({ stage: z.enum(STAGES) }).safeParse(req.body);
    if (!pid.success) return missing(res);
    if (!p.success) return bad(res);
    const w = who(req);
    const post = await findVisible(pool, w, pid.data);
    if (!post) return missing(res);
    const ok = w.sys || (mayManage(w, post) && post.visibility === 'org_admins' && can(req.session.role, 'board.stage'));
    if (!ok) return fail(res, 403, 'board.err.stage_sysadmin');
    await pool.query(`UPDATE board_post SET stage = $2, updated_at = now() WHERE id = $1`, [pid.data, p.data.stage]);
    await audit(pool, { orgId: w.orgId, userId: w.uid, action: 'board.stage', table: 'board_post', rowId: pid.data, before: { stage: post.stage }, after: { stage: p.data.stage } });
    res.json({ ok: true, stage: p.data.stage });
  }));

  // 글 종류 고치기 — 총괄관리자 · 기관 관리자(우리 학교 글)
  r.patch('/posts/:id/kind', guard(async (req, res) => {
    const pid = id.safeParse(req.params.id);
    const p = z.object({ kind: z.enum(KINDS) }).safeParse(req.body);
    if (!pid.success) return missing(res);
    if (!p.success) return bad(res);
    const w = who(req);
    const post = await findVisible(pool, w, pid.data);
    if (!post) return missing(res);
    if (!mayManage(w, post)) return fail(res, 403, 'board.err.own_school_only');
    await pool.query(`UPDATE board_post SET kind = $2, updated_at = now() WHERE id = $1`, [pid.data, p.data.kind]);
    await audit(pool, { orgId: w.orgId, userId: w.uid, action: 'board.kind', table: 'board_post', rowId: pid.data, before: { kind: post.kind }, after: { kind: p.data.kind } });
    res.json({ ok: true, kind: p.data.kind });
  }));

  // 태그 — 총괄관리자 · 기관 관리자(자기 학교 글끼리만)
  r.put('/posts/:id/tags', guard(async (req, res) => {
    const pid = id.safeParse(req.params.id);
    const p = z.object({ tags: z.array(z.string().trim().min(1).max(30)).max(10) }).safeParse(req.body);
    if (!pid.success) return missing(res);
    if (!p.success) return bad(res);
    const w = who(req);
    const post = await findVisible(pool, w, pid.data);
    if (!post) return missing(res);
    if (!mayManage(w, post)) return fail(res, 403, 'board.err.own_school_only');
    const tags = [...new Set(p.data.tags)];
    await pool.query(`UPDATE board_post SET tags = $2, updated_at = now() WHERE id = $1`, [pid.data, tags]);
    await audit(pool, { orgId: w.orgId, userId: w.uid, action: 'board.tags', table: 'board_post', rowId: pid.data, after: { tags } });
    res.json({ ok: true, tags });
  }));

  // 묶기 — 비슷한 글을 맨 위 글 하나에 붙인다(한 단계만). groupId 가 null 이면 풂.
  r.put('/posts/:id/group', guard(async (req, res) => {
    const pid = id.safeParse(req.params.id);
    const p = z.object({ groupId: id.nullable() }).safeParse(req.body);
    if (!pid.success) return missing(res);
    if (!p.success) return bad(res);
    const w = who(req);
    const post = await findVisible(pool, w, pid.data);
    if (!post) return missing(res);
    if (!mayManage(w, post)) return fail(res, 403, 'board.err.own_school_only');
    const gid = p.data.groupId;
    if (gid != null) {
      if (gid === pid.data) return fail(res, 400, 'board.err.group_self');
      const head = await findVisible(pool, w, gid);
      if (!head || !mayManage(w, head)) return fail(res, 404, 'board.err.group_not_visible');
      if (head.groupId != null) return fail(res, 409, 'board.err.group_head_is_child');
      if (post.groupCount > 0) return fail(res, 409, 'board.err.group_has_children');
    }
    await pool.query(`UPDATE board_post SET group_id = $2, updated_at = now() WHERE id = $1`, [pid.data, gid]);
    await audit(pool, { orgId: w.orgId, userId: w.uid, action: 'board.group', table: 'board_post', rowId: pid.data, before: { group: post.groupId }, after: { group: gid } });
    res.json({ ok: true, groupId: gid });
  }));

  // 총괄관리자에게 올리기 — 「기관 관리자만」 글을 그 학교 기관 관리자가 「기관 관리자와 총괄관리자」로. 거꾸로는 없다.
  r.post('/posts/:id/raise', guard(async (req, res) => {
    const pid = id.safeParse(req.params.id);
    if (!pid.success) return missing(res);
    const w = who(req);
    const post = await findVisible(pool, w, pid.data);
    if (!post) return missing(res);
    if (!w.admin || !mayManage(w, post)) return fail(res, 403, 'board.err.own_school_only');
    if (post.visibility !== 'org_admins') return fail(res, 409, 'board.err.raise_only_admins');
    await pool.query(`UPDATE board_post SET visibility = 'org_and_sysadmin', updated_at = now() WHERE id = $1`, [pid.data]);
    if (post.authorId != null) await notify(pool, { userId: Number(post.authorId), orgId: post.orgId, kind: 'board.raised', text: t('board.notify.raised', { 제목: post.title }), link: `board:${pid.data}` });
    await notify(pool, { sysadmin: true, kind: 'board.raised', text: t('board.notify.raised_sys', { 제목: post.title }), link: `board:${pid.data}` });
    await audit(pool, { orgId: w.orgId, userId: w.uid, action: 'board.raise', table: 'board_post', rowId: pid.data, before: { visibility: 'org_admins' }, after: { visibility: 'org_and_sysadmin' } });
    res.json({ ok: true, visibility: 'org_and_sysadmin' });
  }));

  return r;
}
