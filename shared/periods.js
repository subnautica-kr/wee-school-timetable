// 하루 교시 수를 묻는 곳은 전부 여기를 거친다(T-1205 · 선생님 요청 9번 — 요일별 교시 수).
// 설정 꼴: period_config.grades[학년] = { periods: 5, byDay?: { '3': 4 } } — byDay 는 선택. 비운 요일은 학년 기본 교시 수.
const gradeOf = (cfg, grade) => cfg?.grades?.[grade] ?? cfg?.grades?.[String(grade)] ?? null;

// 그 학년 그 요일(1=월 …)의 교시 수. 요일을 안 주면 학년 기본. 학년 값이 없으면 fallback.
export function periodsOn(cfg, grade, weekday, fallback = 5) {
  const g = gradeOf(cfg, grade);
  const d = weekday == null ? 0 : Number(g?.byDay?.[String(weekday)]);
  if (d > 0) return d;
  const n = Number(g?.periods);
  return n > 0 ? n : fallback;
}

// 그 학년의 가장 긴 날 교시 수(격자 줄 수·출력물 줄 수)
export function periodsMax(cfg, grade, fallback = 5) {
  const g = gradeOf(cfg, grade);
  const days = Object.keys(g?.byDay ?? {});
  return Math.max(periodsOn(cfg, grade, null, fallback), ...days.map((w) => periodsOn(cfg, grade, w, fallback)));
}

// 한 주 교시 합(weekdays = 요일 수 또는 요일 번호 배열)
export function weekPeriods(cfg, grade, weekdays = 5, fallback = 5) {
  const ws = Array.isArray(weekdays) ? weekdays.map((_, i) => i + 1) : Array.from({ length: weekdays }, (_, i) => i + 1);
  return ws.reduce((a, w) => a + periodsOn(cfg, grade, w, fallback), 0);
}

// 시수 합이 한 주 교시 합을 넘는 반 — 막지 않고 알림만. → [{ classroom_id, grade, class_no, hours, cap }]
export function overHours(classrooms, lines, cfg, weekdays = 5, fallback = 5) {
  const sum = new Map();
  for (const l of lines || []) sum.set(String(l.classroom_id), (sum.get(String(l.classroom_id)) || 0) + (Number(l.weekly_hours) || 0));
  const out = [];
  for (const c of classrooms || []) {
    const hours = sum.get(String(c.id)) || 0;
    const cap = weekPeriods(cfg, c.grade, weekdays, fallback);
    if (hours > cap) out.push({ classroom_id: c.id, grade: c.grade, class_no: c.class_no, hours, cap });
  }
  return out;
}

// 그 요일 교시 수 밖에 놓인 칸(교시 수를 줄여도 칸은 안 지운다 — 알림용)
export function outsideCells(classrooms, cfg, cells, fallback = 5) {
  const gradeById = new Map((classrooms || []).map((c) => [String(c.id), c.grade]));
  return (cells || []).filter((c) => c.subject_id && gradeById.has(String(c.classroom_id)) && c.period > periodsOn(cfg, gradeById.get(String(c.classroom_id)), c.weekday, fallback));
}
