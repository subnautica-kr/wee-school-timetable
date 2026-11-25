// 기관 관리자 연락처(org.config.contact) — 읽기와 「적기 권유」 한 번 표시(contactNudgeSeen). 값은 늘 한 학교 것만 읽는다.
export async function orgContact(db, orgId) {
  if (orgId == null) return '';
  const row = (await db.query(`SELECT config->>'contact' AS c FROM org WHERE id = $1 AND deleted_at IS NULL`, [orgId])).rows[0];
  return typeof row?.c === 'string' ? row.c.trim() : '';
}

// 권유를 보일 차례인가 — 연락처가 비었고 아직 한 번도 안 보였을 때만 true, 그 자리에서 「보였다」를 적는다(동시에 둘이 불러도 한 쪽만 true).
export async function takeContactNudge(db, orgId) {
  const r = await db.query(
    `UPDATE org SET config = COALESCE(config, '{}'::jsonb) || '{"contactNudgeSeen": true}'::jsonb
      WHERE id = $1 AND deleted_at IS NULL AND COALESCE(config->>'contact', '') = '' AND COALESCE(config->>'contactNudgeSeen', '') <> 'true'`,
    [orgId],
  );
  return r.rowCount === 1;
}
