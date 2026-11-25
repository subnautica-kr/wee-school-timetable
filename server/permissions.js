// 권한 표 — 이 파일이 전부다(모의 해킹 때 「이 표가 전부입니다」로 낸다).
// 설계 「권한 — 역할 × 할 수 있는 일」 표를 그대로 옮겼다. 서버 검사가 방어선이고 버튼 숨김은 편의다.
// 시스템 관리자는 기관 안 데이터를 못 본다 — 기관 안 동작은 하나도 없고 기관 관리 동작만 있다.

export const ROLES = ['시스템관리자', '기관관리자', '교직원', '보기만'];

const ADMIN = '기관관리자';
const STAFF = '교직원';
const VIEW = '보기만';
const SYS = '시스템관리자';

// 동작 이름 → 허용 역할
export const PERMISSIONS = {
  // 기관 밖(상위 기관)
  'org.manage': [SYS], // 기관 등록·상태·첫 관리자·비번 초기화

  // 기관 안
  'school.manage': [ADMIN], // 학교 기본·명단·역할·계정 만들기·비번 초기화
  'timetable.edit': [ADMIN], // 시수표·자동 생성·시안·확정·새 학기
  'timetable.view': [ADMIN, STAFF, VIEW], // 보기·내려받기·인쇄
  'substitute.own': [ADMIN, STAFF], // 보결 올리기·맡기·내 것 취소
  'substitute.force': [ADMIN], // 강제 지정·해제·남의 것 취소
  'booking.own': [ADMIN, STAFF], // 특별실 예약·내 것 취소
  'booking.manage': [ADMIN], // 고정 칸 잠금·남의 예약 취소
  'attendance.own': [ADMIN, STAFF], // 내 근태 입력
  'attendance.manage': [ADMIN], // 남의 근태·월 마감·마감 풀기
  'school.backup': [ADMIN], // 학교 자료 내려받기(백업)
  'audit.view': [ADMIN], // 감사 로그

  // 0.3.0 계정 연결·승인(T-1320b) — 계정·도움·요청은 기능 스위치가 아니라 늘 켜진 바닥
  'member.link': [ADMIN], // 계정 연결·연결 해제·초대 코드 발급·연결 안 된 계정 내보내기
  'member.approve': [ADMIN], // 가입 승인·받은 전출 요청 승인·거절
  'member.transfer': [ADMIN], // 다른 학교에 전출 요청 보내기
  'notify.read': [ADMIN, STAFF, VIEW], // 종(학교·개인 소식 읽기·읽음 표시)

  // 도움·요청(학교 쪽) — 기관 관리자의 처리 상태 바꾸기는 공개 범위 「우리 학교 기관 관리자만」 글뿐(길목에서 가름)
  'board.write': [ADMIN, STAFF, VIEW], // 글쓰기·내 글 보기(소속 없는 계정은 길목이 막음)
  'board.reply': [ADMIN], // 답글
  'board.stage': [ADMIN], // 처리 상태 바꾸기
  // 총괄관리자 쪽(새 글 소식·답글·처리 상태·묶기·태그·총괄관리자 소식 읽기)은 위 'org.manage' 로 가른다 —
  // 「시스템 관리자는 기관 안 동작이 하나도 없다」(test/org-boundary) 를 지키려고 학교 쪽 동작에 SYS 를 안 넣는다.
};

export function can(role, action) {
  const roles = PERMISSIONS[action];
  return Array.isArray(roles) && roles.includes(role);
}
