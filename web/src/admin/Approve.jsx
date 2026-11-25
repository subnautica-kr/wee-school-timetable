import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Checkbox, Group, Modal, Paper, Select, Stack, Text } from '@mantine/core';
import { api } from '../api.js';
import { t } from '../T.jsx';
import { dateText, freeLineOptions, needsConfirm, warningLines } from './linkView.js';
import { showBirth } from '../signup/birth.js';
import ContactNudge from './ContactNudge.jsx';

const skipV = (s) => ({ 이름: s.name, 사유: s.text }); // 문구-예외: 문구 변수 이름
const orgsV = (a) => ({ 학교: a.join(', ') }); // 문구-예외: 문구 변수 이름
const dutyV = (d) => ({ 담당: d }); // 문구-예외: 문구 변수 이름
const countV = (n) => ({ 수: n }); // 문구-예외: 문구 변수 이름
const dateV = (iso) => ({ 날짜: dateText(iso) }); // 문구-예외: 문구 변수 이름

// 「가입 승인」 탭 — 승인을 기다리는 건마다 계정과 연결될 명단 줄을 나란히 보여 주고 승인한다(T-1322a③)
// onCount(n): 기다리는 건 수를 위로 알린다(0 이면 탭이 사라진다)
export default function Approve({ orgId, onCount, onChanged }) {
  const base = `/orgs/${orgId}/roster`;
  const [items, setItems] = useState(null);
  const [rows, setRows] = useState([]); // 명단 줄 — 빈 줄 목록용
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState({}); // userId → true
  const [pickOpen, setPickOpen] = useState({}); // userId → 줄 다시 고르기 열림
  const [pick, setPick] = useState({}); // userId → 고른 줄 번호
  const [other, setOther] = useState({}); // userId → 고른 다른 계정 userId
  const [hint, setHint] = useState({}); // userId → 건 아래 안내 한 줄
  const [ask, setAsk] = useState(null); // { item, extra, warnings }
  const [skipped, setSkipped] = useState([]);
  const [nudge, setNudge] = useState(false);
  const asked = useRef(false);

  const load = async () => {
    try {
      const [a, r] = await Promise.all([api('GET', `${base}/approvals`), api('GET', base)]);
      setItems(a); setRows(r); onCount?.(a.length);
      if (a.length > 0 && !asked.current) { // 첫 승인 대기가 보일 때 한 번 — 보일 차례인지는 서버가 정한다(권유는 학교에서 한 번뿐)
        asked.current = true;
        api('POST', `${base}/contact-nudge`).then((n) => { if (n.show) setNudge(true); }).catch(() => {});
      }
    } catch (e) { setErr(e.message); setItems((x) => x ?? []); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setOne = (map, set, id, v) => set({ ...map, [id]: v });
  const after = async () => { setSel({}); await load(); await onChanged?.(); };
  const takenAgain = async (it) => {
    setHint((h) => ({ ...h, [it.userId]: t('roster.approve.pick_taken') }));
    setPickOpen((p) => ({ ...p, [it.userId]: true }));
    await load();
  };

  // 한 건 승인 — extra: { membershipId?, force? }
  const approve = async (it, extra = {}) => {
    setErr(''); setMsg(''); setBusy(true);
    try {
      await api('POST', `${base}/approvals/${it.userId}/approve`, extra);
      setAsk(null);
      setMsg(t('roster.approve.done', { 이름: it.account.name })); // 문구-예외: 문구 변수 이름
      await after();
    } catch (e) {
      if (e.status === 409 && e.body?.lineTaken) { setAsk(null); await takenAgain(it); }
      else if (needsConfirm(e) && !extra.force) setAsk({ item: it, extra, warnings: warningLines(e.body) });
      else { setAsk(null); setErr(e.message); }
    } finally { setBusy(false); }
  };
  // 경고가 있으면 확인창을 먼저 — 확인하면 force:true 로 다시 보낸다
  const clickApprove = (it, extra = {}) => {
    if (it.warnings.length) setAsk({ item: it, extra, warnings: it.warnings.map((w) => w.text) });
    else approve(it, extra);
  };
  const useOther = async (it) => {
    const uid = Number(other[it.userId]);
    if (!uid) return;
    setErr(''); setMsg(''); setBusy(true);
    try {
      await api('POST', `${base}/approvals/${it.userId}/use-other`, { userId: uid });
      setMsg(t('roster.approve.done', { 이름: it.account.name })); // 문구-예외: 문구 변수 이름
      await after();
    } catch (e) {
      if (e.status === 409 && e.body?.lineTaken) await takenAgain(it);
      else if (e.message === t('roster.err.other_active')) setHint((h) => ({ ...h, [it.userId]: t('roster.approve.other_active_hint') }));
      else setErr(e.message);
    } finally { setBusy(false); }
  };
  const bulk = async () => {
    const userIds = Object.keys(sel).filter((k) => sel[k]).map(Number);
    if (!userIds.length) { setErr(t('roster.approve.bulk_none')); return; }
    setErr(''); setMsg(''); setSkipped([]); setBusy(true);
    const names = Object.fromEntries(items.map((x) => [x.userId, x.account.name]));
    try {
      const r = await api('POST', `${base}/approvals/bulk`, { userIds });
      const parts = [];
      if (r.done.length) parts.push(t('roster.approve.bulk_done', { 수: r.done.length })); // 문구-예외: 문구 변수 이름
      if (r.skipped.length) parts.push(t('roster.approve.bulk_skipped', { 수: r.skipped.length })); // 문구-예외: 문구 변수 이름
      setMsg(parts.join(' '));
      setSkipped(r.skipped.map((s) => ({ ...s, name: names[s.userId] ?? '' })));
      await after();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  if (items === null) return null;
  const free = freeLineOptions(rows);
  return (
    <Stack>
      <Text size="sm">{t('roster.approve.lead')}</Text>
      {nudge && <ContactNudge orgId={orgId} onClose={() => setNudge(false)} />}
      {err && <Alert color="red" withCloseButton onClose={() => setErr('')}>{err}</Alert>}
      {msg && <Alert color="green" withCloseButton onClose={() => setMsg('')}>{msg}</Alert>}
      {skipped.length > 0 && (
        <Alert color="orange">
          {skipped.map((s) => <Text key={s.userId} size="sm">{t('roster.approve.skip_reason', skipV(s))}</Text>)}
        </Alert>
      )}
      {items.length === 0 && <Text c="dimmed">{t('roster.approve.empty')}</Text>}
      {items.length > 0 && (
        <Group>
          <Checkbox label={t('roster.approve.pick_all')} checked={items.every((x) => sel[x.userId])}
            onChange={(e) => setSel(e.currentTarget.checked ? Object.fromEntries(items.map((x) => [x.userId, true])) : {})} />
          <Button size="xs" variant="light" loading={busy} onClick={bulk}>{t('roster.approve.bulk_run', countV(Object.values(sel).filter(Boolean).length))}</Button>
        </Group>
      )}
      {items.map((it) => {
        const otherW = it.warnings.find((w) => w.code === 'other');
        const accOpts = (otherW?.accounts ?? []).map((a) => ({ value: String(a.userId), label: `${a.loginId}${a.orgs?.length ? ` · ${a.orgs.join(', ')}` : ''}` }));
        return (
          <Paper key={it.userId} withBorder p="sm" data-testid="approve-card">
            <Stack gap="xs">
              {it.warnings.length > 0 && <Alert color="orange" py={4}>{it.warnings.map((w) => <Text key={w.code} size="sm">{w.text}</Text>)}</Alert>}
              <Group align="flex-start" wrap="nowrap">
                <Checkbox mt={4} checked={!!sel[it.userId]} onChange={(e) => setOne(sel, setSel, it.userId, e.currentTarget.checked)} aria-label={t('roster.approve.pick_all')} />
                <Group align="flex-start" grow style={{ flex: 1 }}>
                  <Stack gap={2}>
                    <Text size="xs" c="dimmed">{t('roster.approve.account')}</Text>
                    <Text fw={600}>{it.account.name} <Text span size="sm" c="dimmed">({it.account.loginId})</Text></Text>
                    <Text size="sm">{it.account.birthDate ? showBirth(it.account.birthDate) : t('roster.approve.birth_unknown')}</Text>
                    <Text size="sm" c="dimmed">{t('roster.approve.signed_up', dateV(it.account.signedUpAt))}</Text>
                    <Text size="sm" c="dimmed">{it.account.orgs?.length ? t('roster.approve.orgs', orgsV(it.account.orgs)) : t('roster.approve.orgs_none')}</Text>
                  </Stack>
                  <Stack gap={2}>
                    <Text size="xs" c="dimmed">{t('roster.approve.line')}</Text>
                    <Text fw={600}>{it.line.name}</Text>
                    <Text size="sm">{it.line.birthDate ? showBirth(it.line.birthDate) : t('roster.approve.birth_unknown')}</Text>
                    {it.line.duty && <Text size="sm" c="dimmed">{t('roster.approve.duty', dutyV(it.line.duty))}</Text>}
                    {it.birthOnly && <Text size="xs" c="dimmed">{t('roster.approve.birth_only')}</Text>}
                  </Stack>
                </Group>
              </Group>
              {it.kind === 'move_in' && it.moveFrom?.length > 0 && <Badge color="blue" variant="light" size="lg" tt="none">{t('roster.approve.move_in', orgsV(it.moveFrom))}</Badge>}
              {it.kind === 'concurrent' && <Badge color="grape" variant="light" size="lg" tt="none">{t('roster.approve.concurrent')}</Badge>}
              {hint[it.userId] && <Text size="sm" c="orange.8">{hint[it.userId]}</Text>}
              {pickOpen[it.userId] && (
                <Group align="flex-end">
                  <Select size="xs" w={200} label={t('roster.approve.repick_label')} placeholder={free.length ? t('roster.approve.repick') : t('roster.approve.pick_no_line')}
                    data={free} value={pick[it.userId] ?? null} onChange={(v) => setOne(pick, setPick, it.userId, v)} searchable disabled={!free.length} />
                  <Button size="xs" disabled={!pick[it.userId]} loading={busy} onClick={() => clickApprove({ ...it, warnings: [] }, { membershipId: Number(pick[it.userId]) })}>{t('roster.approve.pick_apply')}</Button>
                </Group>
              )}
              {otherW && accOpts.length > 0 && (
                <Group align="flex-end">
                  <Select size="xs" w={260} label={t('roster.approve.other_pick')} placeholder={t('roster.approve.other_none_pick')} data={accOpts}
                    value={other[it.userId] ?? null} onChange={(v) => setOne(other, setOther, it.userId, v)} />
                  <Button size="xs" variant="light" disabled={!other[it.userId]} loading={busy} onClick={() => useOther(it)}>{t('roster.approve.use_other')}</Button>
                </Group>
              )}
              <Group justify="flex-end">
                <Button size="xs" variant="subtle" onClick={() => setOne(pickOpen, setPickOpen, it.userId, !pickOpen[it.userId])}>{t('roster.approve.repick')}</Button>
                <Button size="xs" loading={busy} onClick={() => clickApprove(it)}>{t('roster.approve.approve')}</Button>
              </Group>
            </Stack>
          </Paper>
        );
      })}
      <Modal opened={!!ask} onClose={() => !busy && setAsk(null)} title={t('roster.approve.confirm_title')} centered>
        {ask && (
          <Stack>
            <Text size="sm">{t('roster.approve.confirm_lead')}</Text>
            <Alert color="orange">{ask.warnings.map((w) => <Text key={w} size="sm">{w}</Text>)}</Alert>
            <Group justify="flex-end">
              <Button variant="default" disabled={busy} onClick={() => setAsk(null)}>{t('roster.approve.cancel')}</Button>
              <Button color="orange" loading={busy} onClick={() => approve(ask.item, { ...ask.extra, force: true })}>{t('roster.approve.force')}</Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
