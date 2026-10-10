import { useRef, type InputHTMLAttributes } from "react";

/** An `.input` with an ✕ button that empties it and puts the cursor back in it (shown while it has a value). */
export function ClearableInput({ onClear, className = "", ...props }: InputHTMLAttributes<HTMLInputElement> & { onClear: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const filled = props.value !== "" && props.value !== undefined;
  return (
    <div className="relative">
      <input {...props} ref={input} className={`input pr-9 ${className}`} />
      {filled && (
        <button
          type="button"
          onClick={() => {
            onClear();
            input.current?.focus();
          }}
          className="absolute inset-y-0 right-0 grid w-9 place-items-center text-stone-400 hover:text-stone-700 dark:hover:text-stone-200"
          aria-label="Clear"
          title="Clear"
        >
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      )}
    </div>
  );
}
