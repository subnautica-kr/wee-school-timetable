import argon2 from 'argon2';
import { tempPassword } from './passwords.js';
import { ROLE, DORMANT_REASON, UNLINKED_REASON, MEMBER_STATUS, MEMBER_STATUS_LOGIN } from '../shared/codes.js';
import { audit, killSessions } from './audit.js';
import { registerCleanup } from './cleanup.js';
import { withTx } from './link.js';
import { notify } from './notify.js';
import { t } from '../shared/text/index.js';

// 해시 강도 한 곳(OWASP 하한). verify 는 해시 안의 값으로 읽어 예전 해시도 통과한다.
export const ARGON = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const ID_RE = /^[^\s/\\<>"'`]{1,100}$/; // 공백·따옴표·슬래시 빼고 한글 허용(이름이 기본 ID)

// 계정(사람) 하나 + 소속 한 줄을 만든다. ID 가 이미 있으면 (existing: 'add') 때만 그 사람에게 소속을 더한다.
// 반환: { userId, membershipId, temp } (소속만 더했으면 temp = null) 또는 { error }
export async function createAccount(db, { orgId, name, loginId, role, duty = null, existing = 'reject' }) {
  const found = (await db.query(`SELECT id, deleted_at FROM app_user WHERE lower(login_id) = lower($1)`, [loginId])).rows[0];
  let userId;
  let temp = null;
  if (found) {
    if (existing !== 'add' || found.deleted_at) return { error: '이미 쓰고 있는 ID 입니다' };
    userId = found.id;
    const m = (await db.query(`SELECT 1 FROM membership WHERE user_id = $1 AND org_id = $2 AND deleted_at IS NULL`, [userId, orgId])).rows[0];
    if (m) return { error: '이 기관에 이미 소속된 사람입니다' };
  } else {
    temp = tempPassword();
    const ins = await db.query(
      `INSERT INTO app_user (name, login_id, password_hash, must_change_password) VALUES ($1,$2,$3,TRUE)
       ON CONFLICT (lower(login_id)) DO NOTHING RETURNING id`,
      [name, loginId, await argon2.hash(temp, ARGON)],
    );
    if (!ins.rows[0]) return { error: '이미 쓰고 있는 ID 입니다' };
    userId = ins.rows[0].id;
  }
  const m = await db.query(`INSERT INTO membership (org_id, user_id, role, duty, linked_at) VALUES ($1,$2,$3,$4, now()) RETURNING id`, [orgId, userId, role, duty]);
  // 계정이 든 줄을 만드는 것도 「연결」이다 — 처음 연결 시각을 채우고 휴면을 푼다(T-1320b · 줄 먼저 만들고 잇는 길은 link.js)
  await db.query(`UPDATE app_user SET first_linked_at = COALESCE(first_linked_at, now()), dormant_at = NULL, dormant_reason = NULL WHERE id = $1`, [userId]);
  return { userId: Number(userId), membershipId: Number(m.rows[0].id), temp };
}

// 계정 없는 명단 줄 하나(T-1302a① 새 길) — 이름만 있으면 줄. 계정 연결은 따로 하는 일(link.js).
// 반환: { membershipId }
export async function createLine(db, { orgId, name, role = ROLE.STAFF, duty = null, birthDate = null }) {
  const m = await db.query(
    `INSERT INTO membership (org_id, role, name, duty, birth_date) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [orgId, role, name, duty, birthDate],
  );
  return { membershipId: Number(m.rows[0].id) };
}

// 임시 비밀번호로 되돌린다(관리자가 본인 비밀번호를 정하지는 못한다). 잠금도 풀고 첫 로그인 상태로.
export async function resetPassword(db, userId) {
  const temp = tempPassword();
  await db.query(
    `UPDATE app_user SET password_hash = $2, must_change_password = TRUE, failed_count = 0, locked_until = NULL WHERE id = $1`,
    [userId, await argon2.hash(temp, ARGON)],
  );
  return temp;
}

// 계정만 만든다(T-1302b① 「계정 만들어 주기」 — 계정 없는 줄에 이어 붙일 때). 연결은 부른 쪽이 linkAccount 로.
// 반환: { userId, temp } 또는 { error: '<문구 키>' }
export async function createUserOnly(db, { name, loginId, birthDate = null }) {
  const temp = tempPassword();
  const ins = await db.query(
    `INSERT INTO app_user (name, login_id, password_hash, must_change_password, birth_date) VALUES ($1,$2,$3,TRUE,$4)
     ON CONFLICT (lower(login_id)) DO NOTHING RETURNING id`,
    [name, loginId, await argon2.hash(temp, ARGON), birthDate],
  );
  if (!ins.rows[0]) return { error: 'roster.err.login_taken' };
  return { userId: Number(ins.rows[0].id), temp };
}

// 「연결 안 된 계정」 묶음에서 학교 밖으로 내보내기(T-1302b①) — 손으로 누를 때와 30일 자동이 같이 쓴다.
// 묶음 줄을 닫고, 다른 소속(지우지 않은 연결 줄)이 없으면 휴면(사유 removed) · 세션 끊기 · 감사.
// 반환 { ok, userId, dormant } 또는 { error }
export async function releaseUnlinked(db, { orgId, userId, byUserId = null, auto = false }) {
  const row = (await db.query(
    `UPDATE unlinked_account SET resolved_at = now()
      WHERE org_id = $1 AND user_id = $2 AND reason = $3 AND resolved_at IS NULL RETURNING id`,
    [orgId, userId, UNLINKED_REASON.UNLINKED],
  )).rows;
  if (!row.length) return { error: 'roster.err.unlinked_not_found' };
  const other = (await db.query(`SELECT 1 FROM membership WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1`, [userId])).rows[0];
  if (!other) {
    await db.query(
      `UPDATE app_user SET dormant_at = COALESCE(dormant_at, now()), dormant_reason = COALESCE(dormant_reason, $2) WHERE id = $1`,
      [userId, DORMANT_REASON.REMOVED],
    );
  }
  await killSessions(db, userId);
  await audit(db, {
    orgId, userId: byUserId, action: 'roster.unlinked-release', table: 'app_user', rowId: userId, after: { auto, dormant: !other },
  });
  return { ok: true, userId: Number(userId), dormant: !other };
}

// 전입 코드로 온 사람의 「앞 학교 줄」 — 다른 학교의 본 소속(겸임 아님) · 로그인 되는 재직 상태 · 총괄관리자 줄 빼고.
// 코드 입력(signup.js applyCode)과 가입 승인(roster.js · T-1322a 「승인 순간 전출」)이 같이 쓴다. 반환 [{ id, org_name }]
export async function moveInFrom(db, userId, orgId) {
  return (await db.query(
    `SELECT m.id, o.name AS org_name FROM membership m JOIN org o ON o.id = m.org_id
      WHERE m.user_id = $1 AND m.org_id <> $2 AND m.deleted_at IS NULL AND NOT m.is_concurrent
        AND m.status = ANY($3::text[]) AND m.role <> $4`,
    [userId, orgId, MEMBER_STATUS_LOGIN, ROLE.SYSADMIN],
  )).rows;
}
// 앞 학교 줄을 「전출」로 — 연결(linkAccount)보다 먼저 불러야 새 학교 줄이 본 소속이 된다
export async function moveOut(db, { from, orgId, membershipId, byUserId }) {
  if (!from.length) return;
  await db.query(`UPDATE membership SET status = $2 WHERE id = ANY($1::bigint[])`, [from.map((x) => x.id), MEMBER_STATUS.TRANSFERRED]);
  await audit(db, { orgId, userId: byUserId, action: 'signup.move', table: 'membership', rowId: membershipId, after: { from: from.map((x) => Number(x.id)) } });
}

// 30일 동안 묶음에 그대로 있으면 저절로 내보내고 학교 소식 한 줄(기관 관리자에게 정리 의무를 지우지 않는다)
registerCleanup('unlinked-30d', async (db, now) => {
  const due = (await db.query(
    `SELECT ua.org_id, ua.user_id, u.name FROM unlinked_account ua JOIN app_user u ON u.id = ua.user_id
      WHERE ua.reason = $1 AND ua.resolved_at IS NULL AND ua.expires_at <= $2`,
    [UNLINKED_REASON.UNLINKED, now],
  )).rows;
  let n = 0;
  for (const d of due) {
    const r = await withTx(db, (c) => releaseUnlinked(c, { orgId: d.org_id, userId: d.user_id, auto: true }));
    if (r.error) continue;
    await notify(db, { orgId: d.org_id, kind: 'roster_unlinked_released', text: t('roster.notice_unlinked.released', { 이름: d.name ?? '' }) });
    n++;
  }
  return n;
});
