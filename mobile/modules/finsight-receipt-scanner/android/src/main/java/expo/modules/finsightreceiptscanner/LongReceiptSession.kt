package expo.modules.finsightreceiptscanner

import org.opencv.core.Mat
import org.opencv.core.Rect
import org.opencv.core.Size
import org.opencv.imgproc.Imgproc
import kotlin.math.min
import kotlin.math.roundToInt

/** Serial-executor owned. A failed registration never changes the accepted mosaic. */
internal class LongReceiptSession : AutoCloseable {
  private data class AcceptedFrame(val image: Mat, val bottomVisible: Boolean)
  private var previous: Mat? = null
  private var composite: Mat? = null
  private val acceptedFrames = mutableListOf<AcceptedFrame>()
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
  val count: Int get() = acceptedFrames.size

  fun accept(frame: Mat, now: Long, bottomVisible: Boolean = false): Boolean = acceptInternal(frame, now, bottomVisible, true)

  private fun acceptInternal(frame: Mat, now: Long, bottomVisible: Boolean, record: Boolean): Boolean {
    require(!frame.empty() && frame.rows() <= 16000 && frame.rows().toLong() * frame.cols() <= 12_000_000L) { "Receipt reached the safe length limit. Finish this scan." }
    val prior = previous
    if (prior == null) {
      previous = frame.clone(); composite = frame.clone(); frames = 1; lastAcceptedAt = now
      if (record) acceptedFrames.add(AcceptedFrame(frame.clone(), bottomVisible))
      return true
    }
    val registration = ReceiptVision.registerDownward(prior, frame) ?: return false
    registration.use {
      val aligned = it.image
      val displacement = it.offset
      val nextOffset = previousOffset + displacement
      val old = composite ?: return false
      val newHeight = nextOffset + aligned.rows()
      // At the bottom the paper-only frame becomes shorter. Verified overlap is
      // still valid even when it adds no rows; never append background to grow it.
      if (newHeight <= old.rows()) {
        if (!bottomVisible) return false
        // A bottom-edge frame may trim only rows it covers; otherwise it could
        // delete accepted receipt lines outside the partial detection.
        if (old.rows() - newHeight > aligned.rows() / 2) return false
        val end = old.submat(Rect(0, 0, old.cols(), newHeight))
        composite = try { end.clone() } finally { end.release() }
        old.release(); previous?.release(); previous = aligned.clone(); previousOffset = nextOffset
        lastAcceptedAt = now
        if (record) acceptedFrames.add(AcceptedFrame(frame.clone(), bottomVisible))
        return true
      }
      if (displacement < 12 && !bottomVisible) return false
      // Refuse unsafe growth without throwing; a thrown scan error would reset
      // the session and discard the accepted mosaic.
      if (acceptedFrames.size >= 8 || newHeight.toLong() * aligned.cols() > 12_000_000L || newHeight > 16000) { limitReached = true; return false }
      // Cut at the middle of verified overlap. Do not blend or ghost printed characters.
      val seam = nextOffset + (minOf(old.rows() - nextOffset, aligned.rows()) / 2)
      val joined = Mat(newHeight, old.cols(), old.type())
      try {
        val oldPart = old.submat(Rect(0, 0, old.cols(), seam)); val top = joined.submat(Rect(0, 0, old.cols(), seam))
        try { oldPart.copyTo(top) } finally { oldPart.release(); top.release() }
        val source = aligned.submat(Rect(0, seam - nextOffset, aligned.cols(), newHeight - seam)); val bottom = joined.submat(Rect(0, seam, old.cols(), newHeight - seam))
        try { source.copyTo(bottom) } finally { source.release(); bottom.release() }
      } catch (e: Exception) { joined.release(); throw e }
      composite = joined; old.release(); previous?.release(); previous = aligned.clone(); previousOffset = nextOffset
      frames++; lastAcceptedAt = now
      if (record) acceptedFrames.add(AcceptedFrame(frame.clone(), bottomVisible))
      return true
    }
  }

  fun removeLast(now: Long): Boolean {
    if (acceptedFrames.isEmpty()) return false
    acceptedFrames.removeAt(acceptedFrames.lastIndex).image.release()
    clearWorking()
    acceptedFrames.forEachIndexed { index, accepted ->
      check(acceptInternal(accepted.image, now + index, accepted.bottomVisible, false)) { "Could not rebuild the retained receipt sections" }
    }
    return true
  }

  fun result(): Mat = composite?.clone() ?: error("Start at the top of the receipt first.")
  /** Independent, bounded preview of accepted pixels; never clones the full-size mosaic. */
  fun thumbnail(): Mat? {
    val source = composite ?: return null
    val visibleRows = min(source.rows(), source.cols() * 4)
    val visible = source.submat(Rect(0, source.rows() - visibleRows, source.cols(), visibleRows))
    val scale = min(1.0, min(240.0 / visible.cols(), 960.0 / visible.rows()))
    val result = Mat()
    try {
      Imgproc.resize(visible, result, Size(maxOf(1, (visible.cols() * scale).roundToInt()).toDouble(), maxOf(1, (visible.rows() * scale).roundToInt()).toDouble()), 0.0, 0.0, Imgproc.INTER_AREA)
      return result
    } catch (e: Exception) { result.release(); throw e }
    finally { visible.release() }
  }
  private fun clearWorking() { previous?.release(); composite?.release(); previous = null; composite = null; previousOffset = 0; frames = 0; lastAcceptedAt = 0; limitReached = false }
  override fun close() { clearWorking(); acceptedFrames.forEach { it.image.release() }; acceptedFrames.clear() }
}
