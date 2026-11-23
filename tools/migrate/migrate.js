// 맞추기(원본 ↔ 앱의 지금 자료) · 미리보기 표 · 넣기. 앱에는 HTTP 길로만 닿는다.
//   지금 자료 읽기 = GET /backup(읽기만 하는 길 · 기관관리자). 다른 GET 은 지금 학기·기본 교과를 만들어 버려서 미리보기에 안 쓴다.
//   넣기 = 명단 올리기 · 반/교과/특별실/교시 · 시수표 줄 · 시안 저장 · 고정·금지 — 모두 앱 화면이 쓰는 길 그대로.
import { readFileSync } from 'node:fs';
import { pickTerm } from './sources.js';

const NEW = 'NEW'; // 미리보기에서 「넣으면 생길 것」
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (v == null ? null : Number(v));

// 백업 꼴 응답 → 맞추기에 쓰는 지금 자료(지금 학기만)
export function stateFromBackup(b) {
  const T = b.tables ?? {};
  const live = (rows) => arr(rows).filter((r) => !r.deleted_at);
  const term = pickTerm(T.term);
  const inTerm = (rows) => live(rows).filter((r) => term && String(r.term_id) === String(term.id));
  const users = new Map(live(T.app_user).map((u) => [String(u.id), u]));
  return {
    people: live(T.membership).filter((m) => m.role !== '시스템관리자' && users.has(String(m.user_id))).map((m) => ({ id: num(m.id), name: users.get(String(m.user_id)).name, loginId: users.get(String(m.user_id)).login_id })),
    classes: inTerm(T.classroom).map((c) => ({ id: num(c.id), grade: c.grade, class_no: c.class_no, student_count: c.student_count, homeroom: num(c.homeroom_membership_id) })),
    subjects: live(T.subject).map((s) => ({ id: num(s.id), name: s.name, short_name: s.short_name })),
    rooms: live(T.special_room).map((r) => ({ id: num(r.id), name: r.name })),
    periods: b.org?.period_config ?? {},
    loads: inTerm(T.teaching_load).map((l) => ({ classroom_id: num(l.classroom_id), subject_id: num(l.subject_id), membership_id: num(l.membership_id) })),
    timetables: inTerm(T.timetable).map((t) => t.name),
    pins: inTerm(T.pin).map((p) => `${p.target_kind}:${p.target_id}:${p.weekday}:${p.period}:${p.kind}`),
  };
}

