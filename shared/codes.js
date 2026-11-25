// 저장 값 상수 — DB 에 들어가는 값을 코드에서 비교할 땐 이 상수로만 쓴다(T-1320a① · 화면 문구 분리 설계 판정 3).
// 옛 칸의 한국어 값은 「한국어처럼 생긴 코드」다 — 값은 그대로 두고(영어화 마이그레이션 안 함) 화면 낱말은 labels.js 가 낸다.
// 013·014 가 새로 만드는 표·칸은 처음부터 영어 코드. 값을 바꾸려면 이 파일과 마이그레이션 하나로 한다.
// 이 파일은 한국어 허용 목록에 든다(저장 값이라 글자 그대로여야 한다).

const freeze = (o) => Object.freeze(o);

// ── 명단 줄(membership) ─────────────────────────────
// 재직 상태 — 옛 값 '사용'(= 재직)·'숨김'(= 퇴직)은 그대로, '휴직'·'전출' 은 013 이 더함
export const MEMBER_STATUS = freeze({ ACTIVE: '사용', LEAVE: '휴직', TRANSFERRED: '전출', RETIRED: '숨김' });
// 로그인 되는 재직 상태(재직·휴직) — 본 소속 유일 색인도 이 둘만 센다
export const MEMBER_STATUS_LOGIN = freeze([MEMBER_STATUS.ACTIVE, MEMBER_STATUS.LEAVE]);

// 권한(역할) — server/permissions.js 의 ROLES 와 같은 값
export const ROLE = freeze({ SYSADMIN: '시스템관리자', ORG_ADMIN: '기관관리자', STAFF: '교직원', VIEWER: '보기만' });

// ── 기관·계정 ──────────────────────────────────────
export const ORG_STATUS = freeze({ USE: '사용', STOPPED: '중지' });
export const USER_STATUS = freeze({ USE: '사용', LOCKED: '잠김' }); // 휴면은 상태 값이 아니다(연결 줄 0 + dormant_at)

// ── 0.3.0 새 표·칸(영어 코드) ─────────────────────────
export const INVITE_KIND = freeze({ MOVE_IN: 'move_in', CONCURRENT: 'concurrent' });
export const UNLINKED_REASON = freeze({ PENDING_APPROVAL: 'pending_approval', UNLINKED: 'unlinked' });
export const TRANSFER_STATUS = freeze({ WAITING: 'waiting', APPROVED: 'approved', REJECTED: 'rejected', EXPIRED: 'expired' });
export const DORMANT_REASON = freeze({ RETIRED: 'retired', REMOVED: 'removed', LEFT: 'left' });
export const BOARD_KIND = freeze({ BUG: 'bug', USABILITY: 'usability', FEATURE: 'feature', QUESTION: 'question' });
export const BOARD_VISIBILITY = freeze({ ORG_ADMINS: 'org_admins', SYSADMIN: 'sysadmin', ORG_AND_SYSADMIN: 'org_and_sysadmin', PUBLIC: 'public' });
export const BOARD_STAGE = freeze({ RECEIVED: 'received', REVIEWING: 'reviewing', WORKING: 'working', DONE: 'done', HOLD: 'hold' });
