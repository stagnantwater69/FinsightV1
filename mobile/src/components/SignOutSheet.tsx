import { useRef, useState } from "react";
import { ConfirmSheet } from "./ui";
import { useAuth } from "../context/AuthContext";
import * as haptics from "../lib/haptics";

/**
 * THE sign-out confirmation — every "sign out of this phone" in the app goes
 * through this one sheet.
 *
 * WHY IT EXISTS AS A COMPONENT. More had a confirmed sign-out; the account
 * screen had a bare `onPress={logout}` that ended the session on the tap,
 * with no confirmation, no progress and no protection against a second tap.
 * Two entry points to the same action had two different ceremonies, and the
 * unceremonious one was on the screen where a thumb is already busy with
 * forms. One component means one wording, one busy state, one failure path.
 *
 * WHAT HAPPENS AFTER. `logout()` clears the local session, which drops
 * `profile` to null — and App.tsx renders the whole signed-in navigator only
 * while `profile` exists, so every stack unmounts and the auth stack mounts
 * fresh. Nothing to reset by hand, and nothing for the back button to return
 * to: history died with the tree. If that gating ever changes, this comment
 * is the contract that broke.
 *
 * FAILURE IS SHOWN, NOT SWALLOWED. `logout()` itself already treats a failed
 * server call as non-fatal (the local session goes regardless), so the only
 * way to land in the catch below is the local teardown itself failing — rare,
 * but the one case where the owner believes they are signed out and are not.
 * The sheet stays open and says so rather than closing over a live session.
 */
export function SignOutSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The re-entrancy guard, and it has to be a ref rather than the `busy`
   * state beside it.
   *
   * `busy` is only true from the NEXT render onwards, so two presses inside
   * the same frame both read `false` and both call `logout()` — which is
   * exactly the second sign-out this handler exists to prevent. The ref moves
   * on the first press, before React has re-rendered anything. Found by
   * tests/render/signOutSheet.test.tsx, which fires both presses without
   * letting a render in between.
   */
  const running = useRef(false);

  async function confirm() {
    // Belt beside ConfirmSheet's braces: its confirm button is already
    // disabled while `busy`, but this handler is the thing that must never
    // run twice.
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await logout();
      // On success the signed-in tree — this sheet included — unmounts as
      // profile clears; nothing else to do.
    } catch {
      haptics.failed();
      running.current = false;
      setBusy(false);
      setError("Signing out didn't finish. Nothing was lost — try again.");
    }
  }

  return (
    <ConfirmSheet
      visible={visible}
      title="Sign out of FinSight?"
      body="You'll need to sign in again to access your business data."
      confirmLabel="Sign out"
      busy={busy}
      error={error}
      onConfirm={() => void confirm()}
      onCancel={() => {
        setError(null);
        onClose();
      }}
    />
  );
}
