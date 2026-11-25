// 대조 공용 함수(T-1320b) — 명단 줄과 계정이 같은 사람인지 이름·생년월일로 맞춰 보고, 같은 사람 계정을 찾는다.
// 막지 않고 알린다(바닥 원칙 4): 결과는 경고 재료일 뿐 연결을 막지 않는다. 생년월일은 선택 칸이라 한쪽이 비면 「모름」(null).

// 이름 맞춤 — 앞뒤·가운데 빈칸을 빼고 비교(「홍 길동」 = 「홍길동」)
export const normName = (s) => String(s ?? '').replace(/\s+/g, '').normalize('NFC');
export const sameName = (a, b) => normName(a) !== '' && normName(a) === normName(b);

// 생년월일 맞춤 — Date·'YYYY-MM-DD'·'YYYYMMDD' 를 받는다. 한쪽이라도 비면 null(모름)
export function normBirth(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const d = String(v).replace(/\D/g, '');
  return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
}
export function sameBirth(a, b) {
  const x = normBirth(a);
  const y = normBirth(b);
  return x == null || y == null ? null : x === y;
}

// 대조: { name, birthDate } (명단 줄 쪽 값) 를
//   userId 가 있으면 그 계정과 맞춰 보고(check), 이름이 같은 다른 계정(지우지 않은 것)을 찾는다(candidates).
// 반환 {
//   check: null | { userId, name: bool, birth: bool|null },
//   candidates: [{ userId, loginId, name, birth: bool|null, linkedCount }]  — 이름 같음, 생년월일이 다르다고 확인된 계정은 뺌
// }
export async function matchPerson(db, { name, birthDate = null, userId = null }) {
  let check = null;
  if (userId != null) {
    const u = (await db.query(`SELECT id, name, birth_date FROM app_user WHERE id = $1`, [userId])).rows[0];
    if (u) check = { userId: Number(u.id), name: sameName(name, u.name), birth: sameBirth(birthDate, u.birth_date) };
  }
  const key = normName(name);
  const candidates = [];
  if (key) {
    const rows = (await db.query(
      // 별칭 없이 쓴다 — 명단 이름 출처 검사(name-source)가 「계정 별칭.name + membership」 SQL 을 잡으므로(여기선 계정 이름이 대조 재료라 맞다)
      `SELECT id, login_id, name, birth_date,
              (SELECT count(*)::int FROM membership m WHERE m.user_id = app_user.id AND m.deleted_at IS NULL) AS linked
         FROM app_user
        WHERE deleted_at IS NULL AND regexp_replace(name, '\\s+', '', 'g') = $1
        ORDER BY id`,
      [key],
    )).rows;
    for (const r of rows) {
      const birth = sameBirth(birthDate, r.birth_date);
      if (birth === false) continue;
      candidates.push({ userId: Number(r.id), loginId: r.login_id, name: r.name, birth, linkedCount: r.linked });
    }
  }
  return { check, candidates };
}
