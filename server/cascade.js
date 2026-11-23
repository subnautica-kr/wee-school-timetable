// 지우기 뼈대(T-1211) — 「무엇을 지우면 무엇이 딸려 가나」를 이 파일 한 곳(관계표 RELATIONS)에 둔다.
// 지우기는 표시 삭제(deleted_at)다. 딸린 것을 같이 지우거나 칸을 비운 것을 묶음(delete_batch) 한 번호로 적고, 그 번호로 되살린다.
// 손대지 않는 것: audit_log(기록) · 보관 학기 자료(학기 status='보관') · 지난 날짜의 보결·예약·근태(기록).

const FUTURE = `on_date >= CURRENT_DATE`;
// 보관 학기 자료는 건드리지 않는다 — 학기 딸린 표는 term_id 로, 칸은 시간표의 학기로 거른다($2 = 기관)
const LIVE_TERM = `term_id NOT IN (SELECT id FROM term WHERE org_id = $2 AND status = '보관')`;
const LIVE_TT = `timetable_id NOT IN (SELECT tt.id FROM timetable tt JOIN term t ON t.id = tt.term_id WHERE tt.org_id = $2 AND t.status = '보관')`;
const SCOPE = { teaching_load: LIVE_TERM, pin: LIVE_TERM, substitute: LIVE_TERM, attendance: LIVE_TERM, classroom: LIVE_TERM, timetable: LIVE_TERM, cell: LIVE_TT };

// 관계표. 한 줄 = 딸린 표 하나의 처리.
//   col: 대상 id 를 가리키는 칸($1) · match: col 대신 쓰는 조건 · extra: 더 거르는 조건
//   how: 'delete' = 행을 같이 지움 · 'null' = 그 칸만 비움(행은 남김) · also: 칸을 비울 때 같이 바꾸는 칸 { 칸: [원래, 바꿀 값] }
export const RELATIONS = {
  classroom: [
    { table: 'teaching_load', col: 'classroom_id', how: 'delete', label: '시수 줄' },
    { table: 'cell', col: 'classroom_id', how: 'delete', label: '시간표 칸' },
    { table: 'pin', col: 'target_id', extra: `target_kind = '반'`, how: 'delete', label: '고정·금지 칸' },
    { table: 'substitute', col: 'classroom_id', how: 'delete', label: '보결' },
    { table: 'booking', col: 'classroom_id', how: 'delete', label: '특별실 예약' },
  ],
  membership: [
    { table: 'teaching_load', col: 'membership_id', how: 'null', label: '시수 줄의 교사(줄은 남김)' },
    { table: 'teaching_load', col: 'second_membership_id', how: 'null', label: '시수 줄의 둘째 교사(줄은 남김)' },
    { table: 'cell', col: 'membership_id', how: 'null', label: '시간표 칸의 교사(칸은 남김)' },
    { table: 'cell', col: 'second_membership_id', how: 'null', label: '시간표 칸의 둘째 교사(칸은 남김)' },
    { table: 'classroom', col: 'homeroom_membership_id', how: 'null', label: '담임 지정(반은 남김)' },
    { table: 'pin', col: 'target_id', extra: `target_kind = '교사'`, how: 'delete', label: '고정·금지 칸' },
    { table: 'substitute', col: 'absent_membership_id', extra: FUTURE, how: 'delete', label: '오늘부터의 보결(결강)' },
    { table: 'substitute', col: 'taken_membership_id', extra: FUTURE, how: 'null', also: { status: ['맡음', '열림'] }, label: '오늘부터 맡은 보결(다시 열림)' },
    { table: 'booking', col: 'membership_id', extra: FUTURE, how: 'delete', label: '오늘부터의 특별실 예약' },
    { table: 'attendance', col: 'membership_id', extra: FUTURE, how: 'delete', label: '오늘부터의 근태' },
    { table: 'attendance_allowed', col: 'membership_id', how: 'delete', label: '허용 교과' },
  ],
  subject: [
    { table: 'teaching_load', col: 'subject_id', how: 'delete', label: '시수 줄' },
    { table: 'cell', col: 'subject_id', how: 'null', label: '시간표 칸의 교과(칸은 남김)' },
    { table: 'pin', col: 'subject_id', how: 'delete', label: '고정 칸' },
    { table: 'attendance_allowed', col: 'subject_id', how: 'delete', label: '허용 교과' },
  ],
  special_room: [
    { table: 'teaching_load', col: 'special_room_id', how: 'null', label: '시수 줄의 특별실(줄은 남김)' },
    { table: 'cell', col: 'special_room_id', how: 'null', label: '시간표 칸의 특별실(칸은 남김)' },
    { table: 'pin', col: 'target_id', extra: `target_kind = '특별실'`, how: 'delete', label: '고정·금지 칸' },
    { table: 'booking', col: 'special_room_id', extra: FUTURE, how: 'delete', label: '오늘부터의 예약' },
    { table: 'room_lock', col: 'special_room_id', how: 'delete', label: '특별실 잠금' },
  ],
  timetable: [
    { table: 'cell', col: 'timetable_id', how: 'delete', label: '시간표 칸' },
  ],
  term: [
    { table: 'timetable', col: 'term_id', how: 'delete', label: '시간표' },
    { table: 'cell', match: `timetable_id IN (SELECT id FROM timetable WHERE term_id = $1)`, how: 'delete', label: '시간표 칸' },
    { table: 'teaching_load', col: 'term_id', how: 'delete', label: '시수 줄' },
    { table: 'pin', col: 'term_id', how: 'delete', label: '고정·금지 칸' },
    { table: 'substitute', col: 'term_id', how: 'delete', label: '보결' },
    { table: 'attendance', col: 'term_id', how: 'delete', label: '근태' },
    { table: 'booking', match: `classroom_id IN (SELECT id FROM classroom WHERE term_id = $1)`, how: 'delete', label: '반에 걸린 특별실 예약' },
    { table: 'classroom', col: 'term_id', how: 'delete', label: '반' },
  ],
};

