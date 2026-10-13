package expo.modules.finsightreceiptscanner

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.os.SystemClock
import android.view.View
import kotlin.math.hypot
import kotlin.math.min

/** Preview-only pixels. This view is never an input to the receipt encoder. Main-thread owned. */
internal class ReceiptScannerOverlay(context: Context) : View(context) {
  var points: List<Pair<Float, Float>> = emptyList()
    private set
  var frameAspect = 1f
  private var mosaic: Bitmap? = null
  private var lastDetectionAt = 0L
  private val density = resources.displayMetrics.density
  // Fixed camera-overlay palette: the same mint on both application themes.
  private val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xff7ee5b7.toInt(); style = Paint.Style.STROKE; strokeWidth = 2 * density }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x387ee5b7 }
  private val paper = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xff1a2022.toInt() }
  private val previewEdge = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xff7ee5b7.toInt(); style = Paint.Style.STROKE; strokeWidth = density }
  private val bitmapPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)

  init {
    // The software layer finishes bitmap reads during drawing, allowing replaced thumbnails
    // to be recycled without a hardware display list retaining a recycled bitmap.
    setLayerType(LAYER_TYPE_SOFTWARE, null)
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    isClickable = false
  }

  fun setMosaic(value: Bitmap?) { val old = mosaic; mosaic = value; if (old !== value) old?.recycle(); invalidate() }
  fun updateDetection(value: List<Pair<Float, Float>>, now: Long = SystemClock.elapsedRealtime()) {
    if (value.size == 4) {
      val jump = if (points.size == 4) points.indices.maxOf { index ->
        hypot(value[index].first - points[index].first, value[index].second - points[index].second)
      } else 1f
      points = if (points.size != 4 || jump > .18f) value else points.indices.map { index ->
        val old = points[index]; val next = value[index]
        Pair(old.first * .62f + next.first * .38f, old.second * .62f + next.second * .38f)
      }
      lastDetectionAt = now
    } else if (now - lastDetectionAt > 650) {
      points = emptyList()
    }
    invalidate()
  }
  fun clear() { points = emptyList(); lastDetectionAt = 0; setMosaic(null) }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (points.size == 4 && frameAspect > 0) {
      val w = min(width.toFloat(), height * frameAspect); val h = w / frameAspect
      val dx = (width - w) / 2; val dy = (height - h) / 2
      val path = Path()
      points.forEachIndexed { index, point ->
        if (index == 0) path.moveTo(dx + point.first * w, dy + point.second * h)
        else path.lineTo(dx + point.first * w, dy + point.second * h)
      }
      path.close(); canvas.drawPath(path, fill)
      val topClipped = points[0].second <= .015f || points[1].second <= .015f
      val bottomClipped = points[2].second >= .985f || points[3].second >= .985f
      val boundary = Path().apply {
        moveTo(dx + points[0].first * w, dy + points[0].second * h)
        lineTo(dx + points[3].first * w, dy + points[3].second * h)
        moveTo(dx + points[1].first * w, dy + points[1].second * h)
        lineTo(dx + points[2].first * w, dy + points[2].second * h)
        if (!topClipped) {
          moveTo(dx + points[0].first * w, dy + points[0].second * h)
          lineTo(dx + points[1].first * w, dy + points[1].second * h)
        }
        if (!bottomClipped) {
          moveTo(dx + points[3].first * w, dy + points[3].second * h)
          lineTo(dx + points[2].first * w, dy + points[2].second * h)
        }
      }
      canvas.drawPath(boundary, edge)
    }
    mosaic?.let { image ->
      val inset = min(12 * density, width * .035f)
      val railWidth = min(width * .24f, 112 * density)
      val railHeight = height * .56f
      val rail = RectF(width - inset - railWidth, inset, width - inset, inset + railHeight)
      val padding = 3 * density
      val content = RectF(rail).apply { inset(padding, padding) }
      val scale = content.width() / image.width
      val visibleRows = min(image.height, maxOf(1, (content.height() / scale).toInt()))
      val source = Rect(0, image.height - visibleRows, image.width, image.height)
      val renderedHeight = visibleRows * scale
      val target = RectF(content.left, content.top, content.right, content.top + renderedHeight)
      canvas.drawRoundRect(rail, 6 * density, 6 * density, paper)
      val checkpoint = canvas.save()
      val clip = Path().apply { addRoundRect(content, 3 * density, 3 * density, Path.Direction.CW) }
      canvas.clipPath(clip)
      canvas.drawBitmap(image, source, target, bitmapPaint)
      canvas.restoreToCount(checkpoint)
      canvas.drawRoundRect(rail, 6 * density, 6 * density, previewEdge)
    }
  }
}
