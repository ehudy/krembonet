/**
 * An on/off switch.
 *
 * A real `<input type="checkbox">` under a styled label, not a div with a click
 * handler: that is what gives it the tab stop, the space-bar activation, the
 * `checked` state a screen reader announces, and the disabled semantics — all
 * of which a hand-rolled toggle has to reimplement and usually only half does.
 *
 * Used where flipping the switch *is* the action, rather than where a checkbox
 * collects one answer among several on a form. A tick box says "include this
 * when I save"; a switch says "this is on now". Rules and maintenance mode are
 * the second kind — both take effect the moment they move.
 */
export function ToggleSwitch({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
  /** Set when the switch has no visible text of its own. */
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Shown beside the switch. Omit for a bare switch in a dense row. */
  label?: string;
  hint?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <label className={`toggle${disabled ? ' is-disabled' : ''}`}>
      <input
        type="checkbox"
        className="toggle-input"
        checked={checked}
        disabled={disabled}
        {...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel })}
        onChange={(event) => onChange(event.target.checked)}
      />
      {/* The track and knob. `aria-hidden` because the input above already
          carries the state — announcing the decoration too would read the
          control out twice. */}
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-knob" />
      </span>

      {label !== undefined && (
        <span className="toggle-text">
          {label}
          {hint !== undefined && <small>{hint}</small>}
        </span>
      )}
    </label>
  );
}