// 대상 자체: 표 · 보이는 이름 · 학기(보관 학기 거부용)
const TARGET = {
  classroom: { table: 'classroom', name: `x.grade || '학년 ' || x.class_no || '반'`, term: 'x.term_id' },
  membership: { table: 'membership', name: `(SELECT u.name FROM app_user u WHERE u.id = x.user_id)`, term: 'NULL::bigint' },
  subject: { table: 'subject', name: 'x.name', term: 'NULL::bigint' },
  special_room: { table: 'special_room', name: 'x.name', term: 'NULL::bigint' },
  timetable: { table: 'timetable', name: 'x.name', term: 'x.term_id' },
  term: { table: 'term', name: `x.year || '년 ' || x.semester || '학기'`, term: 'x.id' },
  term_clear: { table: 'term', name: `x.year || '년 ' || x.semester || '학기'`, term: 'x.id' }, // 학기 비우기 묶음(학기 자체는 안 지운다)
};
// 개별 지우기·미리보기 대상(관계표가 있는 것만)
export const KINDS = Object.keys(RELATIONS);

// 되살리기가 쓰는 칸 이름은 DB 에서 읽으므로 이 목록 밖이면 거부한다(SQL 에 끼우는 이름의 허용 목록)
const TABLES = new Set([...Object.values(TARGET).map((t) => t.table), ...Object.values(RELATIONS).flat().map((r) => r.table)]);
const COLUMNS = new Set(Object.values(RELATIONS).flat().filter((r) => r.how === 'null').flatMap((r) => [r.col, ...Object.keys(r.also ?? {})]));
const COL_TYPE = (c) => (c === 'status' ? 'text' : 'bigint');

export function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

const whereOf = (rel) => [rel.match ?? [rel.col, '= $1'].join(' '), `org_id = $2`, `deleted_at IS NULL`, rel.extra, SCOPE[rel.table]].filter(Boolean).join(' AND ');

