import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Group, Stack, Switch, Table, Text, TextInput, Title } from '@mantine/core';
import { api } from '../api.js';
import { t } from '../T.jsx';
import { USER_STATUS } from '../../../shared/codes.js';

// 총괄관리자 계정 영역(T-1326) — 소속 없는 계정 · 기관 관리자 없는 학교 · 가입 감시(캡차 스위치) · 계정 잠금 · 연락처.
const usersVars = (s) => ({ 수: s.users }); // 문구-예외: 문구 변수 이름
const suspVars = (w) => ({ 수: w.suspicious }); // 문구-예외: 문구 변수 이름
const detailVars = (w) => ({ 횟수: w.minTries, 곳: w.sources, 전체: w.attempts }); // 문구-예외: 문구 변수 이름
const when = (v) => (v ? new Date(v).toLocaleString('ko-KR') : '-');

export default function AdminAccounts() {
  const [unlinked, setUnlinked] = useState([]);
  const [schools, setSchools] = useState([]);
  const [watch, setWatch] = useState(null);
  const [contact, setContact] = useState('');
  const [err, setErr] = useState('');

  const load = () => Promise.all([
    api('GET', '/admin/accounts/unlinked').then(setUnlinked),
    api('GET', '/admin/schools/no-admin').then(setSchools),
    api('GET', '/admin/signup-watch').then(setWatch),
    api('GET', '/admin/contact').then((r) => setContact(r.contact)),
  ]).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const run = async (fn) => {
    setErr('');
    try { await fn(); await load(); } catch (e) { setErr(e.message); }
  };

  const lockVars = (u) => ({ 아이디: u.loginId }); // 문구-예외: 문구 변수 이름
  const toggleLock = (u) => {
    const locked = u.status === USER_STATUS.LOCKED;
    if (!locked && !window.confirm(t('admin.accounts.lock_ask', lockVars(u)))) return;
    run(() => api('POST', `/admin/users/${u.userId}/${locked ? 'unlock' : 'lock'}`));
  };
  const setCaptcha = (on) => run(() => api('PUT', '/admin/signup-captcha', { on }));
  const saveContact = (e) => { e.preventDefault(); run(() => api('PUT', '/admin/contact', { contact })); };

  return (
    <Stack mt="lg">
      <Title order={4}>{t('admin.accounts.title')}</Title>
      {err && <Alert color="red">{err}</Alert>}

      <Title order={5}>{t('admin.accounts.unlinked_title')}</Title>
      {unlinked.length === 0 ? <Text c="dimmed">{t('admin.accounts.unlinked_none')}</Text> : (
        <Table.ScrollContainer minWidth={600}>
          <Table striped>
            <Table.Thead><Table.Tr>
              <Table.Th>{t('admin.accounts.col_name')}</Table.Th><Table.Th>{t('admin.accounts.col_login')}</Table.Th>
              <Table.Th>{t('admin.accounts.col_signed')}</Table.Th><Table.Th>{t('admin.accounts.col_cleanup')}</Table.Th>
              <Table.Th>{t('admin.accounts.col_status')}</Table.Th><Table.Th />
            </Table.Tr></Table.Thead>
            <Table.Tbody>
              {unlinked.map((u) => (
                <Table.Tr key={u.userId}>
                  <Table.Td>{u.name}</Table.Td>
                  <Table.Td>{u.loginId}</Table.Td>
                  <Table.Td>{when(u.signedUpAt)}</Table.Td>
                  <Table.Td>{u.cleanupAt ? when(u.cleanupAt) : t('admin.accounts.cleanup_none')}</Table.Td>
                  <Table.Td><Badge color={u.status === USER_STATUS.LOCKED ? 'red' : 'green'}>{u.status === USER_STATUS.LOCKED ? t('admin.accounts.status_locked') : t('admin.accounts.status_use')}</Badge></Table.Td>
                  <Table.Td><Button size="xs" variant="default" onClick={() => toggleLock(u)}>{u.status === USER_STATUS.LOCKED ? t('admin.accounts.unlock') : t('admin.accounts.lock')}</Button></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      <Title order={5}>{t('admin.accounts.no_admin_title')}</Title>
      {schools.length === 0 ? <Text c="dimmed">{t('admin.accounts.no_admin_none')}</Text> : (
        <Stack gap={4}>
          {schools.map((s) => (
            <Group key={s.id} gap="xs">
              <Text>{s.name}</Text>
              <Text size="xs" c="dimmed">{t('admin.accounts.no_admin_users', usersVars(s))}</Text>
            </Group>
          ))}
        </Stack>
      )}

      <Title order={5}>{t('admin.accounts.watch_title')}</Title>
      {watch && (
        <Stack gap="xs">
          <Text>{t('admin.accounts.watch_suspicious', suspVars(watch))}</Text>
          <Text size="sm" c="dimmed">{t('admin.accounts.watch_detail', detailVars(watch))}</Text>
          <Switch label={t('admin.accounts.captcha_label')} description={t('admin.accounts.captcha_note')} checked={!!watch.captcha} onChange={(e) => setCaptcha(e.currentTarget.checked)} />
        </Stack>
      )}

      <Title order={5}>{t('admin.accounts.contact_title')}</Title>
      <form onSubmit={saveContact}>
        <Group align="flex-end">
          <TextInput label={t('admin.accounts.contact_label')} description={t('admin.accounts.contact_hint')} value={contact} maxLength={100} onChange={(e) => setContact(e.currentTarget.value)} w={360} />
          <Button type="submit">{t('admin.accounts.contact_save')}</Button>
        </Group>
      </form>
    </Stack>
  );
}
