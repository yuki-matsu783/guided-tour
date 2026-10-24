/**
 * キーボード操作のための、フォーカスの扱い。
 * - `useFocusRestore`: 描き直しのあとも、直前にクリック（Enter・Space を含む）した部品にフォーカスを戻す。
 *   部品は `data-focus-id` で見分ける。その部品が無くなっていたら、画面の見出し（`data-focus-fallback`）へ移す。
 * - `ConfirmDialog`: フォーカスを閉じ込める確認の画面。Escape で取り消し、閉じたら開く前の部品へフォーカスを戻す。
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode, RefObject } from 'react';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function findByAttribute(root: ParentNode, name: string, value: string): HTMLElement | null {
  for (const element of root.querySelectorAll(`[${name}]`)) {
    if (element instanceof HTMLElement && element.getAttribute(name) === value) return element;
  }
  return null;
}

/** フォーカスが失われたとき（body にある・外れた）か。 */
function focusLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}

export interface FocusRestore {
  /** 画面の最上位の要素に付ける。 */
  onClickCapture: (event: MouseEvent) => void;
  rootRef: RefObject<HTMLDivElement | null>;
}

/** 描き直しのたびに（レイアウトの後で）、必要ならフォーカスを戻す。 */
export function useFocusRestore(): FocusRestore {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastId = useRef<string | null>(null);

  const onClickCapture = useCallback((event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const id = target.closest('[data-focus-id]')?.getAttribute('data-focus-id');
    if (id !== undefined && id !== null) lastId.current = id;
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const id = lastId.current;
    if (root === null || id === null || !focusLost()) return;
    const same = findByAttribute(root, 'data-focus-id', id);
    if (same !== null && !(same instanceof HTMLButtonElement && same.disabled)) {
      same.focus();
      return;
    }
    root.querySelector<HTMLElement>('[data-focus-fallback]')?.focus();
  });

  return { onClickCapture, rootRef };
}

interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps): ReactNode {
  const { title, children, confirmLabel, cancelLabel, onConfirm, onCancel } = props;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // 開く前にフォーカスのあった部品へ、閉じたときに戻す。開いたら取り消しのボタンへ移す
  useEffect(() => {
    const before = document.activeElement;
    cancelRef.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="dialog-backdrop">
      <div
        ref={dialogRef}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onKeyDown={onKeyDown}
      >
        <h2 id="dialog-title">{title}</h2>
        <div className="dialog-body">{children}</div>
        <div className="dialog-actions">
          <button type="button" ref={cancelRef} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
