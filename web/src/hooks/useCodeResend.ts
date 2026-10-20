import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { isPlausibleEmail } from "../lib/authValidation";

/** The server enforces delivery limits; this countdown prevents accidental repeat taps. */
export function useCodeResend(endpoint: "/auth/resend-verification" | "/auth/recover-password", justSent = false) {
  const [remaining, setRemaining] = useState(justSent ? 60 : 0);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setRemaining((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [remaining]);

  async function resend(email: string) {
    if (sending || remaining > 0) return false;
    setError(null);
    setMessage(null);
    if (!isPlausibleEmail(email)) {
      setError("Enter a valid email address before requesting another code.");
      return false;
    }
    setSending(true);
    try {
      await api.post(endpoint, { email: email.trim(), platform: "web" });
      setRemaining(60);
      setMessage("If this address is eligible, a new code is on its way. Check your inbox and spam folder.");
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    } finally {
      setSending(false);
    }
  }
  function clearFeedback() {
    setMessage(null);
    setError(null);
  }

  return { resend, sending, remaining, message, error, clearFeedback };
}
