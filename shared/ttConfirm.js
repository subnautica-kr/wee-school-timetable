import { periodsOn } from './periods.js';

// 확정 전 재확인 문구 — 막지 않고 개수만 알린다. 빈칸 = 반별 (요일마다 그날 교시 수의 합) - 그 안에 채운 칸.
// weekdays: 요일 수(기본 5) 또는 기관 설정 weekdays 배열
export function emptyCount(classrooms, periods, cells, weekdays = 5) {
  const ws = Array.isArray(weekdays) ? weekdays.length : weekdays;
  let total = 0;
  const pOf = new Map();
  for (const c of classrooms) {
    for (let w = 1; w <= ws; w++) total += periodsOn(periods, c.grade, w);
    if (c.id != null) pOf.set(String(c.id), c.grade);
  }
  // 반 id 를 아는 칸은 그날 교시 수 안의 칸만 센다(교시 수 밖 칸은 따로 알린다)
  const inside = cells.filter((c) => c.subject_id && !(pOf.has(String(c.classroom_id)) && c.period > periodsOn(periods, pOf.get(String(c.classroom_id)), c.weekday)));
  return Math.max(0, total - inside.length);
}
export function confirmText(name, date, violations, empty, outside = 0) {
  const bits = [];
  if (violations) bits.push(`겹침·알림 ${violations}곳`);
  if (empty) bits.push(`빈칸 ${empty}칸`);
  if (outside) bits.push(`교시 수 밖에 있는 칸 ${outside}칸`);
  return `「${name}」을 ${date}부터 확정합니다.${bits.length ? ` ${bits.join(' · ')}이 남아 있습니다. 그래도 확정할까요?` : ' 확정하면 교직원 화면에 뜹니다.'}`;
}
