package expo.modules.finsightreceiptscanner

import org.opencv.core.Mat
import org.opencv.core.Rect
import org.opencv.core.Size
import org.opencv.imgproc.Imgproc
import kotlin.math.min
import kotlin.math.roundToInt

/** Serial-executor owned. A failed registration never changes the accepted mosaic. */
internal class LongReceiptSession : AutoCloseable {
  private var previous: Mat? = null
  private var composite: Mat? = null
  private var previousOffset = 0
  private var frames = 0
  var lastAcceptedAt = 0L
    private set
  /**
   * Set once further growth would cross a safe bound. Reaching a limit must not
   * discard already-registered receipt pixels: the caller stops appending, says
   * so, and lets the owner finish what was actually captured.
   */
  var limitReached = false
    private set
  val height: Int get() = composite?.rows() ?: 0
  val width: Int get() = composite?.cols() ?: 0

  fun accept(frame: Mat, now: Long, bottomVisible: Boolean = false): Boolean {
    require(!frame.empty() && frame.rows() <= 16000 && frame.rows().toLong() * frame.cols() <= 12_000_000L) { "Receipt reached the safe length limit. Finish this scan." }
    val prior = previous
    if (prior == null) {
      previous = frame.clone(); composite = frame.clone(); frames = 1; lastAcceptedAt = now
      return true
    }
    val displacement = ReceiptVision.downwardOffset(prior, frame) ?: return false
    val nextOffset = previousOffset + displacement
    val old = composite ?: return false
    val newHeight = nextOffset + frame.rows()
    // At the bottom the paper-only frame becomes shorter. Verified overlap is
    // still valid even when it adds no rows; never append background to grow it.
    if (newHeight <= old.rows()) {
      if (!bottomVisible) { if (displacement < 12) { lastAcceptedAt = now; return true }; return false }
      // Trim only what this registered frame can vouch for. A partial paper
      // detection at the bottom must never delete accepted receipt lines below
      // it; require the frame to still cover most of the rows it would remove.
      if (old.rows() - newHeight > frame.rows() / 2) return false
      val end = old.submat(Rect(0, 0, old.cols(), newHeight))
      composite = try { end.clone() } finally { end.release() }
      old.release(); previous?.release(); previous = frame.clone(); previousOffset = nextOffset
      lastAcceptedAt = now
      return true
    }
    if (displacement < 12 && !bottomVisible) { lastAcceptedAt = now; return true }
    // Refusing further growth keeps the accepted mosaic intact. Throwing here
    // used to surface as a scan error, which reset the session and destroyed
    // everything the owner had already swept.
    if (frames >= 80 || newHeight.toLong() * frame.cols() > 12_000_000L || newHeight > 16000) { limitReached = true; return false }
    // Cut at the middle of verified overlap. Do not blend or ghost printed characters.
    val seam = nextOffset + (minOf(old.rows() - nextOffset, frame.rows()) / 2)
    val joined = Mat(newHeight, old.cols(), old.type())
    try {
      val oldPart = old.submat(Rect(0, 0, old.cols(), seam)); val top = joined.submat(Rect(0, 0, old.cols(), seam))
      try { oldPart.copyTo(top) } finally { oldPart.release(); top.release() }
      val source = frame.submat(Rect(0, seam - nextOffset, frame.cols(), newHeight - seam)); val bottom = joined.submat(Rect(0, seam, old.cols(), newHeight - seam))
      try { source.copyTo(bottom) } finally { source.release(); bottom.release() }
    } catch (e: Exception) { joined.release(); throw e }
    composite = joined; old.release(); previous?.release(); previous = frame.clone(); previousOffset = nextOffset
    frames++; lastAcceptedAt = now
    return true
  }

  fun result(): Mat = composite?.clone() ?: error("Start at the top of the receipt first.")
  /** Independent, bounded preview of accepted pixels; never clones the full-size mosaic. */
  fun thumbnail(): Mat? {
    val source = composite ?: return null
    val scale = min(1.0, min(192.0 / source.cols(), 960.0 / source.rows()))
    val result = Mat()
    try {
      Imgproc.resize(source, result, Size(maxOf(1, (source.cols() * scale).roundToInt()).toDouble(), maxOf(1, (source.rows() * scale).roundToInt()).toDouble()), 0.0, 0.0, Imgproc.INTER_AREA)
      return result
    } catch (e: Exception) { result.release(); throw e }
  }
  override fun close() { previous?.release(); composite?.release(); previous = null; composite = null; previousOffset = 0; frames = 0; lastAcceptedAt = 0; limitReached = false }
}
