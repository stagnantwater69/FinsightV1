import { useRef, useState, type InputHTMLAttributes, type PointerEvent } from "react";
import { MAX_RECOVERY_CODE_LENGTH, MIN_RECOVERY_CODE_LENGTH, normaliseRecoveryCode } from "../lib/authValidation";
import { TextInput } from "./Field";
import "./code-input.css";

type CodeInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "type"> & { value: string };

export function CodeInput({ value, className = "", ...props }: CodeInputProps) {
  const input = useRef<HTMLInputElement>(null);
  const cells = useRef<Array<HTMLSpanElement | null>>([]);
  const [focused, setFocused] = useState(false);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const characters = Array.from(normaliseRecoveryCode(value));
  const count = Math.max(MIN_RECOVERY_CODE_LENGTH, characters.length);
  const start = normaliseRecoveryCode(value.slice(0, selection.start)).length;
  const end = normaliseRecoveryCode(value.slice(0, selection.end)).length;

  function updateSelection(control: HTMLInputElement) {
    setSelection({ start: control.selectionStart ?? control.value.length, end: control.selectionEnd ?? control.value.length });
  }

  function selectCell(event: PointerEvent<HTMLInputElement>) {
    props.onPointerDown?.(event);
    if (props.disabled || event.defaultPrevented || event.button !== 0) return;
    event.preventDefault();
    const index = cells.current.findIndex((cell) => {
      if (!cell) return false;
      const rect = cell.getBoundingClientRect();
      return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    });
    const rawIndices = Array.from(value.matchAll(/[^\s-]/g), (match) => match.index);
    const position = index >= 0 ? (rawIndices[index] ?? value.length) : value.length;
    const selectionEnd = index >= 0 && index < characters.length ? position + 1 : position;
    input.current?.focus({ preventScroll: true });
    input.current?.setSelectionRange(position, selectionEnd);
    setSelection({ start: position, end: selectionEnd });
  }

  return (
    <div className={`code-input ${className}`.trim()} data-disabled={Boolean(props.disabled)}>
      <TextInput
        {...props}
        ref={input}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        spellCheck={false}
        maxLength={props.maxLength ?? MAX_RECOVERY_CODE_LENGTH + 4}
        value={value}
        className="code-input__control"
        onPointerDown={selectCell}
        onChange={(event) => { updateSelection(event.currentTarget); props.onChange?.(event); }}
        onSelect={(event) => { updateSelection(event.currentTarget); props.onSelect?.(event); }}
        onFocus={(event) => { setFocused(true); updateSelection(event.currentTarget); props.onFocus?.(event); }}
        onBlur={(event) => { setFocused(false); props.onBlur?.(event); }}
      />
      <div className="code-input__cells" aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <span
            key={index}
            ref={(cell) => { cells.current[index] = cell; }}
            className="code-input__cell"
            data-active={focused && index === Math.min(start, count - 1)}
            data-selected={focused && index >= start && index < end}
          >
            {characters[index] || (focused && index === start ? <span className="code-input__caret" /> : null)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function CodeResend({ remaining, sending, disabled, onResend }: {
  remaining: number;
  sending: boolean;
  disabled: boolean;
  onResend: () => void;
}) {
  return (
    <div className="mt-1 flex flex-wrap items-center justify-center gap-x-1 text-center text-xs text-ink-600">
      <span>Didn't receive it?</span>
      <button
        type="button"
        disabled={disabled || sending || remaining > 0}
        onClick={onResend}
        className="min-h-tap rounded px-1 font-medium text-ink-800 underline underline-offset-2 hover:text-tone-brand disabled:cursor-not-allowed disabled:text-ink-500"
      >
        {sending ? "Sending…" : remaining > 0 ? `Resend code in ${remaining}s` : "Get another code"}
      </button>
    </div>
  );
}
