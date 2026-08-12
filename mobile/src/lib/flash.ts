/**
 * A one-shot confirmation message, handed from the screen that finished an
 * action to the screen the owner lands on next.
 *
 * The problem it solves: saving an expense, confirming a scanned receipt and
 * saving an edit all end in `navigation.goBack()`. Each fires a success
 * haptic, which is silent for anyone who has haptics turned off and invisible
 * to everyone. The owner is returned to the records list with no statement
 * that anything was saved.
 *
 * WHY A MODULE-LEVEL VALUE AND NOT A ROUTE PARAM: a route param would mean
 * rewriting those three `goBack()` calls into `navigate("RecordsList", {...})`
 * calls, which changes how the stack unwinds — navigation structure is out of
 * scope for this pass. A value read on focus works no matter how the owner got
 * back, including the hardware back button and the swipe gesture, neither of
 * which can carry params at all.
 *
 * The cost of that choice is that the message is app-wide rather than
 * addressed to a particular screen, so it must be consumed exactly once.
 * `takeFlash` clears as it reads, which is why it is a take and not a get: two
 * screens focusing in sequence cannot both show the same confirmation.
 */

let pending: string | null = null;

/** Record a confirmation for the next screen that asks. Overwrites any unread one. */
export function setFlash(message: string): void {
  pending = message;
}

/** Read the pending confirmation and clear it. Returns null when there is none. */
export function takeFlash(): string | null {
  const message = pending;
  pending = null;
  return message;
}
