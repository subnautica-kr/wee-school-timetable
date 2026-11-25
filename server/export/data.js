// 시간표 → 출력용 표(시트). 세 출력(PDF·엑셀·HWPX)이 같은 시트를 읽는다.
// 시트: { title, header: [칸...], rows: [[칸...]] } · 칸: { text, kind: null|'changche'|'specialist', shade: bool }
import { loadConfig } from '../orgConfig.js';

export async function loadSheetData(pool, orgId, ttId) {
  const q = async (sql, p) => (await pool.query(sql, p)).rows;
  const tt = (await q(`SELECT id, term_id, name, status, starts_on FROM timetable WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [ttId, orgId]))[0];
  if (!tt) return null;
  return {
    tt,
    cells: await q(`SELECT classroom_id, weekday, period, subject_id, membership_id, second_membership_id, special_room_id FROM cell WHERE org_id = $1 AND timetable_id = $2 AND deleted_at IS NULL`, [orgId, tt.id]),
    classrooms: await q(`SELECT id, grade, class_no FROM classroom WHERE org_id = $1 AND term_id = $2 AND deleted_at IS NULL ORDER BY grade, class_no`, [orgId, tt.term_id]),
    subjects: await q(`SELECT id, name, short_name FROM subject WHERE org_id = $1`, [orgId]),
    teachers: await q(`SELECT m.id, m.name, m.duty FROM membership m WHERE m.org_id = $1 AND m.deleted_at IS NULL AND m.role <> '시스템관리자'`, [orgId]),
    rooms: await q(`SELECT id, name FROM special_room WHERE org_id = $1`, [orgId]),
    weekdays: (await loadConfig(pool, orgId)).weekdays,
    periodConfig: (await q(`SELECT period_config FROM org WHERE id = $1`, [orgId]))[0]?.period_config ?? {},
  };
}

export { buildSheets, classSheet, teacherSheet, roomSheet } from '../../shared/sheetCalc.js'; // 계산은 shared 한 곳 — 화면(자동 생성 결과)도 같은 함수

export const sheetsTitle = (d) => `${d.tt.name}${d.tt.status === '확정' ? '' : ' (시안)'}`;
