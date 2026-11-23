// 지우기 창이 쓰는 순수 함수 — 시험은 test/delete-dialog.test.js
// 확인 글자: 앞뒤 공백만 봐주고 나머지는 그대로 같아야 한다(서버도 학기 이름은 trim 해서 비교)
export const confirmReady = (typed, expected) => !!expected && String(typed ?? '').trim() === String(expected).trim();

// 기관 삭제 미리보기의 counts 꼴 → 줄글
const ORG_COUNT = {
  accounts: '이 기관에서만 쓰던 계정',
  classrooms: '반', terms: '학기', timetables: '시간표', subjects: '교과', specialRooms: '특별실',
};
// 미리보기(effects 꼴 · 기관 삭제 counts 꼴)를 「이름 수」 줄 목록으로. 수 0 은 숨긴다.
export function effectLines(p) {
  if (!p) return [];
  const a = (p.effects || []).filter((e) => e.count > 0).map((e) => `${e.label} ${e.count}개`);
  const b = Object.entries(p.counts || {}).filter(([k, n]) => n > 0 && ORG_COUNT[k]).map(([k, n]) => `${ORG_COUNT[k]} ${n}개`);
  if (p.counts?.concurrentKept > 0) b.push(`다른 기관에도 속한 계정 ${p.counts.concurrentKept}개는 이 기관 소속만 떼고 계정은 남습니다`);
  return [...a, ...b];
}

// 보관함 묶음 종류 → 쉬운 말
export const KIND_NAME = {
  classroom: '반', membership: '교사(이 학교에서 뺌)', subject: '교과', special_room: '특별실', timetable: '시간표',
  term: '새 학기(되돌리기로 지움)', term_clear: '학기 비우기',
};