// 지운 시각 = 묶음 시각($3 = 묶음 번호). 되살리기는 이 시각과 같은 것만 푼다.
const STAMP = `(SELECT created_at FROM delete_batch WHERE id = $3)`;

// 대상 찾기(기관 경계: org_id 로만). deleted=true 면 지운 것도(되살리기용).
async function findTarget(db, orgId, kind, id, { deleted = false, lock = false } = {}) {
  const t = TARGET[kind];
  if (!t) return null;
  // 끼우는 조각은 전부 TARGET 상수에서 나온 지역 이름이다(sec-injection 시험의 허용 이름)
  const { table } = t;
  const nameSql = t.name;
  const termSql = t.term;
  const guard = [deleted ? '' : 'AND x.deleted_at IS NULL', lock ? 'FOR UPDATE OF x' : ''].join(' ');
  const { rows } = await db.query(
    `SELECT x.id, ${nameSql} AS label, ${termSql} AS term_id, x.deleted_at,
            (SELECT status = '보관' FROM term WHERE id = ${termSql}) AS archived
       FROM ${table} x WHERE x.id = $1 AND x.org_id = $2 ${guard}`,
    [id, orgId],
  );
  return rows[0] ?? null;
}

// 확정 시간표가 걸리는가(칸을 지우거나 비우는 경우 · 시간표 자체를 지우는 경우)
async function confirmedHits(db, orgId, kind, id) {
  const ids = new Set();
  if (kind === 'timetable' || kind === 'term') {
    const col = kind === 'timetable' ? 'id' : 'term_id';
    for (const r of (await db.query(`SELECT id FROM timetable WHERE ${col} = $1 AND org_id = $2 AND deleted_at IS NULL AND status = '확정'`, [id, orgId])).rows) ids.add(r.id);
  }
  for (const rel of RELATIONS[kind].filter((x) => x.table === 'cell')) {
    const where = whereOf(rel);
    const { rows } = await db.query(
      `SELECT DISTINCT timetable_id FROM cell WHERE ${where} AND timetable_id IN (SELECT id FROM timetable WHERE org_id = $2 AND status = '확정' AND deleted_at IS NULL)`,
      [id, orgId],
    );
    for (const r of rows) ids.add(r.timetable_id);
  }
  return ids.size;
}

// 영향 세기 — 지우기 전에 「무엇이 몇 개 같이 가나」. 없거나 남의 기관이면 null(→ 404).
export async function preview(db, orgId, kind, id) {
  const t = await findTarget(db, orgId, kind, id);
  if (!t) return null;
  const effects = [];
  for (const rel of RELATIONS[kind]) {
    const { table } = rel;
    const where = whereOf(rel);
    const n = (await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, [id, orgId])).rows[0].n;
    if (n) effects.push({ table: rel.table, label: rel.label, count: n, action: rel.how });
  }
  const warnings = [];
  if (t.archived) warnings.push('보관된 학기 자료라 지울 수 없습니다');
  const hit = await confirmedHits(db, orgId, kind, id);
  if (hit) warnings.push(`확정된 시간표 ${hit}개에 걸립니다 — 지우면 그 시간표도 바뀝니다`);
  return { target: { kind, id: Number(t.id), label: t.label }, effects, warnings };
}

async function addItems(db, batchId, table, rows) {
  if (!rows.length) return;
  await db.query(
    `INSERT INTO delete_batch_item (batch_id, table_name, row_id, column_name, old_value, new_value)
     SELECT $1, $2, r.row_id, r.col, r.old, r.new FROM unnest($3::bigint[], $4::text[], $5::text[], $6::text[]) AS r(row_id, col, old, new)`,
    [batchId, table, rows.map((r) => r.id), rows.map((r) => r.col ?? null), rows.map((r) => r.old ?? null), rows.map((r) => r.new ?? null)],
  );
}

