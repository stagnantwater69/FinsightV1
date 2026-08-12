import { useEffect, useState } from "react";

/**
 * A value that settles before anything acts on it.
 *
 * The records search previously refetched on every keystroke: typing
 * "groceries" fired nine requests, each one racing the last, and on a phone
 * connection the answer to "grocer" could easily land after the answer to
 * "groceries" and overwrite it. Web debounces the same field for the same
 * reason.
 */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
