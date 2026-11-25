import { useState } from 'react';
import { Alert, Button, Group, Stack, Text, TextInput } from '@mantine/core';
import { api } from '../api.js';
import { t } from '../T.jsx';

// 연락처 적기 권유 — 서버가 「지금 보일 차례」라고 한 한 번만 뜬다(그 판단은 서버가 하고 여기선 그리기만 한다).
// 「저장」은 기관 설정의 연락처 칸에 적고, 「나중에」는 그냥 닫는다(서버는 이미 「보였다」를 적어 뒀다).
export default function ContactNudge({ orgId, onClose }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    setErr(''); setBusy(true);
    try { await api('PUT', `/orgs/${orgId}/org/config`, { contact: v.trim() }); onClose(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Alert color="blue" data-testid="contact-nudge">
      <Stack gap="xs">
        <Text size="sm">{t('roster.contact.nudge')}</Text>
        <TextInput size="xs" aria-label={t('roster.contact.label')} placeholder={t('roster.contact.label')} maxLength={100} value={v} onChange={(e) => setV(e.currentTarget.value)} />
        {err && <Text size="xs" c="red">{err}</Text>}
        <Group gap="xs">
          <Button size="xs" loading={busy} disabled={!v.trim()} onClick={save}>{t('roster.contact.save')}</Button>
          <Button size="xs" variant="default" disabled={busy} onClick={onClose}>{t('roster.contact.later')}</Button>
        </Group>
      </Stack>
    </Alert>
  );
}
