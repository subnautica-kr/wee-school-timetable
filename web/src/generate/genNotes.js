// 순수: 생성기 후보의 알림(solve 결과 warnings, {rule}) → 화면 문구.
// 모르는 코드는 건너뛴다(화면이 깨지지 않게). 둘째 교사 알림 second_block 은 막지 않고 알리기만 한다(T-1206).
const TEXT = {
  second_block: '둘째 교사를 연강 묶음째로 붙였습니다(함께 시수보다 많을 수 있음)',
};

export function genNoteTexts(cand) {
  const list = cand?.warnings || [];
  const seen = new Set();
  const out = [];
  for (const a of list) {
    const code = typeof a === 'string' ? a : a?.code || a?.rule || a?.kind;
    if (!TEXT[code] || seen.has(code)) continue;
    seen.add(code);
    out.push(TEXT[code]);
  }
  return out;
}
