import { useEffect, useState } from 'react';
import { Alert, Button, Center, Container, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { api } from '../api.js';
import T, { t } from '../T.jsx';
import { digitsOnly, isBirth8 } from './birth.js';

function Shell({ children }) {
  return (
    <Center mih="100vh" p="md">
      <Container size={400} w="100%">
        <Title order={2} ta="center" mb="md">{t('signup.form.title')}</Title>
        <Paper withBorder shadow="sm" p="lg" radius="md">{children}</Paper>
      </Container>
    </Center>
  );
}

// 코드 링크 첫 갈래 — 이미 계정이 있는 선생님이 새 계정을 만드는 길을 첫 화면에서 끊는다.
export function CodeGate({ code, onLogin, onSignup }) {
  const [info, setInfo] = useState(undefined); // undefined 확인 중 · null 못 읽음
  useEffect(() => {
    api('GET', `/signup/code/${encodeURIComponent(code)}`).then(setInfo).catch(() => setInfo(null));
  }, [code]);
  if (info === undefined) return null;
  const inviteVars = { 학교: info.orgName }; // 문구-예외: 문구 변수 이름
  return (
    <Shell>
      <Stack>
        <Text fw={600}>{info?.orgName ? <T k="signup.gate.invite" v={inviteVars} /> : <T k="signup.gate.invite_plain" />}</Text>
        <Button onClick={onLogin}><T k="signup.gate.have_account" /></Button>
        <Button variant="light" onClick={onSignup}><T k="signup.gate.new_account" /></Button>
      </Stack>
    </Shell>
  );
}

// 가입 양식 — 칸 넷 + 초대 코드(선택). 숨은 칸 website 는 항상 빈 값.
export function SignupForm({ code: codeProp, onBack, onSession }) {
  const [f, setF] = useState({ name: '', birth: '', loginId: '', password: '', code: codeProp || '' });
  const [captcha, setCaptcha] = useState(false);
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.currentTarget.value });

  useEffect(() => {
    api('GET', '/signup/config').then((r) => setCaptcha(!!r.captcha)).catch(() => {});
  }, []);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!isBirth8(f.birth)) { setError(t('signup.err.bad_input')); return; }
    setBusy(true);
    try {
      const body = { name: f.name.trim(), birthDate: f.birth, loginId: f.loginId.trim(), password: f.password, website: '' };
      if (f.code.trim()) body.code = f.code.trim();
      if (captcha) body.captcha = captchaAnswer;
      const r = await api('POST', '/signup', body);
      try { sessionStorage.setItem('signup.loginId', body.loginId); } catch { /* 저장 못 해도 화면은 선다 */ }
      await onSession(r);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <form onSubmit={submit}>
        <Stack>
          <TextInput label={t('signup.form.name')} value={f.name} onChange={set('name')} autoComplete="name" required />
          <TextInput
            label={t('signup.form.birth')}
            placeholder={t('signup.form.birth_ph')}
            description={t('signup.form.birth_hint')}
            value={f.birth}
            onChange={(e) => setF({ ...f, birth: digitsOnly(e.currentTarget.value) })}
            inputMode="numeric"
            maxLength={8}
            autoComplete="bday"
            required
          />
          <TextInput label={t('signup.form.login_id')} value={f.loginId} onChange={set('loginId')} autoComplete="username" required />
          <PasswordInput label={t('signup.form.password')} value={f.password} onChange={set('password')} autoComplete="new-password" required />
          <TextInput label={t('signup.form.code')} value={f.code} onChange={set('code')} />
          {captcha && <TextInput label={t('signup.form.captcha')} value={captchaAnswer} onChange={(e) => setCaptchaAnswer(e.currentTarget.value)} required />}
          <Text size="sm" c="dimmed"><T k="signup.form.old_account" /></Text>
          {error && <Alert color="red">{error}</Alert>}
          <Button type="submit" loading={busy}>{t('signup.form.submit')}</Button>
          <Button variant="subtle" onClick={onBack}>{t('signup.form.back')}</Button>
        </Stack>
      </form>
    </Shell>
  );
}
