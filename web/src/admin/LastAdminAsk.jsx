import { useRef, useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { t } from '../T.jsx';
import { withForce } from './forceView.js';

const namesV = (n) => ({ 이름: n }); // 문구-예외: 문구 변수 이름

// 마지막 기관 관리자 경고 확인창 — 공용 도우미 하나(T-1322b③ 4)
// 쓰는 법: const [ask, askBox, guarded] = useLastAdmin();
//   await guarded((force) => api('PATCH', path, force ? { ...body, force: true } : body))  — 경고면 창을 띄우고 확인하면 force 로 다시 보낸다(거절이면 undefined)
//   ask(경고 글, 멈춘 줄 이름?) 는 true/false 를 돌려주는 약속 — 여러 줄 결과처럼 직접 다룰 때 · 화면에 {askBox}
export function useLastAdmin() {
  const [st, setSt] = useState(null); // { text, names }
  const res = useRef(null);
  const ask = (text, names = '') => new Promise((resolve) => { res.current = resolve; setSt({ text, names }); });
  const done = (v) => { const r = res.current; res.current = null; setSt(null); r?.(v); };
  const box = (
    <Modal key="last-admin-ask" opened={!!st} onClose={() => done(false)} title={t('roster.last_admin.title')} centered>
      {st && (
        <Stack>
          <Alert color="orange"><Text size="sm">{st.text}</Text></Alert>
          {st.names && <Text size="sm" c="dimmed">{t('roster.last_admin.rows', namesV(st.names))}</Text>}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => done(false)}>{t('roster.last_admin.no')}</Button>
            <Button color="orange" onClick={() => done(true)}>{t('roster.last_admin.yes')}</Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
  const guarded = (fn) => withForce(ask, fn);
  return [ask, box, guarded];
}
