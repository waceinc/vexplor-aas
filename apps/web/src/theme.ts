/**
 * 밝은 화면 · 어두운 화면.
 *
 * 기준(VEXPLOR Logic Studio)과 같이 **밝은 화면이 기본**이고, 어두운 화면은 `<html class="dark">` 하나로 켠다 —
 * 색은 전부 테마 변수(styles/drive.css 의 `:root` · `.dark`)라 클래스 하나로 바뀐다.
 * 고른 것은 이 브라우저에만 기억한다(사람마다 다를 수 있는 보기 취향이라 서버에 두지 않는다).
 */
import { useEffect, useState } from 'react';

const KEY = 'aas.theme.v1';

const readDark = (): boolean => {
  try {
    return localStorage.getItem(KEY) === 'dark';
  } catch {
    // 저장소가 막힌 창 — 기본(밝은 화면)으로 그린다
    return false;
  }
};

export function useTheme(): { dark: boolean; toggle: () => void } {
  const [dark, setDark] = useState(readDark);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try {
      localStorage.setItem(KEY, dark ? 'dark' : 'light');
    } catch {
      // 저장소가 막힌 창 — 이번 화면에서만 바뀌고 기억하지 못한다
    }
  }, [dark]);
  return { dark, toggle: () => setDark((current) => !current) };
}
