import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { api } from '../api.js';
import T, { t } from '../T.jsx';
import { digitsOnly, isBirth8, showBirth } from './birth.js';

// 초대 코드 입력 창 — 로그인한 상태에서 코드를 쓴다. 결과 넷: linked · pending · recheck · move.
// auto 이면 열리자마자 initialCode 로 한 번 보낸다(코드 링크 → 로그인 뒤 그 코드가 바로 쓰인다).
export default function CodeDialog({ initialCode = '', auto = false, onClose, onSession }) {
  const [code, setCode] = useState(initialCode);
  const [step, setStep] = useState('input'); // input · recheck · move
  const [recheck, setRecheck] = useState(null);
  const [move, setMove] = useState(null);
  const [fix, setFix] = useState(null); // 고칠게요 입력 중이면 { name, birth }
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sent = useRef({}); // 앞 단계에서 보낸 확인값 — 이어 부를 때 같이 보낸다
  const started = useRef(false);

  async function send(extra = {}, c = code) {
    setError('');
    setBusy(true);
    sent.current = { ...sent.current, ...extra };
    try {
      const r = await api('POST', '/signup/code', { code: c.trim(), ...sent.current });
      if (r.result === 'recheck') { setRecheck(r.recheck); setStep('recheck'); setFix(null); }
      else if (r.result === 'move') { setMove(r.move); setStep('move'); }
      else { await onSession(); onClose(); } // linked · pending — 세션을 다시 읽으면 화면이 바뀐다
    } catch (err) {
      setError(err.message);
      setStep('input');
      sent.current = {};
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (auto && initialCode && !started.current) { started.current = true; send({}, initialCode); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const recheckVars = recheck && { 이름: recheck.name, 생년월일: showBirth(recheck.birthDate) }; // 문구-예외: 문구 변수 이름
  const moveVars = move && { 이전: move.from, 새: move.to }; // 문구-예외: 문구 변수 이름
  return (
    <Modal opened onClose={onClose} title={<T k="signup.code.open" />} centered>
      <Stack>
        {step === 'input' && (
          <form onSubmit={(e) => { e.preventDefault(); sent.current = {}; send(); }}>
            <Stack>
              <TextInput label={t('signup.code.label')} value={code} onChange={(e) => setCode(e.currentTarget.value)} required />
              {error && <Alert color="red">{error}</Alert>}
              <Group justify="flex-end">
                <Button variant="subtle" onClick={onClose}>{t('signup.code.cancel')}</Button>
                <Button type="submit" loading={busy}>{t('signup.code.submit')}</Button>
              </Group>
            </Stack>
          </form>
        )}
        {step === 'recheck' && recheck && (
          <Stack>
            <Text><T k="signup.code.recheck" v={recheckVars} /></Text>
            {fix && (
              <>
                <TextInput label={t('signup.form.name')} value={fix.name} onChange={(e) => setFix({ ...fix, name: e.currentTarget.value })} />
                <TextInput
                  label={t('signup.form.birth')}
                  description={t('signup.form.birth_hint')}
                  value={fix.birth}
                  inputMode="numeric"
                  maxLength={8}
                  onChange={(e) => setFix({ ...fix, birth: digitsOnly(e.currentTarget.value) })}
                />
              </>
            )}
            {error && <Alert color="red">{error}</Alert>}
            <Group justify="flex-end">
              {!fix ? (
                <>
                  <Button variant="light" onClick={() => setFix({ name: recheck.name, birth: String(recheck.birthDate || '').replace(/\D/g, '') })}>{t('signup.code.recheck_fix')}</Button>
                  <Button loading={busy} onClick={() => send({ confirm: 'ok' })}>{t('signup.code.recheck_ok')}</Button>
                </>
              ) : (
                <Button
                  loading={busy}
                  onClick={() => (isBirth8(fix.birth) ? send({ confirm: 'fix', name: fix.name.trim(), birthDate: fix.birth }) : setError(t('signup.err.bad_input')))}
                >{t('signup.code.recheck_send')}</Button>
              )}
            </Group>
          </Stack>
        )}
        {step === 'move' && move && (
          <Stack>
            <Text><T k="signup.code.move" v={moveVars} /></Text>
            {error && <Alert color="red">{error}</Alert>}
            <Group justify="flex-end">
              <Button variant="subtle" onClick={onClose}>{t('signup.code.cancel')}</Button>
              <Button loading={busy} onClick={() => send({ moveOk: true })}>{t('signup.code.move_ok')}</Button>
            </Group>
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}
