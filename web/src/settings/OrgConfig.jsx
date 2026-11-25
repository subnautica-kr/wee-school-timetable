import { useEffect, useState } from 'react';
import { Alert, Button, Group, NumberInput, Switch, SegmentedControl, SimpleGrid, Stack, TagsInput, Text, TextInput, Title } from '@mantine/core';
import { api } from '../api.js';
import { t } from '../T.jsx';
import { DEFAULTS, configPath, mergeConfig } from '../orgConfig.js';
import DangerZone from './DangerZone.jsx';
import { TransferAutoSwitch } from '../admin/Transfers.jsx';
import { SUB_GRADES } from '../../../shared/sub-grades.js';

const LIMIT_LABELS = {
  periods: '하루 교시 상한', grades: '학년 수 상한', classNo: '반 번호 상한', students: '반당 학생 수', capacity: '특별실 수용',
  loadPerWeek: '주당 수업 시수 상한', block: '연강 최대', cells: '시안 칸 수 상한', rosterRows: '명단 한 번에 올릴 줄',
};
const ROLE_KEYS = ['기관관리자', '교직원', '보기만'];
const LEVEL = [{ value: 'warn', label: '경고' }, { value: 'exclude', label: '제외' }];

// 기관 설정(기관관리자) — 학교마다 다른 값. 막지 않고, 서버가 돌려주는 경고만 노랗게 보여 준다.
export default function OrgConfig({ P }) {
  const [c, setC] = useState(null);
  const [msg, setMsg] = useState(null);
  const [warn, setWarn] = useState([]);
  useEffect(() => { api('GET', configPath(P)).then((r) => setC(mergeConfig(r))).catch(() => { setC(DEFAULTS); setMsg({ color: 'yellow', text: '서버 설정을 못 불러와 기본값을 보여 드립니다.' }); }); }, [P]);
  if (!c) return null;
  const set = (k, v) => setC({ ...c, [k]: v });
  const setIn = (k, sub, v) => setC({ ...c, [k]: { ...c[k], [sub]: v } });
  const save = async () => {
    setMsg(null); setWarn([]);
    try {
      const { features: _f, transferAutoApprove: _t, ...rest } = c; // 전출 자동 승인은 켜고 끄는 즉시 따로 저장한다 · 스위치는 「기능 고르기」 혼자 저장한다(통째로 보내 덮지 않게)
      const r = await api('PUT', configPath(P), rest);
      setC(mergeConfig(r.config || r));
      setWarn(Array.isArray(r.warnings) ? r.warnings : []);
      setMsg({ color: 'green', text: '저장했습니다' });
    } catch (e) { setMsg({ color: 'red', text: e.message }); }
  };
  const months = c.semesterStarts.map(String);
  return (
    <Stack maw={720}>
      <Title order={4}>기관 설정</Title>
      <Text size="sm" c="dimmed">학교마다 다른 값입니다. 기본값은 지금 쓰는 값 그대로이고, 범위를 넘어도 막지 않고 알려만 드립니다.</Text>
      {msg && <Alert color={msg.color} withCloseButton onClose={() => setMsg(null)}>{msg.text}</Alert>}
      {warn.map((w) => <Alert key={w.key} color="yellow">{w.msg}</Alert>)}
      <TagsInput label="요일 목록" description="앞에서부터 1번째 요일. 주말 수업이 있으면 추가하세요." value={c.weekdays} onChange={(v) => set('weekdays', v)} />
      <TagsInput label="학기 시작 월" description="숫자 월. 예: 3, 9" value={months} onChange={(v) => set('semesterStarts', v.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 12))} />
      <Text fw={600}>숫자 상한</Text>
      <SimpleGrid cols={{ base: 1, xs: 2, sm: 3 }}>
        {Object.entries(LIMIT_LABELS).map(([k, label]) => (
          <NumberInput key={k} label={label} min={1} value={c.limits[k]} onChange={(v) => setIn('limits', k, Number(v) || DEFAULTS.limits[k])} />
        ))}
      </SimpleGrid>
      <Text fw={600}>보결</Text>
      <TagsInput label="후보 순서(등급)" description="앞에 둘수록 먼저 권합니다. 글자는 A B C D 중에서 고릅니다." value={c.substitute.order} onChange={(v) => setIn('substitute', 'order', v)} />
      <Stack gap={0}>{Object.entries(SUB_GRADES).map(([g, x]) => <Text key={g} size="xs" c="dimmed">{g} — {x.name}: {x.hint}</Text>)}</Stack>
      <Group align="end">
        <div><Text size="sm">강사·보조 선생님</Text><SegmentedControl data={LEVEL} value={c.substitute.assistants} onChange={(v) => setIn('substitute', 'assistants', v)} /></div>
        <div><Text size="sm">급식지도</Text><SegmentedControl data={LEVEL} value={c.substitute.lunchDuty} onChange={(v) => setIn('substitute', 'lunchDuty', v)} /></div>
      </Group>
      <Text fw={600}>한 수업에 선생님 두 분(협력수업)</Text>
      <Text size="xs" c="dimmed">시수표에서 한 수업에 둘째 선생님을 넣은 칸을 어떻게 다룰지 학교가 고릅니다. 바꿔도 이미 짠 시간표는 그대로이고, 다음부터 적용됩니다.</Text>
      <Switch label="둘째 선생님으로만 들어간 수업도 결강에 넣기" checked={c.secondTeacher.inSubstitute} onChange={(e) => setIn('secondTeacher', 'inSubstitute', e.currentTarget.checked)}
        description="켜면: 선생님이 하루 결강을 올릴 때, 협력수업으로 들어간 수업도 함께 보결 대상이 됩니다. 예) 3교시 영어에 보조로 들어가는 선생님이 빠지면 그 시간도 보결을 구합니다. 끄면: 그 선생님이 첫째(주 담당)인 수업만 보결 대상입니다." />
      <Switch label="자동 생성 점수에 둘째 선생님 수업도 세기" checked={c.secondTeacher.inSoftScore} onChange={(e) => setIn('secondTeacher', 'inSoftScore', e.currentTarget.checked)}
        description="켜면: 시간표 자동 생성이 둘째 선생님의 수업도 그 선생님 몫으로 세어, 연강이 너무 길거나 하루 수업이 몰리지 않게 고릅니다. 예) 협력수업이 하루 6시간 연달아 잡히는 안은 낮게 평가합니다. 끄면: 첫째(주 담당) 수업만 셉니다. 겹침 경고는 이 설정과 상관없이 늘 둘 다 봅니다." />
      <TagsInput label="담임/전담 구분 목록" description="담임·전담·비교과처럼 우리 학교에서 쓰는 담당 구분입니다. 사람 목록에서 고를 때 이 말이 나옵니다." value={c.duties} onChange={(v) => set('duties', v)} />
      <Text fw={600}>역할 표시명</Text>
      <Text size="xs" c="dimmed">권한은 그대로이고 화면에 보이는 이름만 바뀝니다. 비우면 원래 이름.</Text>
      <SimpleGrid cols={{ base: 1, xs: 3 }}>
        {ROLE_KEYS.map((r) => <TextInput key={r} label={r} value={c.roleLabels[r] || ''} onChange={(e) => set('roleLabels', { ...c.roleLabels, [r]: e.currentTarget.value })} />)}
      </SimpleGrid>
      <TextInput label={t('roster.contact.label')} description={t('roster.contact.setting_hint')} value={c.contact || ''} maxLength={100} onChange={(e) => set('contact', e.currentTarget.value)} w={360} />
      <TransferAutoSwitch P={P} value={c.transferAutoApprove} />
      <NumberInput label="월 근태 한도(비우면 없음)" min={0} value={c.attendanceMonthlyCap ?? ''} onChange={(v) => set('attendanceMonthlyCap', v === '' ? null : Number(v))} w={220} />
      <Group><Button onClick={save}>저장</Button><Button variant="default" onClick={() => setC(DEFAULTS)}>기본값으로 채우기</Button></Group>
      <DangerZone P={P} />
    </Stack>
  );
}
