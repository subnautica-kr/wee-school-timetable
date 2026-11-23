// 순수: 접미사(suffix「교시 뒤」·「시수」)가 붙은 숫자 칸의 글자 → 숫자.
// 칸의 value 는 「4교시 뒤」 같은 글자라 Number() 로 읽으면 NaN → JSON null 이 된다.
// 빈 칸·숫자가 없는 글자는 null, 있으면 첫 정수(음수 부호 포함). 소수는 버린다.
export function numOfText(text) {
  const m = /-?\d+/.exec(String(text ?? ''));
  return m ? Number(m[0]) : null;
}
