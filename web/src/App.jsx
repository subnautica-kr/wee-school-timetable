import { useEffect, useState } from 'react';
import { clearAllPartial } from './gen/store.js';
import { Alert, Anchor, Button, Center, Checkbox, Container, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { api } from './api.js';
import AdminScreens from './admin/Screens.jsx';
import { t } from './T.jsx';
import { CodeGate, SignupForm } from './signup/Signup.jsx';
import PendingScreen from './signup/Pending.jsx';
import CodeDialog from './signup/CodeDialog.jsx';

function Login({ onDone, onSignup }) {
  const [choose, setChoose] = useState(null); // 소속이 여럿이면 로그인 뒤 고른다
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = choose ? await api('POST', '/auth/pick-org', { orgId: Number(e.nativeEvent?.submitter?.value) }) : await api('POST', '/auth/login', { loginId, password, remember });
      if (r.choose) setChoose(r.choose);
      else {
        try { sessionStorage.setItem('signup.loginId', loginId); } catch { /* 없어도 된다 */ }
        onDone(r);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Center mih="100vh" p="md">
      <Container size={400} w="100%">
        <Title order={2} ta="center" mb="md">우리학교 시간표</Title>
        <Paper withBorder shadow="sm" p="lg" radius="md">
          <form onSubmit={submit}>
            {choose ? (
              <Stack>
                <Text>소속을 고르세요</Text>
                {choose.map((o) => <Button key={o.orgId} type="submit" value={o.orgId} loading={busy} variant="light">{o.name} ({o.role})</Button>)}
                {error && <Alert color="red">{error}</Alert>}
              </Stack>
            ) : (
            <Stack>
              <TextInput label="ID" value={loginId} onChange={(e) => setLoginId(e.currentTarget.value)} autoComplete="username" required />
              <PasswordInput label="비밀번호" value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="current-password" description={t('signup.login.pw_help')} required />
              <Checkbox label="로그인 유지(30일)" checked={remember} onChange={(e) => setRemember(e.currentTarget.checked)} />
              {error && <Alert color="red">{error}</Alert>}
              <Button type="submit" loading={busy}>로그인</Button>
              <Text size="sm" ta="center">{t('signup.form.to_login_first')} <Anchor component="button" type="button" onClick={onSignup}>{t('signup.form.to_signup')}</Anchor></Text>
            </Stack>
            )}
          </form>
        </Paper>
      </Container>
    </Center>
  );
}

function Home({ user, onLogout, onUser }) {
  return <AdminScreens user={user} onLogout={onLogout} onUser={onUser} />;
}

// 주소의 ?code= — 초대 코드 링크로 들어왔는지
function codeFromUrl() {
  try { return new URLSearchParams(window.location.search).get('code') || ''; } catch { return ''; }
}

export default function App() {
  const [user, setUser] = useState(undefined);
  const [noOrg, setNoOrg] = useState(null);
  const [code, setCode] = useState(codeFromUrl); // 로그인 뒤 바로 쓸 코드(쓰고 나면 비운다)
  const [view, setView] = useState(() => (codeFromUrl() ? 'gate' : 'login')); // gate · login · signup

  // 세션 응답을 화면 상태로 — 학교 없는 세션이면 noOrg 가 붙어 온다
  function apply(r) {
    setNoOrg(r?.noOrg || null);
    setUser(r?.user || null);
  }
  async function reload() { apply(await api('GET', '/auth/session')); }

  useEffect(() => {
    api('GET', '/auth/session').then(apply).catch(() => setUser(null));
  }, []);

  async function logout() {
    await api('POST', '/auth/logout');
    await clearAllPartial(); // 생성 중간 결과는 로그아웃 때 지운다
    await reload();
  }

  if (user === undefined) return null;
  if (!user) {
    if (view === 'gate') return <CodeGate code={code} onLogin={() => setView('login')} onSignup={() => setView('signup')} />;
    if (view === 'signup') return <SignupForm code={code} onBack={() => setView('login')} onSession={(r) => { if (r.result !== 'recheck' && r.result !== 'move') setCode(''); apply(r); }} />;
    return <Login onDone={apply} onSignup={() => setView('signup')} />;
  }
  const codeRun = code ? <CodeDialog initialCode={code} auto onClose={() => setCode('')} onSession={reload} /> : null; // 로그인 뒤 그 코드가 바로 쓰인다
  if (user.orgId == null && noOrg) return <><PendingScreen user={user} onLogout={logout} onSession={reload} />{codeRun}</>;
  return <><Home user={user} onLogout={logout} onUser={setUser} />{codeRun}</>;
}
