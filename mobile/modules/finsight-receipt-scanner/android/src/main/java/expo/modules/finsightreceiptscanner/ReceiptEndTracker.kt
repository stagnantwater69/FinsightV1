package expo.modules.finsightreceiptscanner

/** Only consecutive, registered bottom-edge frames may finish a scan. */
internal class ReceiptEndTracker {
  private var since: Long? = null
  private var lastAt = 0L
  private var observations = 0
  fun reset() { since = null; lastAt = 0; observations = 0 }
  fun observe(acceptedBottom: Boolean, now: Long): Boolean {
    if (!acceptedBottom) { reset(); return false }
    // A slower phone analyses fewer frames per second. A 700 ms gap limit could
    // never be met there, so automatic completion never fired; 1200 ms keeps the
    // hold continuous without joining two separate holds across a long pause.
    if (lastAt != 0L && now - lastAt > 1200) reset()
    lastAt = now
    observations++
    // Elapsed time alone would let two slow frames confirm a hold. Require
    // several registered bottom-edge observations as well.
    val start = since ?: now.also { since = it }
    return observations >= 4 && now - start >= 1100
  }
}