// 관계 줄들을 차례로 적용(지움·칸 비움) — 묶음 번호(batchId)로 적는다. $1 = id(대상 또는 학기)
async function applyRelations(client, orgId, rels, id, batchId) {
  const effects = [];
  for (const rel of rels) {
    let items;
    const { table } = rel;
    const where = whereOf(rel);
    if (rel.how === 'delete') {
      const { rows } = await client.query(`UPDATE ${table} SET deleted_at = ${STAMP} WHERE ${where} RETURNING id`, [id, orgId, batchId]);
      items = rows.map((r) => ({ id: r.id }));
    } else {
      const also = Object.entries(rel.also ?? {});
      const pickCols = also.map(([c]) => ', ' + c).join('');
      const { rows } = await client.query(`SELECT id${pickCols} FROM ${table} WHERE ${where} FOR UPDATE`, [id, orgId]);
      if (rows.length) {
        const sets = [`${rel.col} = NULL`, ...also.map(([c, [from, to]]) => `${c} = CASE WHEN ${c} = '${from}' THEN '${to}' ELSE ${c} END`)];
        await client.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ANY($1::bigint[]) AND org_id = $2`, [rows.map((r) => r.id), orgId]);
      }
      items = rows.flatMap((r) => [
        { id: r.id, col: rel.col, old: String(id), new: null },
        ...also.filter(([c, [from]]) => r[c] === from).map(([c, [from, to]]) => ({ id: r.id, col: c, old: from, new: to })),
      ]);
    }
    await addItems(client, batchId, rel.table, items);
    if (items.length) effects.push({ table: rel.table, label: rel.label, count: rel.how === 'delete' ? items.length : items.filter((x) => x.col === rel.col).length, action: rel.how });
  }
  return effects;
}

// 묶음 지우기 — 트랜잭션 안에서 부른다(inTx). 대상과 딸린 것을 표시 삭제·칸 비움하고 같은 묶음 번호로 적는다.
// 돌려줌: null(없음·남의 기관) | { batchId, label, effects }. 보관 학기면 409 를 던진다.
export async function removeWithCascade(client, orgId, kind, id, userId) {
  const t = await findTarget(client, orgId, kind, id, { lock: true });
  if (!t) return null;
  if (t.archived) throw httpError(409, '보관된 학기는 볼 수만 있습니다');
  const batchId = (await client.query(
    `INSERT INTO delete_batch (org_id, kind, target_id, label, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, kind, id, t.label, userId ?? null],
  )).rows[0].id;
  const effects = await applyRelations(client, orgId, RELATIONS[kind], id, batchId);
  const table = TARGET[kind].table;
  await client.query(`UPDATE ${table} SET deleted_at = ${STAMP} WHERE id = $1 AND org_id = $2`, [id, orgId, batchId]);
  await addItems(client, batchId, TARGET[kind].table, [{ id }]);
  await client.query(`UPDATE delete_batch SET summary = $2 WHERE id = $1`, [batchId, JSON.stringify(effects)]);
  return { batchId: Number(batchId), label: t.label, effects };
}

// 되살릴 때 「같은 것이 이미 있나」 — 유일 인덱스(classroom_uq 등)와 같은 조건을 먼저 보고 이유를 한국어로
const CONFLICT = {
  classroom: [`SELECT 1 FROM classroom o, classroom x WHERE x.id = $1 AND o.term_id = x.term_id AND o.grade = x.grade AND o.class_no = x.class_no AND o.deleted_at IS NULL AND o.id <> x.id`, (l) => `같은 반(${l})이 이미 다시 만들어져 있어 되살릴 수 없습니다. 새로 만든 ${l}을 먼저 지워 주세요`],
  subject: [`SELECT 1 FROM subject o, subject x WHERE x.id = $1 AND o.org_id = x.org_id AND o.name = x.name AND o.deleted_at IS NULL AND o.id <> x.id`, (l) => `같은 이름의 교과(${l})가 이미 있어 되살릴 수 없습니다`],
  special_room: [`SELECT 1 FROM special_room o, special_room x WHERE x.id = $1 AND o.org_id = x.org_id AND o.name = x.name AND o.deleted_at IS NULL AND o.id <> x.id`, (l) => `같은 이름의 특별실(${l})이 이미 있어 되살릴 수 없습니다`],
  timetable: [`SELECT 1 FROM timetable o, timetable x WHERE x.id = $1 AND o.org_id = x.org_id AND o.term_id = x.term_id AND o.name = x.name AND o.deleted_at IS NULL AND o.id <> x.id`, (l) => `같은 이름의 시간표(${l})가 이미 있어 되살릴 수 없습니다`],
  term: [`SELECT 1 FROM term o, term x WHERE x.id = $1 AND o.org_id = x.org_id AND o.deleted_at IS NULL AND o.id <> x.id AND ((o.year = x.year AND o.semester = x.semester) OR (x.status = '진행' AND o.status = '진행'))`, (l) => `같은 학기(${l})가 있거나 이미 진행 중인 다른 학기가 있어 되살릴 수 없습니다`],
};

// 묶음 되살리기 — 트랜잭션 안에서 부른다. 표시 삭제를 풀고 비운 칸을 되돌린다(그 사이 누가 바꾼 칸은 그대로 둔다).
// 돌려줌: null(없음·남의 기관) | { batchId, label, restored }. 이미 되살렸거나 같은 것이 있으면 409 를 던진다.
export async function restoreBatch(client, orgId, batchId) {
  const b = (await client.query(`SELECT id, kind, target_id, label, restored_at FROM delete_batch WHERE id = $1 AND org_id = $2 FOR UPDATE`, [batchId, orgId])).rows[0];
  if (!b) return null;
  if (b.restored_at) throw httpError(409, '이미 되살린 묶음입니다');
  const t = await findTarget(client, orgId, b.kind, b.target_id, { deleted: true });
  if (!t) return null;
  if (t.archived) throw httpError(409, '보관된 학기는 되살릴 수 없습니다');
  const c = CONFLICT[b.kind];
  if (c && (await client.query(c[0], [b.target_id])).rows[0]) throw httpError(409, c[1](b.label));
  const items = (await client.query(`SELECT table_name, row_id, column_name, old_value, new_value FROM delete_batch_item WHERE batch_id = $1 ORDER BY id`, [b.id])).rows;
  let restored = 0;
  try {
    // 행: 이 묶음이 지운 시각(같은 트랜잭션의 now() = 묶음 created_at)과 같은 것만 푼다
    const byTable = new Map();
    for (const it of items.filter((x) => x.column_name == null)) byTable.set(it.table_name, [...(byTable.get(it.table_name) ?? []), it.row_id]);
    for (const [table, ids] of byTable) {
      if (!TABLES.has(table)) continue;
      // 시각은 SQL 안에서 비교한다(JS Date 는 밀리초까지라 마이크로초가 잘린다)
      restored += (await client.query(`UPDATE ${table} SET deleted_at = NULL WHERE id = ANY($1::bigint[]) AND org_id = $2 AND deleted_at = (SELECT created_at FROM delete_batch WHERE id = $3)`, [ids, orgId, b.id])).rowCount;
    }
    // 칸: 비운 뒤 그대로(지금 값 = 바꾼 값)인 것만 원래 값으로
    const byCol = new Map();
    for (const it of items.filter((x) => x.column_name != null)) {
      const k = `${it.table_name}.${it.column_name}`;
      byCol.set(k, [...(byCol.get(k) ?? []), it]);
    }
    for (const [k, list] of byCol) {
      const [table, col] = k.split('.');
      if (!TABLES.has(table) || !COLUMNS.has(col)) continue;
      const colType = COL_TYPE(col);
      restored += (await client.query(
        `UPDATE ${table} t SET ${col} = v.old::${colType}
           FROM unnest($1::bigint[], $2::text[], $3::text[]) AS v(id, old, new)
          WHERE t.id = v.id AND t.org_id = $4 AND t.${col}::text IS NOT DISTINCT FROM v.new`,
        [list.map((x) => x.row_id), list.map((x) => x.old_value), list.map((x) => x.new_value), orgId],
      )).rowCount;
    }
  } catch (e) {
    if (e.code === '23505') throw httpError(409, '같은 것이 이미 있어 되살릴 수 없습니다');
    throw e;
  }
  await client.query(`UPDATE delete_batch SET restored_at = now() WHERE id = $1`, [b.id]);
  return { batchId: Number(b.id), label: b.label, restored };
}

// 트랜잭션 한 겹 — removeWithCascade·restoreBatch 를 이걸로 감싸 부른다
export async function inTx(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// ── 학기 비우기(T-1212) — 세 단계. 학기 자체·보관 학기·감사 기록은 남긴다. ──
const TT_RELS = [
  { table: 'timetable', col: 'term_id', how: 'delete', label: '시간표' },
  { table: 'cell', match: `timetable_id IN (SELECT id FROM timetable WHERE term_id = $1)`, how: 'delete', label: '시간표 칸' },
];
const HOURS_RELS = [...TT_RELS,
  { table: 'teaching_load', col: 'term_id', how: 'delete', label: '시수 줄' },
  { table: 'pin', col: 'term_id', how: 'delete', label: '고정·금지 칸' },
];
const IN_TERM_CLASS = `classroom_id IN (SELECT id FROM classroom WHERE term_id = $1)`;
const CLEAR_RELATIONS = {
  timetable: TT_RELS,
  hours: HOURS_RELS,
  classes: [...HOURS_RELS,
    { table: 'substitute', match: IN_TERM_CLASS, how: 'delete', label: '반에 걸린 보결' },
    { table: 'booking', match: IN_TERM_CLASS, how: 'delete', label: '반에 걸린 특별실 예약' },
    { table: 'classroom', col: 'term_id', how: 'delete', label: '반' },
  ],
};
export const CLEAR_LEVELS = Object.keys(CLEAR_RELATIONS);
const LEVEL_NAME = { timetable: '시간표만', hours: '시간표·시수표·고정', classes: '시간표·시수표·고정·반까지' };

// 비우기 미리보기 — 없거나 남의 기관 학기면 null(→ 404)
export async function previewClear(db, orgId, termId, level) {
  const t = await findTarget(db, orgId, 'term_clear', termId);
  if (!t || !CLEAR_RELATIONS[level]) return null;
  const effects = [];
  for (const rel of CLEAR_RELATIONS[level]) {
    const { table } = rel;
    const where = whereOf(rel);
    const n = (await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, [termId, orgId])).rows[0].n;
    if (n) effects.push({ table: rel.table, label: rel.label, count: n, action: rel.how });
  }
  const warnings = [];
  if (t.archived) warnings.push('보관된 학기는 비울 수 없습니다');
  const hit = (await db.query(`SELECT count(*)::int AS n FROM timetable WHERE term_id = $1 AND org_id = $2 AND deleted_at IS NULL AND status = '확정'`, [termId, orgId])).rows[0].n;
  if (hit) warnings.push(`확정된 시간표 ${hit}개가 함께 비워집니다`);
  return { target: { kind: 'term', id: Number(t.id), label: t.label }, level, levelName: LEVEL_NAME[level], effects, warnings, confirmText: t.label };
}

// 학기 비우기 — 트랜잭션 안에서 부른다. confirm 이 학기 이름과 다르면 400, 보관 학기·비울 것 없음은 409.
export async function clearTerm(client, orgId, termId, level, confirm, userId) {
  const rels = CLEAR_RELATIONS[level];
  const t = rels && await findTarget(client, orgId, 'term_clear', termId, { lock: true });
  if (!t) return null;
  if (t.archived) throw httpError(409, '보관된 학기는 비울 수 없습니다');
  if (confirm !== t.label) throw httpError(400, `확인 글자가 다릅니다. 「${t.label}」을 그대로 입력해 주세요`);
  const batchId = (await client.query(
    `INSERT INTO delete_batch (org_id, kind, target_id, label, created_by) VALUES ($1, 'term_clear', $2, $3, $4) RETURNING id`,
    [orgId, termId, `${t.label} 비우기(${LEVEL_NAME[level]})`, userId ?? null],
  )).rows[0].id;
  const effects = await applyRelations(client, orgId, rels, termId, batchId);
  if (!effects.length) throw httpError(409, '비울 것이 없습니다');
  await client.query(`UPDATE delete_batch SET summary = $2 WHERE id = $1`, [batchId, JSON.stringify(effects)]);
  return { batchId: Number(batchId), label: t.label, level, effects };
}

// 방금 연 학기 되돌리기 — 가능한지 따진다. 돌려줌 { ok, reason?, current?, previous? }
// 새 학기를 연 기록(audit_log 의 term.new_semester)에서 지난 학기를 찾는다 — 그 기록은 읽기만 한다.
export async function undoNewSemesterCheck(db, orgId, { lock = false } = {}) {
  const no = (reason) => ({ ok: false, reason });
  const guard = lock ? 'FOR UPDATE' : '';
  const cur = (await db.query(`SELECT id, year, semester FROM term WHERE org_id = $1 AND status = '진행' AND deleted_at IS NULL ORDER BY year DESC, semester DESC LIMIT 1 ${guard}`, [orgId])).rows[0];
  if (!cur) return no('진행 중인 학기가 없습니다');
  const log = (await db.query(`SELECT before FROM audit_log WHERE org_id = $1 AND action = 'term.new_semester' AND after->>'id' = $2 ORDER BY id DESC LIMIT 1`, [orgId, String(cur.id)])).rows[0];
  if (!log?.before?.id) return no('지금 학기는 「새 학기 시작」으로 연 학기가 아니라 되돌릴 수 없습니다');
  const prev = (await db.query(`SELECT id, year, semester FROM term WHERE id = $1 AND org_id = $2 AND status = '보관' AND deleted_at IS NULL`, [log.before.id, orgId])).rows[0];
  if (!prev) return no('지난 학기가 이미 보관 상태가 아니거나 없어져 되돌릴 수 없습니다');
  const used = (await db.query(
    `SELECT EXISTS (SELECT 1 FROM timetable WHERE term_id = $1 AND org_id = $2 AND status = '확정') AS confirmed,
            EXISTS (SELECT 1 FROM substitute WHERE term_id = $1 AND org_id = $2) AS sub,
            EXISTS (SELECT 1 FROM attendance WHERE term_id = $1 AND org_id = $2) AS att`,
    [cur.id, orgId],
  )).rows[0];
  if (used.confirmed) return no('새 학기에 확정한 시간표가 있어 되돌릴 수 없습니다');
  if (used.sub) return no('새 학기에 보결 기록이 있어 되돌릴 수 없습니다');
  if (used.att) return no('새 학기에 근태 기록이 있어 되돌릴 수 없습니다');
  return { ok: true, current: cur, previous: prev };
}

// 되돌리기 실행 — 트랜잭션 안에서. 새 학기를 딸린 것과 함께 지우고(휴지통에 묶음으로 남음) 지난 학기 보관을 푼다. 안 되면 409.
export async function undoNewSemester(client, orgId, userId) {
  const chk = await undoNewSemesterCheck(client, orgId, { lock: true });
  if (!chk.ok) throw httpError(409, chk.reason);
  const removed = await removeWithCascade(client, orgId, 'term', chk.current.id, userId);
  await client.query(`UPDATE term SET status = '진행' WHERE id = $1 AND org_id = $2`, [chk.previous.id, orgId]);
  return { removed, current: chk.current, reopened: chk.previous };
}
