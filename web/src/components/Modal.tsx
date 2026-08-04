/**
 * The dialog shell every modal in the app is built from.
 *
 * A div is not a dialog to a browser, so the keyboard behaviour has to be built
 * rather than inherited: focus moves in on open and is handed back to whatever
 * opened it on close, Tab is trapped inside so it cannot wander behind the
 * scrim, Escape closes, and a click on the scrim does too. That was written out
 * three times — the confirmation, the explainer, and the update notice — and the
 * update notice had quietly ended up with the weakest version of it: no trap and
 * no focus restore.
 *
 * Add and edit forms live in here as well, which is what `onSubmit` is for: the
 * panel becomes a `<form>`, so the footer's Save button submits it and Return in
 * a text field does the same thing it does in a form on a page.
 *
 * What this deliberately does not do is decide anything about content. It has no
 * opinion on how many buttons a footer holds or what a body contains, because
 * the four things built on it disagree on both.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { X } from 'lucide-react';

import { useTranslation } from '../i18n/i18n.js';

/** Everything focusable a dialog of this shape can contain. */
const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  title: string;
  /** A second line under the title, for context the title has no room for. */
  subtitle?: ReactNode;
  /**
   * Sits opposite the title in the head. A switch that governs everything
   * below it belongs here rather than as the fifth field down.
   */
  headerAction?: ReactNode;
  children: ReactNode;
  /** The buttons. Omitted for a dialog whose only way out is the close cross. */
  footer?: ReactNode;
  /**
   * `split` pushes the safe action left and the committing one right, so the
   * two are not adjacent and a mis-aimed click lands on the harmless one. For a
   * footer holding a single dismissal there is nothing to separate.
   */
  footerLayout?: 'end' | 'split';
  onClose: () => void;
  /** Makes the panel a form, so the footer's submit button submits it. */
  onSubmit?: (event: FormEvent) => void;
  /**
   * `alertdialog` for a question with consequences — it tells a screen reader to
   * announce the body immediately rather than waiting to be asked.
   */
  role?: 'dialog' | 'alertdialog';
  /** `compact` is a question, `wide` a long form; `default` is everything else. */
  size?: 'compact' | 'default' | 'wide';
  /**
   * Blurring what is behind pushes the page back a plane, so the thing asking
   * for an answer is unmistakably the thing in front. `plain` is for a dialog
   * that is a reference read *against* the page rather than instead of it.
   */
  scrim?: 'blurred' | 'plain';
  /** The cross in the head. Off where the footer is the only sanctioned exit. */
  showClose?: boolean;
  /** Points `aria-describedby` at the body, for a dialog that asks something. */
  isDescribedByBody?: boolean;
  /**
   * Where focus lands on open. Defaults to the first focusable thing, unless a
   * child claimed focus itself with `autoFocus` — that runs before this does, so
   * a form's first field wins without having to be threaded through as a ref.
   */
  initialFocus?: RefObject<HTMLElement | null>;
}

export function Modal({
  title,
  subtitle,
  headerAction,
  children,
  footer,
  footerLayout = 'end',
  onClose,
  onSubmit,
  role = 'dialog',
  size = 'default',
  scrim = 'blurred',
  showClose = true,
  isDescribedByBody = false,
  initialFocus,
}: ModalProps) {
  const { t } = useTranslation();
  // Held as the base element type because the panel is a div or a form
  // depending on `onSubmit`, and everything below only ever asks it about
  // focus and containment.
  const panelRef = useRef<HTMLElement | null>(null);
  const id = useId();

  // Read during the first render rather than in the effect below, because by
  // the time effects run a child's `autoFocus` may already have moved focus
  // into the dialog — and then the thing to hand focus back to on close would
  // be recorded as one of the dialog's own fields.
  const [opener] = useState<HTMLElement | null>(
    () => document.activeElement as HTMLElement | null,
  );

  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;

    if (initialFocus?.current != null) initialFocus.current.focus();
    else if (!panel.contains(document.activeElement)) {
      panel.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      // The trap. Without it Tab walks out of the dialog and into the page
      // behind the scrim, which is still there and still looks clickable.
      const focusable = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (focusable.length === 0) return;

      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);

      // Focus goes back to whatever opened this, so a keyboard user lands on
      // the row they were on rather than at the top of the document.
      //
      // "Nothing else has claimed it" is the condition, and the body case is
      // the one that actually fires: this cleanup runs after React has already
      // detached the panel, which drops focus to the body, so a containment
      // check alone would never restore anything. If something else has
      // legitimately taken focus since, stealing it back would be the rude
      // move.
      const active = document.activeElement;
      if (active === null || active === document.body || panel.contains(active)) {
        opener?.focus();
      }
    };
    // `opener` is state that never changes, and `initialFocus` is read once on
    // open: re-running this on either would re-trap focus mid-interaction.
  }, [onClose, opener, initialFocus]);

  const panelProps = {
    ref: (node: HTMLElement | null) => {
      panelRef.current = node;
    },
    className: `modal${size === 'default' ? '' : ` is-${size}`}`,
    role,
    'aria-modal': true,
    'aria-labelledby': `${id}-title`,
    ...(isDescribedByBody ? { 'aria-describedby': `${id}-body` } : {}),
    // Clicks inside must not reach the scrim's close handler.
    onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
  };

  const inner = (
    <>
      <div className="modal-head">
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          {subtitle !== undefined && <p className="muted">{subtitle}</p>}
        </div>

        {headerAction}

        {showClose && (
          <button
            type="button"
            className="icon-button"
            aria-label={t('common.close')}
            onClick={onClose}
          >
            <X size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="modal-body" id={`${id}-body`}>
        {children}
      </div>

      {footer !== undefined && (
        <div className={`modal-footer${footerLayout === 'split' ? ' is-split' : ''}`}>
          {footer}
        </div>
      )}
    </>
  );

  return (
    <div
      className={`modal-scrim${scrim === 'blurred' ? ' is-blurred' : ''}`}
      onClick={onClose}
    >
      {onSubmit === undefined ? (
        <div {...panelProps}>{inner}</div>
      ) : (
        <form {...panelProps} onSubmit={onSubmit} noValidate>
          {inner}
        </form>
      )}
    </div>
  );
}
