/**
 * Dropdown menu for the header.
 *
 * Important: why this exists (2026-10-02): the header had 15 buttons laid out. They were grouped under labels
 *    "① Edit ② Check ③ Submit", but the labels took space and the numbers suggested "must be done in order"
 *    (in practice you go back and forth: fix, check, fix again). Removed after a user's remark, and
 *    **only the occasionally used items** were folded into this menu — frequently used ones stay outside. Making someone
 *    click one more time has to be worth it.
 *
 * Important: why not `details`: it does not close when clicking outside. A header menu is expected to close
 *    when you click elsewhere, so we build it ourselves for that one reason. In exchange we must repay here everything
 *    the browser gave for free — Esc, outside click, focus return, aria state.
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export interface MenuItem {
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  /** Separates with a one-row gap in the list — before items of a different nature */
  separated?: boolean;
}

interface Props {
  label: string;
  title?: string;
  items: MenuItem[];
  disabled?: boolean;
  /**
   * A menu sitting at the right edge opens anchored to the right.
   * Important: anchored to the left it goes off screen — in a 1789px window the "Settings" menu was clipped by 131px (measured 2026-10-02).
   */
  align?: 'left' | 'right';
}

export function Menu({ label, title, items, disabled, align = 'left' }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus(); // Important: closing with Esc returns to where you were — so keyboard-only users do not get lost
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const usable = items.filter((item) => !item.disabled).length;

  return (
    <span className="menu-wrap" ref={box}>
      <button
        ref={trigger}
        className={open ? 'menu-trigger on' : 'menu-trigger'}
        disabled={disabled || usable === 0}
        aria-haspopup="menu"
        aria-expanded={open}
        {...(title ? { title } : {})}
        onClick={() => setOpen((current) => !current)}
      >
        {label}
        <ChevronDown className="caret" aria-hidden="true" />
      </button>
      {open && (
        <span className={align === 'right' ? 'menu-pop right' : 'menu-pop'} role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={item.separated ? 'sep' : ''}
              disabled={item.disabled}
              {...(item.title ? { title: item.title } : {})}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
            >
              {item.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
