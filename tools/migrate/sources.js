// 읽는 파일 두 가지를 한 꼴(「원본」)로 바꾼다. 순수 함수 — 앱에 아무것도 안 보낸다.
//   ① 옛 앱 작업 파일(*.shiftgrid.json · 옛 앱 Doc v1~v3) → legacyToSource
//   ② 새 앱 백업 파일(format 'wee-timetable-backup')      → backupToSource
// 원본 꼴: { kind, title, people, classes, subjects, rooms, periods, loads, timetables, pins, lost }
//   people   [{ key, name, loginId?, role?, duty? }]
//   classes  [{ key, grade, class_no, student_count?, homeroomKey? }]
//   subjects [{ key, name, short_name? }] · rooms [{ key, name, purpose?, capacity? }]
//   periods  { grades: { '1': { periods, byDay?, times?, lunch?, lunchAfter? } }, times? } | null
//   loads    [{ key, personKey, secondKey, second_hours, subjectKey, classKey, roomKey, weekly_hours, block, sync_progress }]
//   timetables [{ key, name, cells: [{ classKey, weekday, period, subjectKey, personKey, secondKey, roomKey }] }]
//   pins     [{ key, target_kind, targetKey, weekday, period, kind, subjectKey }]
//   lost     [{ what, id, reason }] — 파일 안에서 이미 받을 자리가 없는 것

export const HOMEROOM = '__homeroom__'; // 옛 앱의 「그 반 담임」 표시

export function detect(json) {
  if (json && json.format === 'wee-timetable-backup') return 'backup';
  if (json && typeof json === 'object' && (Array.isArray(json.tracks) || Array.isArray(json.agents) || Array.isArray(json.demands))) return 'legacy';
  return null;
}

const arr = (v) => (Array.isArray(v) ? v : []);

// 반 이름 「3-1」·「3학년 1반」 → [학년, 반]
function classNoOf(t) {
  const n = Number(t.attr?.classNum);
  if (Number.isInteger(n) && n > 0) return n;
  const m = String(t.name ?? '').match(/^\s*(\d{1,2})\s*(?:-|학년\s*)\s*(\d{1,3})\s*(?:반)?\s*$/);
  return m ? Number(m[2]) : null;
}
const gradeOf = (t) => {
  const g = Number(t.grade ?? t.attr?.grade);
  if (Number.isInteger(g) && g > 0) return g;
  const m = String(t.name ?? '').match(/^\s*(\d{1,2})\s*(?:-|학년)/);
  return m ? Number(m[1]) : null;
};

