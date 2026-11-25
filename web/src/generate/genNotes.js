// 순수: 생성기 후보의 알림(solve 결과 warnings, {rule}) → 화면 문구.
// 모르는 코드는 건너뛴다(화면이 깨지지 않게). 둘째 교사 알림 second_block 은 막지 않고 알리기만 한다(T-1206).
// 문구는 shared/text/generate.js 의 note 묶음. room_block_whole 은 방 사용 시수보다 더 붙인 시수를 합쳐 한 줄로 말한다(T-1327a).
import { t } from '../../../shared/text/index.js';

const TEXT = {
  second_block: () => t('generate.note.second_block'),
  room_block_whole: (list) => {
    const 더 = list.reduce((a, w) => a + Math.max(0, (Number(w.hours) || 0) - (Number(w.room_hours) || 0)), 0);
    return t('generate.note.room_block_whole', { 더 });
  },
};

export function genNoteTexts(cand) {
  const list = cand?.warnings || [];
  const by = new Map();
  for (const a of list) {
    const code = typeof a === 'string' ? a : a?.code || a?.rule || a?.kind;
    if (!TEXT[code]) continue;
    if (!by.has(code)) by.set(code, []);
    by.get(code).push(typeof a === 'string' ? {} : a);
  }
  return [...by].map(([code, items]) => TEXT[code](items));
}