// 원본 열쇠 → 앱 id. create 가 참이면 못 찾은 것을 NEW(넣을 것)로, 아니면 못 옮긴 것으로.
export function match(src, st, { createMissing = false, loginPrefix = '', final = false } = {}) {
  const lost = [];
  const L = (what, id, reason) => lost.push({ what, id: String(id), reason });
  const create = { people: [], classes: [], subjects: [], rooms: [] };
  const have = { people: 0, classes: 0, subjects: 0, rooms: 0 };
  const P = new Map(); const C = new Map(); const S = new Map(); const R = new Map();
  const mkAll = !final && (src.kind === 'backup' || createMissing); // 백업 되넣기는 빈 기관 전제라 다 만든다 · final 은 넣기 뒤 다시 맞출 때(더 만들지 않음)

  // 사람 — 백업은 로그인 ID, 옛 파일은 이름
  for (const p of src.people) {
    let hit;
    if (src.kind === 'backup') {
      const id = (loginPrefix + p.loginId).toLowerCase();
      hit = st.people.filter((x) => String(x.loginId).toLowerCase() === id);
    } else {
      hit = st.people.filter((x) => String(x.name).trim() === p.name);
      if (hit.length > 1) { L('교사', p.name, `명단에 같은 이름이 ${hit.length}명 — 이름으로 못 가른다`); continue; }
    }
    if (hit.length === 1) { P.set(p.key, hit[0].id); have.people++; continue; }
    if (!p.name) { L('교사', p.key, '이름이 비었다'); continue; }
    if (mkAll) { P.set(p.key, NEW); create.people.push({ ...p, loginId: loginPrefix + (p.loginId || p.name) }); continue; }
    L('교사', p.name, final && (src.kind === 'backup' || createMissing) ? '계정을 못 만들었다' : '명단에 없다(--create-missing 이면 계정을 새로 만든다)');
  }
  // 반 — 학년·반 번호. 없는 반은 늘 만든다
  for (const c of src.classes) {
    const hit = st.classes.find((x) => x.grade === c.grade && x.class_no === c.class_no);
    if (hit) { C.set(c.key, hit.id); have.classes++; } else if (!final) { C.set(c.key, NEW); create.classes.push(c); } else L('반', c.label, '반을 못 만들었다');
  }
  // 교과 — 이름, 그다음 줄임말
  for (const s of src.subjects) {
    let hit = st.subjects.filter((x) => x.name === s.name);
    if (!hit.length && src.kind === 'legacy') hit = st.subjects.filter((x) => x.short_name && (x.short_name === s.name || (s.short_name && x.short_name === s.short_name)));
    if (hit.length === 1) { S.set(s.key, hit[0].id); have.subjects++; continue; }
    if (hit.length > 1) { L('과목', s.name, `줄임말이 같은 교과가 ${hit.length}개 — 못 가른다`); continue; }
    if (mkAll) { S.set(s.key, NEW); create.subjects.push(s); continue; }
    L('과목', s.name, final && (src.kind === 'backup' || createMissing) ? '교과를 못 만들었다' : '교과 목록에 없다(--create-missing 이면 새로 만든다)');
  }
  for (const r of src.rooms) {
    const hit = st.rooms.find((x) => x.name === r.name);
    if (hit) { R.set(r.key, hit.id); have.rooms++; continue; }
    if (mkAll) { R.set(r.key, NEW); create.rooms.push(r); continue; }
    L('특별실', r.name, '특별실 목록에 없다 — 그 특별실을 쓰는 시수표 줄은 특별실 없이 넣는다');
  }

  const nameOf = new Map([...src.people, ...src.subjects, ...src.rooms].map((x) => [x.key, x.name]));
  const labelOf = new Map(src.classes.map((c) => [c.key, c.label ?? `${c.grade}-${c.class_no}`]));
  const DAY = '월화수목금토일';

  // 시수표 줄
  const loads = { create: [], have: 0 };
  const ex = new Set(st.loads.map((l) => `${l.classroom_id}:${l.subject_id}:${l.membership_id}`));
  for (const l of src.loads) {
    const where = `${labelOf.get(l.classKey) ?? '전체'} ${nameOf.get(l.subjectKey) ?? ''} ${nameOf.get(l.personKey) ?? ''}`.trim();
    const classroom_id = l.classKey ? C.get(l.classKey) : null;
    const subject_id = l.subjectKey ? S.get(l.subjectKey) : null;
    const membership_id = l.personKey ? P.get(l.personKey) : null;
    if (classroom_id === undefined) { L('시수표 줄', where, '반을 못 맞췄다'); continue; }
    if (subject_id === undefined) { L('시수표 줄', where, `과목 「${nameOf.get(l.subjectKey) ?? '?'}」 을 못 맞췄다`); continue; }
    if (membership_id === undefined) { L('시수표 줄', where, `교사 「${nameOf.get(l.personKey) ?? '?'}」 를 못 맞췄다`); continue; }
    let second = l.secondKey ? P.get(l.secondKey) : null;
    if (second === undefined) { L('시수표 둘째 교사', where, `둘째 교사 「${nameOf.get(l.secondKey) ?? '?'}」 를 못 맞춰 첫째 교사만 넣었다`); second = null; }
    let room = l.roomKey ? R.get(l.roomKey) : null;
    if (room === undefined) { L('시수표 특별실', where, `특별실 「${nameOf.get(l.roomKey) ?? '?'}」 을 못 맞춰 특별실 없이 넣었다`); room = null; }
    if (ex.has(`${classroom_id}:${subject_id}:${membership_id}`)) { loads.have++; continue; }
    loads.create.push({ membership_id, second_membership_id: second, second_hours: second ? l.second_hours : null, subject_id, classroom_id, special_room_id: room, weekly_hours: l.weekly_hours, block: l.block, sync_progress: l.sync_progress });
  }

  // 시간표 → 시안
  const tts = { create: [], have: 0 };
  for (const t of src.timetables) {
    if (st.timetables.includes(t.name)) { tts.have++; L('시간표', t.name, '같은 이름 시간표가 이미 있어 건너뛰었다'); continue; }
    const cells = [];
    for (const c of t.cells) {
      const at = `${t.name} ${labelOf.get(c.classKey) ?? '?'} ${DAY[c.weekday - 1]} ${c.period}교시`;
      const classroom_id = C.get(c.classKey);
      if (classroom_id === undefined) { L('시간표 칸', at, '반을 못 맞춰 칸을 뺐다'); continue; }
      const pick = (key, map, label) => {
        if (!key) return null;
        const v = map.get(key);
        if (v === undefined) { L('시간표 칸', at, `${label} 「${nameOf.get(key) ?? '?'}」 를 못 맞춰 빈 채로 넣었다`); return null; }
        return v;
      };
      cells.push({ classroom_id, weekday: c.weekday, period: c.period, subject_id: pick(c.subjectKey, S, '과목'), membership_id: pick(c.personKey, P, '교사'), second_membership_id: pick(c.secondKey, P, '둘째 교사'), special_room_id: pick(c.roomKey, R, '특별실') });
    }
    tts.create.push({ name: t.name, cells });
  }

  // 고정·금지(백업만)
  const pins = { create: [], have: 0 };
  const exPin = new Set(st.pins);
  const PMAP = { 교사: P, 반: C, 특별실: R };
  for (const p of src.pins) {
    const target_id = PMAP[p.target_kind]?.get(p.targetKey);
    if (target_id === undefined) { L('고정·금지', `${p.target_kind} ${DAY[p.weekday - 1]} ${p.period}교시`, '대상을 못 맞췄다'); continue; }
    const subject_id = p.subjectKey ? S.get(p.subjectKey) ?? null : null;
    if (exPin.has(`${p.target_kind}:${target_id}:${p.weekday}:${p.period}:${p.kind}`)) { pins.have++; continue; }
    pins.create.push({ target_kind: p.target_kind, target_id, weekday: p.weekday, period: p.period, kind: p.kind, subject_id });
  }

  // 교시 — 원본 학년만 덮는다(다른 학년·공통 시각은 그대로)
  let periods = null;
  if (src.periods) {
    const cur = st.periods ?? {};
    const grades = { ...(cur.grades ?? {}) };
    const changed = [];
    for (const [g, v] of Object.entries(src.periods.grades ?? {})) {
      if (JSON.stringify(grades[g]) !== JSON.stringify(v)) changed.push(g);
      grades[g] = v;
    }
    const times = cur.times ?? src.periods.times;
    if (changed.length) periods = { body: { grades, ...(times ? { times } : {}) }, changed };
  }

  return { P, C, S, R, create, have, loads, tts, pins, periods, lost };
}

