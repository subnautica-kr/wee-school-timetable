import { useEffect, useState } from 'react';
import { Alert, Anchor, Button, Group, Modal, Paper, Stack, Switch, Text } from '@mantine/core';
import { api } from '../api.js';
import { t } from '../T.jsx';
import { dateText } from './linkView.js';

const countV = (n) => ({ 수: n }); // 문구-예외: 문구 변수 이름
const dateV = (iso) => ({ 날짜: dateText(iso) }); // 문구-예외: 문구 변수 이름
const doneV = (x) => ({ 이름: x.name ?? '', 학교: x.toOrg }); // 문구-예외: 문구 변수 이름
const nameV = (x) => ({ 이름: x.name ?? '' }); // 문구-예외: 문구 변수 이름
const idV = (loginId, iso) => ({ 아이디: loginId, ...(iso ? { 날짜: dateText(iso) } : {}) }); // 문구-예외: 문구 변수 이름

// 가입 승인 탭의 「받은 전출 요청」 구간(T-1322b③ 1) — 다른 학교가 우리 학교 선생님의 전출을 요청한 것
// 요청이 없으면 아무것도 안 그린다. onCount(n): 기다리는 요청 수를 위로 알린다(탭 표시용) · onChanged: 승인 뒤 명단을 다시 읽게
export default function Transfers({ orgId, onCount, onChanged }) {
  const base = `/orgs/${orgId}/transfers`;
  const [data, setData] = useState(null); // { received, autoApprove }
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await api('GET', base);
      setData(r); onCount?.(r.received.length);
    } catch (e) { setErr(e.message); onCount?.(0); }
  };
  useEffect(() => { load(); }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (x, what) => {
    setErr(''); setMsg(''); setBusy(true);
    try {
      await api('POST', `${base}/${x.id}/${what}`);
      setMsg(what === 'approve' ? t('roster.transfer.approved_done', doneV(x)) : t('roster.transfer.rejected_done', nameV(x)));
      await load();
      if (what === 'approve') await onChanged?.();
    } catch (e) { setErr(e.message); await load(); } finally { setBusy(false); }
  };
  const auto = async () => {
    setErr(''); setBusy(true);
    try { await api('PUT', `${base}/auto-approve`, { on: true }); setMsg(t('roster.transfer.auto_on')); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  if (!data) return err ? <Alert color="red">{err}</Alert> : null;
  if (!data.received.length && !msg && !err) return null;
  return (
    <Stack data-testid="transfer-received">
      {data.received.length > 0 && <Text fw={600}>{t('roster.transfer.head', countV(data.received.length))}</Text>}
      {err && <Alert color="red" withCloseButton onClose={() => setErr('')}>{err}</Alert>}
      {msg && <Alert color="green" withCloseButton onClose={() => setMsg('')}>{msg}</Alert>}
      {data.received.map((x) => (
        <Paper key={x.id} withBorder p="sm" data-testid="transfer-card">
          <Stack gap="xs">
            <Text size="sm">{x.text}</Text>
            <Text size="xs" c="dimmed">{t('roster.transfer.expires', dateV(x.expiresAt))}</Text>
            <Group justify="space-between">
              {data.autoApprove ? <span /> : <Anchor component="button" type="button" size="xs" disabled={busy} onClick={auto}>{t('roster.transfer.auto_link')}</Anchor>}
              <Group gap="xs">
                <Button size="xs" variant="default" disabled={busy} onClick={() => act(x, 'reject')}>{t('roster.transfer.reject')}</Button>
                <Button size="xs" loading={busy} onClick={() => act(x, 'approve')}>{t('roster.transfer.approve')}</Button>
              </Group>
            </Group>
          </Stack>
        </Paper>
      ))}
    </Stack>
  );
}

// 「학교 옮기기」 확인창(T-1322b③ 2) — 아이디로 연결했더니 그 계정이 다른 학교 재직이라 전출 요청이 나갔거나 그 자리에서 옮겨졌을 때
export function TransferNote({ note, onClose }) {
  let body = '';
  if (note?.kind === 'auto') body = t('roster.transfer_sent.auto', idV(note.loginId));
  else if (note?.expiresAt) body = t('roster.transfer_sent.requested', idV(note.loginId, note.expiresAt));
  else if (note) body = t('roster.transfer_sent.requested_nodate', idV(note.loginId));
  return (
    <Modal opened={!!note} onClose={onClose} title={t('roster.transfer_sent.title')} centered>
      {note && (
        <Stack>
          <Text size="sm">{body}</Text>
          <Group justify="flex-end"><Button onClick={onClose}>{t('roster.transfer_sent.ok')}</Button></Group>
        </Stack>
      )}
    </Modal>
  );
}

// 설정 화면 한 칸(T-1322b③ 5) — 다른 학교의 전출 요청을 묻지 않고 승인. 켜고 끄는 즉시 저장한다(기관 설정 저장 단추와 따로).
export function TransferAutoSwitch({ P, value, onChanged }) {
  const [on, setOn] = useState(!!value);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const flip = async (v) => {
    setErr(''); setMsg(''); setBusy(true);
    try {
      const r = await api('PUT', `${P}/transfers/auto-approve`, { on: v });
      setOn(!!r.autoApprove); setMsg(r.autoApprove ? t('roster.transfer.auto_on') : t('roster.transfer.auto_off')); onChanged?.(!!r.autoApprove);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Stack gap={4}>
      <Switch label={t('roster.transfer.auto_label')} description={t('roster.transfer.auto_setting')} checked={on} disabled={busy} onChange={(e) => flip(e.currentTarget.checked)} />
      {err && <Alert color="red" p="xs">{err}</Alert>}
      {msg && <Text size="xs" c="dimmed">{msg}</Text>}
    </Stack>
  );
}