// ── ① 옛 앱 파일 ──
export function legacyToSource(doc) {
  const lost = [];
  const L = (what, id, reason) => lost.push({ what, id: String(id), reason });
  const agents = arr(doc.agents);
  const tracks = arr(doc.tracks).map((t) => ({ ...t, specId: t.specId ?? t.attr?.specId }));
  const specs = arr(doc.specs);
  const specById = new Map(specs.map((s) => [s.id, s]));

  // 사람: 명부(agents) + 반에만 적힌 담임 이름(homeroomName)
  const DUTY = { 전담: '전담', 비교과: '비교과', 담임: '담임', '담임 겸 전담': '담임' };
  const people = agents.map((a) => ({ key: `a:${a.id}`, name: String(a.name ?? '').trim(), role: '교직원', duty: DUTY[a.role] ?? null }));
  const homeroomOf = new Map(); // track.id → person key
  for (const a of agents) for (const tid of [...arr(a.homeroomTrackIds), ...(a.homeroomTrackId ? [a.homeroomTrackId] : [])]) if (!homeroomOf.has(tid)) homeroomOf.set(tid, `a:${a.id}`);
  for (const t of tracks) {
    const name = String(t.homeroomName ?? '').trim();
    if (!name || homeroomOf.has(t.id)) continue;
    // 명부에 같은 이름 담임이 하나뿐이면 그 사람, 아니면 반마다 따로(동명이인 두 반이 한 사람이 되지 않게)
    const same = agents.filter((a) => a.name === name && (a.role === '담임' || a.role === '담임 겸 전담'));
    if (same.length === 1) { homeroomOf.set(t.id, `a:${same[0].id}`); continue; }
    const key = `hr:${t.id}`;
    people.push({ key, name, role: '교직원', duty: '담임' });
    homeroomOf.set(t.id, key);
  }
  for (const a of agents) {
    if (a.tier) L('교사 등급', a.name, `등급(tier ${a.tier})은 이 도구가 안 옮긴다 — 앱 「전담·비교과」에서 다시 고른다`);
    if (a.lunchSpecId) L('교사 점심 틀', a.name, '점심 맞출 시간 틀은 새 앱에 자리가 없다');
  }

  // 반
  const classes = [];
  for (const t of tracks) {
    const grade = gradeOf(t);
    const class_no = classNoOf(t);
    if (!grade || !class_no) { L('반', t.name ?? t.id, '학년·반 번호를 못 읽었다'); continue; }
    classes.push({ key: `t:${t.id}`, grade, class_no, homeroomKey: homeroomOf.get(t.id) ?? null, label: `${grade}-${class_no}` });
  }
  const classKeys = new Set(classes.map((c) => c.key));

  const subjects = arr(doc.activities).map((a) => ({ key: `s:${a.id}`, name: String(a.name ?? '').trim() }));
  const rooms = arr(doc.resources).map((r) => ({ key: `r:${r.id}`, name: String(r.name ?? '').trim() }));
  for (const r of arr(doc.resources)) if ((r.capacity ?? 1) !== 1) L('특별실 수용 수', r.name, `수용 ${r.capacity}반은 새 특별실에 자리가 없다(정원은 학생 수)`);

  // 교시: 시간 틀 → 학년별 교시 수·시각·점심·요일별 교시(byDay)
  const lessonsOf = (s) => arr(s?.slots).slice().sort((a, b) => a.index - b.index);
  const grades = {};
  for (const s of specs) {
    const gs = arr(s.grades).length ? s.grades : [...new Set(tracks.filter((t) => t.specId === s.id).map(gradeOf).filter(Boolean))];
    if (!gs.length) { L('시간 틀', s.name ?? s.id, '쓰는 학년이 없다'); continue; }
    const slots = lessonsOf(s);
    const lessons = slots.filter((x) => x.assignable);
    if (!lessons.length) { L('시간 틀', s.name ?? s.id, '수업 칸이 없다'); continue; }
    const g = { periods: lessons.length, times: lessons.map((x) => ({ start: x.start, end: x.end })) };
    const lunch = slots.find((x) => x.kind === 'lunch' || (!x.assignable && x.label === '점심'));
    if (lunch) { g.lunch = lunch.start; g.lunchAfter = slots.filter((x) => x.assignable && x.index < lunch.index).length; }
    const byDay = {};
    for (const [d, n] of Object.entries(s.lessonsPerDay ?? {})) if (Number(n) > 0 && Number(n) !== lessons.length) byDay[String(Number(d) + 1)] = Number(n);
    if (Object.keys(byDay).length) g.byDay = byDay;
    const days = arr(s.activeDays);
    if (days.length && days.join(',') !== '0,1,2,3,4') L('시간 틀 요일', s.name ?? s.id, `수업 요일 ${days.map((d) => '월화수목금토일'[d]).join('')} — 새 앱은 요일별 교시 수로만 받는다`);
    for (const gr of gs) grades[String(gr)] = g;
  }
  const periods = Object.keys(grades).length ? { grades } : null;

  // 「그 반 담임」을 사람 열쇠로
  const who = (agentId, trackId) => (agentId === HOMEROOM ? homeroomOf.get(trackId) ?? null : agentId ? `a:${agentId}` : null);

  // 시수표
  const loads = [];
  for (const d of arr(doc.demands)) {
    const personKey = who(d.agentId, d.trackId);
    if (d.agentId === HOMEROOM && !personKey) { L('시수표', d.id, '담임 수업인데 그 반 담임 이름이 없다'); continue; }
    if (!classKeys.has(`t:${d.trackId}`)) { L('시수표', d.id, '반을 못 찾았다'); continue; }
    const bl = arr(d.block).filter((n) => Number(n) > 0);
    if (bl.length > 1 && new Set(bl).size > 1) L('시수표 연강', d.id, `연강 묶음 [${bl.join(',')}] — 새 앱은 한 값만 받아 ${bl[0]} 로 넣었다`);
    if (d.roomHours !== undefined && d.roomHours !== d.count) L('시수표 특별실 시수', d.id, `특별실 ${d.roomHours}시수만 쓰는 값은 자리가 없다 — 전 시수에 특별실을 붙였다`);
    if (d.fixed) L('시수표 고정 수요', d.id, '고정 수요 표시는 자리가 없다(일반 시수로 넣음)');
    loads.push({
      key: `d:${d.id}`,
      personKey,
      secondKey: d.coAgentId ? who(d.coAgentId, d.trackId) : null,
      second_hours: null, // 옛 협력수업은 전 시수를 함께 들어간다
      subjectKey: d.activityId ? `s:${d.activityId}` : null,
      classKey: `t:${d.trackId}`,
      roomKey: d.resourceId && (d.roomHours ?? 1) !== 0 ? `r:${d.resourceId}` : null,
      weekly_hours: Number(d.count) || 0,
      block: bl[0] ?? 1,
      sync_progress: !!d.cycle,
    });
  }

  // 짜 둔 시간표: 옛 표 여러 장(학년군마다)을 시안 한 장으로. 같은 칸이 겹치면 우선순위 큰 표가 이긴다.
  const ttById = new Map(arr(doc.timetables).map((t) => [t.id, t]));
  const trackById = new Map(tracks.map((t) => [t.id, t]));
  const cellAt = new Map();
  const sorted = arr(doc.assignments).slice().sort((a, b) => (ttById.get(b.timetableId)?.priority ?? 0) - (ttById.get(a.timetableId)?.priority ?? 0));
  for (const a of sorted) {
    const t = trackById.get(a.trackId);
    if (!t || !classKeys.has(`t:${t.id}`)) { L('시간표 칸', a.id, '반을 못 찾았다'); continue; }
    const slots = lessonsOf(specById.get(t.specId) ?? specById.get(ttById.get(a.timetableId)?.specId));
    const slot = slots.find((x) => x.index === a.slotIndex);
    if (!slot || !slot.assignable) { L('시간표 칸', a.id, '수업 칸이 아닌 자리(점심 등)에 있다'); continue; }
    const period = slots.filter((x) => x.assignable && x.index <= a.slotIndex).length;
    const weekday = Number(a.dayIndex) + 1;
    const k = `${t.id}:${weekday}:${period}`;
    if (cellAt.has(k)) { L('시간표 칸', a.id, `${gradeOf(t)}-${classNoOf(t)} ${'월화수목금토일'[weekday - 1]} ${period}교시가 다른 표와 겹쳐 우선순위 큰 쪽만 넣었다`); continue; }
    cellAt.set(k, {
      classKey: `t:${t.id}`, weekday, period,
      subjectKey: a.activityId ? `s:${a.activityId}` : null,
      personKey: who(a.agentId, a.trackId),
      secondKey: a.coAgentId ? who(a.coAgentId, a.trackId) : null,
      roomKey: a.resourceId ? `r:${a.resourceId}` : null,
    });
  }
  const name = String(doc.meta?.name ?? '옛 파일').trim() || '옛 파일';
  const timetables = cellAt.size ? [{ key: 'legacy', name: `${name} 옛 파일 이전`.slice(0, 60), cells: [...cellAt.values()] }] : [];

  if (arr(doc.weeklyBlocks).length) L('주간 금지칸', '*', `${doc.weeklyBlocks.length}건 — 이 도구는 안 옮긴다. 앱 「고정·금지」에서 다시 넣는다`);
  if (arr(doc.blackouts).length) L('날짜 차단(복무)', '*', `${doc.blackouts.length}건 — 새 앱에 같은 자리가 없다`);
  if (arr(doc.rules).length) L('규칙 설정', '*', `${doc.rules.length}건 — 앱 「규칙」에서 다시 고른다`);
  if (arr(doc.boards).length) L('보드', '*', `${doc.boards.length}건 — 새 앱에 같은 자리가 없다`);

  return { kind: 'legacy', title: name, people, classes, subjects, rooms, periods, loads, timetables, pins: [], lost };
}