// 미리보기 표 — [항목, 원본, 이미 있음, 새로 넣음, 못 옮김]
export function summarize(src, m) {
  const by = (what) => m.lost.filter((x) => x.what === what).length;
  const cellsNew = m.tts.create.reduce((n, t) => n + t.cells.length, 0);
  const cellsSrc = src.timetables.reduce((n, t) => n + t.cells.length, 0);
  return [
    ['교사(명단)', src.people.length, m.have.people, m.create.people.length, by('교사')],
    ['반', src.classes.length, m.have.classes, m.create.classes.length, 0],
    ['과목', src.subjects.length, m.have.subjects, m.create.subjects.length, by('과목')],
    ['특별실', src.rooms.length, m.have.rooms, m.create.rooms.length, by('특별실')],
    ['교시 설정(학년)', Object.keys(src.periods?.grades ?? {}).length, Object.keys(src.periods?.grades ?? {}).length - (m.periods?.changed.length ?? 0), m.periods?.changed.length ?? 0, 0],
    ['시수표 줄', src.loads.length, m.loads.have, m.loads.create.length, by('시수표 줄')],
    ['시간표(시안)', src.timetables.length, m.tts.have, m.tts.create.length, 0],
    ['시간표 칸', cellsSrc, 0, cellsNew, cellsSrc - cellsNew],
    ['고정·금지', src.pins.length, m.pins.have, m.pins.create.length, by('고정·금지')],
  ];
}

