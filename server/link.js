// 계정 「연결」·「해제」 공용 함수(T-1320b) — 명단 줄과 계정을 잇고 떼는 길은 전부 이 둘을 부른다.
// 설계 「작업 계획·배분」 ① : 연결 = 계정 칸·연결 시각·처음 연결 시각·그 줄 초대 코드 무효·묶음 줄 닫기·휴면 풀기
//                            해제 = 계정 칸 비움·권한 교직원으로·그 계정 세션 끊기·다른 소속 없으면 휴면
// 둘 다 거래(트랜잭션) 하나로 돈다. db 가 풀이면 여기서 거래를 열고, 클라이언트면 부른 쪽 거래 안에서 돈다.
// 실패는 던지지 않고 { error: '<문구 키>' } 로 돌려준다 — 부른 길목이 fail(res, 409, error) 로 낸다.
import { audit, killSessions } from './audit.js';
import { ROLE, DORMANT_REASON, UNLINKED_REASON } from '../shared/codes.js';

// 풀이면 클라이언트를 빌려 BEGIN/COMMIT, 이미 클라이언트(거래 안)면 그대로 쓴다
export async function withTx(db, fn) {
  if (typeof db.connect !== 'function' || typeof db.release === 'function') return fn(db);
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    if (r && r.error) await c.query('ROLLBACK');
    else await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const UNLINKED_DAYS = 30;

// 연결: 명단 줄(membershipId)에 계정(userId)을 잇는다.
// 반환 { ok: true, membershipId, userId, isConcurrent } 또는 { error }
export async function linkAccount(db, { membershipId, userId, byUserId = null }) {
  return withTx(db, async (c) => {
    const line = (await c.query(
      `SELECT id, org_id, user_id, deleted_at FROM membership WHERE id = $1 FOR UPDATE`, [membershipId],
    )).rows[0];
    if (!line || line.deleted_at) return { error: 'roster.err.line_not_found' };
    if (line.user_id != null) {
      if (Number(line.user_id) === Number(userId)) return { error: 'roster.err.already_linked' };
      return { error: 'roster.err.line_taken' };
    }
    const user = (await c.query(`SELECT id, deleted_at FROM app_user WHERE id = $1 FOR UPDATE`, [userId])).rows[0];
    if (!user || user.deleted_at) return { error: 'roster.err.account_not_found' };
    const same = (await c.query(
      `SELECT 1 FROM membership WHERE user_id = $1 AND org_id = $2 AND deleted_at IS NULL`, [userId, line.org_id],
    )).rows[0];
    if (same) return { error: 'roster.err.account_in_org' };

    // 계정 칸 · 연결 시각 — 본 소속이 이미 있으면 013 트리거가 겸임으로 둔다
    const up = (await c.query(
      `UPDATE membership SET user_id = $2, linked_at = now(), linked_by = $3 WHERE id = $1 RETURNING is_concurrent`,
      [membershipId, userId, byUserId],
    )).rows[0];
    // 처음 연결 시각 · 휴면 풀기
    await c.query(
      `UPDATE app_user SET first_linked_at = COALESCE(first_linked_at, now()), dormant_at = NULL, dormant_reason = NULL WHERE id = $1`,
      [userId],
    );
    // 그 줄의 살아 있는 초대 코드 무효(이미 연결된 줄에 또 연결하려는 일이 안 생기게)
    await c.query(
      `UPDATE invite_code SET revoked_at = now() WHERE membership_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [membershipId],
    );
    // 이 계정의 「연결 안 된 계정」 묶음 줄 닫기(승인 대기·연결 해제 — 어느 학교든)
    await c.query(`UPDATE unlinked_account SET resolved_at = now() WHERE user_id = $1 AND resolved_at IS NULL`, [userId]);
    await audit(c, {
      orgId: line.org_id, userId: byUserId, action: 'link', table: 'membership', rowId: membershipId,
      after: { user_id: Number(userId), is_concurrent: up.is_concurrent },
    });
    return { ok: true, membershipId: Number(membershipId), userId: Number(userId), isConcurrent: up.is_concurrent };
  });
}

// 해제: 명단 줄(membershipId)에서 계정을 뗀다.
//   reason  — 다른 소속이 없어 휴면이 될 때 적는 사유(DORMANT_REASON: retired·removed·left)
//   listUnlinked — true 면 「연결 안 된 계정」 묶음(연결 해제 · 30일)에 세운다(기관 관리자가 줄 메뉴에서 한 해제만)
// 반환 { ok: true, membershipId, userId, dormant } 또는 { error }
export async function unlinkAccount(db, { membershipId, byUserId = null, reason = DORMANT_REASON.REMOVED, listUnlinked = false }) {
  if (!Object.values(DORMANT_REASON).includes(reason)) throw new Error(`unlinkAccount: reason ${reason}`);
  return withTx(db, async (c) => {
    const line = (await c.query(
      `SELECT id, org_id, user_id, role, deleted_at FROM membership WHERE id = $1 FOR UPDATE`, [membershipId],
    )).rows[0];
    if (!line) return { error: 'roster.err.line_not_found' };
    if (line.user_id == null) return { error: 'roster.err.not_linked' };
    const userId = line.user_id;

    // 계정 칸 비움 · 기관 관리자 권한은 교직원으로(보기만은 그대로) · 겸임 표시도 내림
    await c.query(
      `UPDATE membership SET user_id = NULL, is_concurrent = FALSE,
         role = CASE WHEN role = $2 THEN $3 ELSE role END WHERE id = $1`,
      [membershipId, ROLE.ORG_ADMIN, ROLE.STAFF],
    );
    // 그 줄의 살아 있는 초대 코드도 무효(떼어 낸 계정이 옛 코드로 되돌아오지 않게)
    await c.query(
      `UPDATE invite_code SET revoked_at = now() WHERE membership_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [membershipId],
    );
    if (listUnlinked) {
      await c.query(
        `INSERT INTO unlinked_account (org_id, user_id, reason, membership_id, expires_at)
         VALUES ($1,$2,$3,$4, now() + make_interval(days => $5))`,
        [line.org_id, userId, UNLINKED_REASON.UNLINKED, membershipId, UNLINKED_DAYS],
      );
    }
    // 다른 소속(지우지 않은 연결 줄)이 없으면 휴면
    const other = (await c.query(
      `SELECT 1 FROM membership WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1`, [userId],
    )).rows[0];
    const dormant = !other;
    if (dormant) {
      await c.query(`UPDATE app_user SET dormant_at = now(), dormant_reason = $2 WHERE id = $1`, [userId, reason]);
    }
    // 그 계정 세션 끊기(학교 세션에 남은 권한·소속이 그대로 살지 않게)
    await killSessions(c, userId);
    await audit(c, {
      orgId: line.org_id, userId: byUserId, action: 'unlink', table: 'membership', rowId: membershipId,
      before: { user_id: Number(userId), role: line.role }, after: { dormant, reason: dormant ? reason : null },
    });
    return { ok: true, membershipId: Number(membershipId), userId: Number(userId), dormant };
  });
}
