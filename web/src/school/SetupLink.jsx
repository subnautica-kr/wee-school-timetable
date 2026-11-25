import { Button } from '@mantine/core';
import { t } from '../T.jsx';

// 옛 올리기 자리 곁의 한 줄 — 「학교 자료 넣기」 단계 화면으로 보낸다. 단계 번호는 서버 schoolSetup 의 번호와 같다.
const NO = { roster: 3, loads: 4, pins: 5 };

export default function SetupLink({ step, onGo }) {
  if (!onGo) return null;
  return <Button variant="subtle" size="compact-xs" data-testid={`setup-link-${step}`} onClick={() => onGo(step)}>{t('school.wizard_link.go', { 번호: NO[step] })}</Button>; // 문구-예외: 문구 변수 이름
}
