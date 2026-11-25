import { useEffect, useState } from 'react';
import { Alert, Button, Center, Container, Paper, Stack, Text, Textarea, Title } from '@mantine/core';
import { api } from '../api.js';
import T, { t } from '../T.jsx';
import CodeDialog from './CodeDialog.jsx';

export function storedLoginId(user) {
  if (user?.loginId) return user.loginId;
  try { return sessionStorage.getItem('signup.loginId') || ''; } catch { return ''; }
}

// 승인 대기 화면 — 하나이고 내용이 둘로 갈린다(코드로 온 사람 / 코드 없이 가입).
export default function PendingScreen({ user, onLogout, onSession }) {
  const [data, setData] = useState(undefined);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState('');
  const [manual, setManual] = useState('');

  useEffect(() => {
    api('GET', '/signup/pending').then(setData).catch(() => setData(null));
  }, [user?.id]);

  if (data === undefined) return null;
  const pending = data?.pending || null;
  const loginId = storedLoginId(user) || t('signup.form.login_id');
  const copyVars = { 아이디: loginId, 주소: window.location.origin }; // 문구-예외: 문구 변수 이름
  const message = t('signup.copy.body', copyVars);
  const schoolVars = pending && { 학교: pending.orgName }; // 문구-예외: 문구 변수 이름
  const avgVars = pending && { 일수: pending.avgDays }; // 문구-예외: 문구 변수 이름
  const idVars = { 아이디: loginId }; // 문구-예외: 문구 변수 이름
  const contactVars = (v) => ({ 연락처: v }); // 문구-예외: 문구 변수 이름
  const contacts = data?.contacts || {}; // 서버에 연락처 칸이 생기면 { org, super } 가 온다 — 지금은 비어 안 보인다

  async function copy() {
    try {
      await navigator.clipboard.writeText(message);
      setCopied('ok');
      setManual('');
    } catch {
      setCopied('fail');
      setManual(message);
    }
  }

  return (
    <Center mih="100vh" p="md">
      <Container size={440} w="100%">
        <Title order={2} ta="center" mb="md">{t('signup.pending.title')}</Title>
        <Paper withBorder shadow="sm" p="lg" radius="md">
          <Stack>
            {pending ? (
              <>
                <Text><T k="signup.pending.with_code" /></Text>
                <Text size="sm">{t('signup.pending.school', schoolVars)}</Text>
                {pending.avgDays != null && <Text size="sm"><T k="signup.pending.avg" v={avgVars} /></Text>}
                {contacts.org && <Text size="sm">{t('signup.pending.contact_org', contactVars(contacts.org))}</Text>}
                {contacts.super && <Text size="sm">{t('signup.pending.contact_super', contactVars(contacts.super))}</Text>}
                <Text size="sm" c="dimmed"><T k={data.everLinked ? 'signup.pending.expire_back' : 'signup.pending.expire_new'} /></Text>
              </>
            ) : (
              <>
                {data?.noOrg === 'dormant' && <Text><T k="signup.pending.dormant" /></Text>}
                <Text><T k="signup.pending.no_code" v={idVars} /></Text>
                <Button variant="light" onClick={copy}>{t('signup.copy.button')}</Button>
                {copied === 'ok' && <Text size="sm" c="teal">{t('signup.copy.done')}</Text>}
                {copied === 'fail' && <Alert color="yellow">{t('signup.copy.fail')}</Alert>}
                {manual && <Textarea readOnly autosize value={manual} onFocus={(e) => e.currentTarget.select()} />}
                {contacts.super && <Text size="sm">{t('signup.pending.contact_super', contactVars(contacts.super))}</Text>}
              </>
            )}
            <Button onClick={() => setOpen(true)}>{t('signup.code.open')}</Button>
            <Button variant="subtle" onClick={onLogout}>{t('signup.pending.logout')}</Button>
          </Stack>
        </Paper>
      </Container>
      {open && <CodeDialog onClose={() => setOpen(false)} onSession={onSession} />}
    </Center>
  );
}
