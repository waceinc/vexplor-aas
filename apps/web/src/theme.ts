/**
 * Light screen · dark screen.
 *
 * As in the reference (VEXPLOR Logic Studio), **light is the default**; dark is turned on by a single `<html class="dark">` —
 * all colors are theme variables (`:root` · `.dark` in styles/drive.css), so one class switches them.
 * The choice is remembered only in this browser (a viewing preference that can differ per person, so it is not kept on the server).
 */
import { useEffect, useState } from 'react';

const KEY = 'aas.theme.v1';

const readDark = (): boolean => {
  try {
    return localStorage.getItem(KEY) === 'dark';
  } catch {
    // Window with storage blocked — render with the default (light)
    return false;
  }
};

// Important: apply the chosen theme **before** the first render. Leaving it to an effect (useEffect) makes the light screen
//    flash once on every reload even for someone who chose dark. Inline scripts are blocked by CSP (script-src 'self'), so it is done in this module
if (typeof document !== 'undefined') document.documentElement.classList.toggle('dark', readDark());

export function useTheme(): { dark: boolean; toggle: () => void } {
  const [dark, setDark] = useState(readDark);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try {
      localStorage.setItem(KEY, dark ? 'dark' : 'light');
    } catch {
      // Window with storage blocked — changes only for this view and is not remembered
    }
  }, [dark]);
  return { dark, toggle: () => setDark((current) => !current) };
}