// ── ② 새 앱 백업 파일 ──
// 지금 학기(진행 · 가장 늦은 것)만 넣는다 — 새 앱의 올리기 길은 모두 지금 학기에만 쓴다.
export function pickTerm(terms) {
  const live = arr(terms).filter((t) => !t.deleted_at);
  const run = live.filter((t) => t.status === '진행');
  const pool = run.length ? run : live;
  return pool.slice().sort((a, b) => b.year - a.year || b.semester - a.semester)[0] ?? null;
}

export function backupToSource(b) {
  const T = b.tables ?? {};
  const lost = [];
  const L = (what, id, reason) => lost.push({ what, id: String(id), reason });
  const live = (rows) => arr(rows).filter((r) => !r.deleted_at);
  const term = pickTerm(T.term);
  const inTerm = (rows) => live(rows).filter((r) => term && String(r.term_id) === String(term.id));

  const users = new Map(live(T.app_user).map((u) => [String(u.id), u]));
  const people = [];
  for (const m of live(T.membership)) {
    const u = users.get(String(m.user_id));
    if (!u || m.role === '시스템관리자') continue;
    people.push({ key: `m:${m.id}`, name: u.name, loginId: u.login_id, role: m.role, duty: m.duty ?? null, status: m.status });
  }
  const classes = inTerm(T.classroom).map((c) => ({ key: `c:${c.id}`, grade: c.grade, class_no: c.class_no, student_count: c.student_count ?? null, homeroomKey: c.homeroom_membership_id ? `m:${c.homeroom_membership_id}` : null, label: `${c.grade}-${c.class_no}` }));
  const subjects = live(T.subject).map((s) => ({ key: `s:${s.id}`, name: s.name, short_name: s.short_name ?? null, color: s.color ?? null }));
  const rooms = live(T.special_room).map((r) => ({ key: `r:${r.id}`, name: r.name, purpose: r.purpose ?? undefined, capacity: r.capacity ?? null }));
  const k = (p, v) => (v == null ? null : `${p}:${v}`);
  const loads = inTerm(T.teaching_load).map((l) => ({
    key: `l:${l.id}`, personKey: k('m', l.membership_id), secondKey: k('m', l.second_membership_id), second_hours: l.second_hours ?? null,
    subjectKey: k('s', l.subject_id), classKey: k('c', l.classroom_id), roomKey: k('r', l.special_room_id),
    weekly_hours: l.weekly_hours ?? 0, block: l.block ?? 1, sync_progress: !!l.sync_progress,
  }));
  const cells = live(T.cell);
  const timetables = inTerm(T.timetable).map((t) => ({
    key: `t:${t.id}`, name: t.name, status: t.status,
    cells: cells.filter((c) => String(c.timetable_id) === String(t.id)).map((c) => ({
      classKey: k('c', c.classroom_id), weekday: c.weekday, period: c.period, subjectKey: k('s', c.subject_id),
      personKey: k('m', c.membership_id), secondKey: k('m', c.second_membership_id), roomKey: k('r', c.special_room_id),
    })),
  }));
  const PIN = { 교사: 'm', 반: 'c', 특별실: 'r' };
  const pins = inTerm(T.pin).map((p) => ({ key: `p:${p.id}`, target_kind: p.target_kind, targetKey: k(PIN[p.target_kind], p.target_id), weekday: p.weekday, period: p.period, kind: p.kind, subjectKey: k('s', p.subject_id) }));

  for (const t of live(T.term)) if (!term || String(t.id) !== String(term.id)) L('지난 학기', `${t.year}-${t.semester}`, '새 앱 길은 지금 학기에만 넣는다 — 이 학기 반·시수표·시간표는 안 옮긴다');
  for (const t of inTerm(T.timetable)) if (t.status === '확정') L('확정 시간표', t.name, '시안으로 넣었다 — 확정은 앱에서 다시 한다');
  for (const [tb, label] of [['substitute', '보결'], ['booking', '특별실 예약'], ['room_lock', '특별실 잠금'], ['attendance', '근태'], ['attendance_allowed', '근태 허용'], ['month_close', '월 마감'], ['audit_log', '감사 기록']]) {
    const n = live(T[tb]).length;
    if (n) L(label, '*', `${n}건 — 이 도구는 안 옮긴다`);
  }
  if (b.org?.config || b.org?.soft_weights || b.org?.small_school) L('기관 설정', '*', '상한·권장 가중·소규모교 설정은 안 옮긴다 — 앱 화면에서 다시 맞춘다');
  return { kind: 'backup', title: b.org?.name ?? '백업', people, classes, subjects, rooms, periods: b.org?.period_config && Object.keys(b.org.period_config.grades ?? {}).length ? b.org.period_config : null, loads, timetables, pins, lost };
}
