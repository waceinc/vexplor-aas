/**
 * 헤더용 드롭다운 메뉴.
 *
 * 🔴 왜 만들었나(2026-10-02): 헤더에 버튼이 15개 펼쳐져 있었다. 「① 편집 ② 검사 ③ 제출」
 *    라벨로 묶어 두었지만 라벨이 자리를 먹고, 번호가 "순서대로 해야 한다"는 오해를 줬다
 *    (실제로는 고치고 검사하고 또 고치며 왔다 갔다 한다). 사용자 지적으로 걷어 내고
 *    **가끔 쓰는 것만** 이 메뉴로 접었다 — 자주 쓰는 것은 밖에 둔다. 한 번 더 누르게
 *    만드는 것은 그만한 값을 해야 한다.
 *
 * 🔴 `details`를 쓰지 않은 이유: 바깥을 눌러도 닫히지 않는다. 헤더 메뉴는 딴 데를 누르면
 *    닫히는 것이 당연해서, 그 하나 때문에 직접 만든다. 대신 브라우저가 공짜로 주던 것을
 *    여기서 다 갚아야 한다 — Esc, 바깥 클릭, 포커스 복귀, aria 상태.
 */
import { useEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  /** 목록에서 한 칸 띄워 가른다 — 성격이 다른 것 앞에 */
  separated?: boolean;
}

interface Props {
  label: string;
  title?: string;
  items: MenuItem[];
  disabled?: boolean;
  /**
   * 오른쪽 끝에 선 메뉴는 오른쪽을 기준으로 펼친다.
   * 🔴 왼쪽 기준으로 두면 화면 밖으로 나간다 — 창 1789px에서 「설정」 메뉴가 131px 잘렸다(2026-10-02 실측).
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
      trigger.current?.focus(); // 🔴 Esc로 닫으면 누르던 자리로 돌아간다 — 키보드만 쓰는 사람이 길을 잃지 않게
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
        <span className="caret" aria-hidden="true">
          ▾
        </span>
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
