import { useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { api } from '../api.js';
import { t } from '../T.jsx';
import CodeDialog from '../signup/CodeDialog.jsx';

// 「내 정보」 › 초대 코드 입력 · 이 학교에서 나가기(T-1322a③)
// onSession: 세션을 다시 읽는다 · onLogout: 나간 뒤 로그인 화면으로
export default function MyOrg({ onSession, onLogout }) {
  const [code, setCode] = useState(false);
  const [ask, setAsk] = useState(false);
  const [left, setLeft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const schoolV = { 학교: t('roster.leave.school') }; // 문구-예외: 문구 변수 이름 · 세션에 학교 이름이 없어 낱말로 대신한다
  const leave = async () => {
    setErr(''); setBusy(true);
    try {
      await api('POST', '/me/leave');
      setLeft(true);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Stack gap="xs" mb="md">
      <Text size="sm">{t('roster.me_code.lead')}</Text>
      <Group>
        <Button size="xs" variant="light" onClick={() => setCode(true)}>{t('roster.me_code.button')}</Button>
        <Button size="xs" variant="light" color="red" onClick={() => { setErr(''); setAsk(true); }}>{t('roster.leave.button')}</Button>
      </Group>
      {code && <CodeDialog onClose={() => setCode(false)} onSession={onSession} />}
      <Modal opened={ask} onClose={() => !busy && !left && setAsk(false)} title={t('roster.leave.title', schoolV)} centered withCloseButton={!left}>
        {left ? (
          <Stack>
            <Text>{t('roster.leave.relogin')}</Text>
            <Group justify="flex-end"><Button onClick={onLogout}>{t('roster.leave.ok')}</Button></Group>
          </Stack>
        ) : (
          <Stack>
            <Text size="sm">{t('roster.leave.lead', schoolV)}</Text>
            <Text size="sm" c="dimmed">{t('roster.leave.back')}</Text>
            {err && <Alert color="red">{err}</Alert>}
            <Group justify="flex-end">
              <Button variant="default" disabled={busy} onClick={() => setAsk(false)}>{t('roster.leave.no')}</Button>
              <Button color="red" loading={busy} onClick={leave}>{t('roster.leave.yes')}</Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
