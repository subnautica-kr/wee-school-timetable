import { Component, useEffect, useState } from 'react';
import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { api } from './api.js';
import { t } from './T.jsx';
import { ROLE } from '../../shared/codes.js';
import BoardModal from './board/BoardModal.jsx';

// 화면 오류 경계 + 전역 오류 잡이(T-1324b). 잡힌 오류는 서버 /api/board/errors 로 보내고(서버가 이름·아이디·전화·이메일을 가려 남긴다)
// 기록 번호를 화면에 보여 준다. 소속 있는 계정엔 그 번호를 실은 「도움·요청 글쓰기」 단추도.
// 싣는 것: 오류 글·스택·화면 이름·버전·직전 요청 경로 20개·화면 이동. 안 싣는 것: 입력값(서버도 한 번 더 가린다).

const recent = []; // 직전 요청 경로(쿼리 뺌)·화면 이동
const push = (s) => { recent.push(String(s).slice(0, 200)); if (recent.length > 20) recent.shift(); };
const listeners = new Set();
let sent = 0;
let last = { key: '', at: 0 };
let installed = false;

const screenName = () => window.location.pathname + window.location.hash.split('?')[0];

export async function reportError(err, extraStack) {
  const message = String(err?.message || err || '').slice(0, 2000);
  if (!message || message.startsWith('ResizeObserver loop')) return null;
  const key = message + (err?.stack || '').slice(0, 200);
  const now = Date.now();
  if (key === last.key && now - last.at < 5000) return null; // 같은 오류가 연달아 터지면 한 번만
  last = { key, at: now };
  if (sent >= 10) return null; // 한 화면에서 열 번까지
  sent += 1;
  try {
    const r = await api('POST', '/board/errors', {
      message,
      stack: [err?.stack, extraStack].filter(Boolean).join('\n').slice(0, 20000) || undefined,
      screen: screenName(),
      version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : undefined,
      recent: [...recent],
    });
    return r.id;
  } catch {
    return null; // 오류를 기록하다 난 오류는 다시 기록하지 않는다
  }
}

const emit = (n) => listeners.forEach((f) => f(n));

async function noticeFrom(err) {
  if (err?.status && err.status < 500) return; // 4xx 는 쓰는 사람에게 이미 보인 거절이라 오류가 아니다
  // 서버 500 은 서버가 이미 기록했다 — 응답에 실린 번호만 보여 준다
  const id = err?.body?.reportId ?? (await reportError(err));
  if (id) emit({ id });
}

export function installErrorHandlers() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const orig = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      const u = new URL(typeof input === 'string' ? input : input.url, window.location.href);
      if (u.pathname.startsWith('/api/') && u.pathname !== '/api/board/errors') push(`${(init?.method || 'GET').toUpperCase()} ${u.pathname}`);
    } catch { /* 경로를 못 읽으면 그냥 지나간다 */ }
    return orig(input, init);
  };
  const nav = () => push(`> ${screenName()}`);
  window.addEventListener('hashchange', nav);
  window.addEventListener('popstate', nav);
  window.addEventListener('error', (e) => { if (e.error || e.message) noticeFrom(e.error ?? new Error(e.message)); });
  window.addEventListener('unhandledrejection', (e) => noticeFrom(e.reason instanceof Error ? e.reason : new Error(String(e.reason ?? ''))));
}

// 글을 쓸 수 있는 계정인가 — 소속 없는 계정·총괄관리자엔 단추를 숨긴다(기록 번호만 보인다)
async function canWrite() {
  try {
    const r = await api('GET', '/auth/session');
    return !!r.user && r.user.orgId != null && r.user.role !== ROLE.SYSADMIN;
  } catch { return false; }
}

function Notice({ id, onClose, head, hint, reload }) {
  const [write, setWrite] = useState(false);
  const [ok, setOk] = useState(false);
  useEffect(() => { if (id) canWrite().then(setOk); }, [id]);
  return (
    <Alert color="red" title={head} withCloseButton={!!onClose} onClose={onClose} data-testid="error-notice">
      <Stack gap="xs">
        <Text size="sm" data-testid="error-record">{id ? t('board.errlog.recorded', { 번호: id }) : t('board.errlog.recorded_no_id')}</Text> // 문구-예외: 문구 변수 이름
        {hint && <Text size="sm">{hint}</Text>}
        <Group>
          {reload && <Button variant="default" onClick={() => window.location.reload()}>{t('board.errlog.reload')}</Button>}
          {id && ok && <Button onClick={() => setWrite(true)} data-testid="error-write-btn">{t('board.errlog.help_button')}</Button>}
        </Group>
      </Stack>
      {write && <BoardModal opened onClose={() => setWrite(false)} prefill={{ errorReportId: id, title: t('board.errlog.post_title', { 번호: id }) }} />} // 문구-예외: 문구 변수 이름
    </Alert>
  );
}

export default class ErrorGate extends Component {
  constructor(props) {
    super(props);
    this.state = { err: null, id: null, notice: null };
  }

  static getDerivedStateFromError(err) { return { err }; }

  componentDidMount() {
    installErrorHandlers();
    this.off = (n) => this.setState({ notice: n });
    listeners.add(this.off);
  }

  componentDidCatch(err, info) {
    reportError(err, info?.componentStack).then((id) => this.setState({ id }));
  }

  componentWillUnmount() { listeners.delete(this.off); }

  render() {
    const { err, id, notice } = this.state;
    if (err) {
      return <Stack p="md" maw={560} mx="auto"><Notice id={id} head={t('board.errlog.boundary_head')} hint={t('board.errlog.boundary_hint')} reload /></Stack>;
    }
    return (
      <>
        {notice && <div style={{ position: 'fixed', right: 12, bottom: 12, zIndex: 4000, maxWidth: 420 }}><Notice id={notice.id} head={t('board.errlog.boundary_head')} onClose={() => this.setState({ notice: null })} /></div>}
        {this.props.children}
      </>
    );
  }
}
