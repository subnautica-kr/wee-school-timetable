// 메뉴 겹침(T-1215) — 같은 메뉴가 두 번 안 나온다 · 한 스위치가 빈 메뉴를 열지 않는다 · 끌 때 남는 자료 안내
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FEATURE_KEYS, MENU_FEATURES, featuresUpTo, visibleMenus, offNotice, FEATURE_DATA } from '../shared/features.js';

const ALL = ['roster', 'school', 'grid', 'gen', 'softset', 'orgcfg', 'out', 'mine', 'att', 'sub', 'rooms', 'audit', 'feat', 'me'];
const items = ALL.map((v) => ({ v, show: true }));

test('어떤 스위치 조합에서도 메뉴 목록에 같은 메뉴가 두 번 안 나온다', () => {
  for (let n = 0; n <= 6; n++) for (const k of [null, ...FEATURE_KEYS]) {
    const f = { ...featuresUpTo(n), ...(k ? { [k]: false } : {}) };
    const vs = visibleMenus(items, f).map((i) => i.v);
    assert.equal(new Set(vs).size, vs.length, `${n}단계 ${k}`);
  }
});
test('규칙 수위만 켜도 「생성 설정」 빈 메뉴는 안 열린다(규칙 수위는 학교 기본 안 탭)', () => {
  const f = Object.fromEntries(FEATURE_KEYS.map((k) => [k, k === 'levels']));
  const vs = visibleMenus(items, f).map((i) => i.v);
  assert.ok(vs.includes('school') && !vs.includes('softset'));
  assert.ok(!MENU_FEATURES.softset.includes('levels'));
});
test('화면 코드: 폰의 「내 정보」 안에 위 탭 줄과 같은 메뉴를 또 그리지 않는다', () => {
  assert.ok(!readFileSync(new URL('../web/src/admin/Screens.jsx', import.meta.url), 'utf8').includes('more-menu'));
});
test('끌 때 안내: 건수·지우는 곳이 들어가고 0건·못 센 경우도 말이 된다', () => {
  assert.match(offNotice('pins', 12), /자료는 남아요 \(12칸\)/);
  assert.match(offNotice('pins', 12), /고정·금지/);
  assert.match(offNotice('sub', 500), /500건 이상/);
  assert.match(offNotice('rooms', 2), /자료는 남아요 \(2개\)/);
  assert.equal(FEATURE_DATA.rooms.count([{}, {}]), 2); // 특별실 2개를 센다(예약 0건이어도)
  assert.match(offNotice('loads', 0), /남은 자료는 없습니다/);
  assert.ok(!/\(\d/.test(offNotice('gen', undefined)) && /자료는 남아요/.test(offNotice('gen', undefined)));
});