export function renderTable(rows) {
  const head = ['항목', '원본', '이미 있음', '새로 넣음', '못 옮김'];
  return [head, ...rows].map((r) => r.join(' | ')).map((s) => `| ${s} |`).join('\n');
}

const snapshot = async (c) => stateFromBackup(await c.ok('GET', c.org('/backup')));

// 교과가 하나도 없는 기관은 넣기 첫머리에 기본 교과(server/presets/subjects.json)가 생긴다 — 미리보기도 그걸 전제로 맞춘다
function presetSubjects() {
  try {
    const j = JSON.parse(readFileSync(new URL('../../server/presets/subjects.json', import.meta.url), 'utf8'));
    return arr(j.subjects).map(([name, short_name]) => ({ id: 'PRESET', name, short_name }));
  } catch { return []; }
}

// 미리보기 — 읽기만(GET /backup 한 번)
export async function preview(c, src, opts) {
  const st = await snapshot(c);
  if (!st.subjects.length && src.subjects.length) st.subjects = presetSubjects();
  const m = match(src, st, opts);
  return { rows: summarize(src, m), lost: [...src.lost, ...m.lost], m };
}

// 넣기 — 차례: 명단 → 반·교과·특별실·교시 → 담임·학생 수 → 시수표 → 시안 → 고정·금지
export async function apply(c, src, opts = {}) {
  const log = opts.log ?? (() => {});
  const accounts = []; // 새 계정의 임시 비밀번호 — 결과 파일에만
  const done = { people: 0, classes: 0, subjects: 0, rooms: 0, periods: 0, homerooms: 0, loads: 0, timetables: 0, cells: 0, pins: 0 };
  const failed = [];
  let st = await snapshot(c);
  // 교과가 하나도 없는 기관은 첫 교과 쓰기 때 기본 교과가 먼저 생긴다 — 미리 생기게 해 두고 거기에 맞춘다
  if (!st.subjects.length && src.subjects.length) { await c.ok('GET', c.org('/subjects')); st = await snapshot(c); }

  // 1. 명단 — 명단 올리기 길(줄마다 임시 비밀번호)
  let m = match(src, st, opts);
  if (m.create.people.length) {
    const rows = m.create.people.map((p) => ({ name: p.name, loginId: p.loginId, role: p.role ?? '교직원', duty: p.duty ?? '' }));
    for (let i = 0; i < rows.length; i += 500) {
      const part = rows.slice(i, i + 500);
      let r = await c.call('POST', c.org('/roster/import'), { rows: part });
      if (r.status === 409 && r.json?.needConfirm) r = await c.call('POST', c.org('/roster/import'), { rows: part, confirm: true });
      if (r.status !== 200) throw new Error(`명단 올리기 실패 ${r.status} ${r.json?.error ?? ''}`);
      for (const x of r.json.results) {
        if (x.ok) { done.people++; accounts.push({ name: x.name, loginId: x.loginId, tempPassword: x.temp }); } else failed.push({ what: '교사', id: x.name || x.loginId, reason: `계정을 못 만들었다: ${x.error}` });
      }
    }
    log(`명단 ${done.people}명 만듦`);
    st = await snapshot(c);
    m = match(src, st, opts);
  }
  // 명단에서 못 만든 사람은 3단계의 final 맞추기에서 「계정을 못 만들었다」로 빠진다(다시 만들지 않음)

  // 2. 반 · 교과 · 특별실 · 교시
  for (const x of m.create.classes) {
    const r = await c.call('POST', c.org('/classrooms'), { grade: x.grade, class_no: x.class_no, ...(x.student_count != null ? { student_count: x.student_count } : {}) });
    if (r.status === 201) done.classes++; else failed.push({ what: '반', id: x.label ?? `${x.grade}-${x.class_no}`, reason: `못 만들었다(${r.status} ${r.json?.error ?? ''})` });
  }
  for (const x of m.create.subjects) {
    const r = await c.call('POST', c.org('/subjects'), { name: x.name, ...(x.short_name ? { short_name: x.short_name } : {}), ...(x.color ? { color: x.color } : {}) });
    if (r.status === 201) done.subjects++; else failed.push({ what: '과목', id: x.name, reason: `못 만들었다(${r.status} ${r.json?.error ?? ''})` });
  }
  for (const x of m.create.rooms) {
    const r = await c.call('POST', c.org('/special-rooms'), { name: x.name, ...(x.purpose ? { purpose: x.purpose } : {}), ...(x.capacity != null ? { capacity: x.capacity } : {}) });
    if (r.status === 201) done.rooms++; else failed.push({ what: '특별실', id: x.name, reason: `못 만들었다(${r.status} ${r.json?.error ?? ''})` });
  }
  if (m.periods) {
    const r = await c.call('PUT', c.org('/school/periods'), m.periods.body);
    if (r.status === 200) done.periods = m.periods.changed.length; else failed.push({ what: '교시 설정', id: m.periods.changed.join(','), reason: `못 넣었다(${r.status} ${r.json?.error ?? ''})` });
  }
  st = await snapshot(c);
  m = match(src, st, { ...opts, final: true });

  // 3. 담임 · 학생 수(비어 있는 칸만 채운다)
  for (const x of src.classes) {
    const id = m.C.get(x.key);
    const cur = st.classes.find((y) => y.id === id);
    if (!cur) continue;
    const hr = x.homeroomKey ? m.P.get(x.homeroomKey) : undefined;
    const body = {};
    if (hr && hr !== NEW && !cur.homeroom) body.homeroom_membership_id = hr;
    if (x.student_count != null && cur.student_count == null) body.student_count = x.student_count;
    if (!Object.keys(body).length) continue;
    const r = await c.call('PATCH', c.org(`/classrooms/${id}`), body);
    if (r.status === 200) done.homerooms++; else failed.push({ what: '반 담임', id: x.label, reason: `못 붙였다(${r.status})` });
  }

  // 4. 시수표 줄
  for (const l of m.loads.create) {
    const body = Object.fromEntries(Object.entries(l).filter(([, v]) => v !== null && v !== undefined));
    const r = await c.call('POST', c.org('/loads'), body);
    if (r.status === 201) done.loads++; else failed.push({ what: '시수표 줄', id: JSON.stringify(body), reason: `못 넣었다(${r.status} ${r.json?.error ?? ''})` });
  }
  // 5. 시간표 — 시안 저장 길(확정본은 안 건드린다)
  for (const t of m.tts.create) {
    const r = await c.call('POST', c.org('/timetables/generated'), { name: t.name, cells: t.cells });
    if (r.status === 201) { done.timetables++; done.cells += t.cells.length; } else failed.push({ what: '시간표', id: t.name, reason: `못 넣었다(${r.status} ${r.json?.error ?? ''})` });
  }
  // 6. 고정·금지
  for (const p of m.pins.create) {
    const r = await c.call('POST', c.org('/pins'), p);
    if (r.status === 201) done.pins++; else if (r.status !== 409) failed.push({ what: '고정·금지', id: `${p.target_kind} ${p.weekday}-${p.period}`, reason: `못 넣었다(${r.status})` });
  }
  log('넣기 끝');
  return { done, accounts, lost: [...src.lost, ...m.lost, ...failed] };
}
