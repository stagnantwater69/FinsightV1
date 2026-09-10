package expo.modules.finsightreceiptscanner

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.View
import kotlin.math.min

/** Preview-only pixels. This view is never an input to the receipt encoder. Main-thread owned. */
internal class ReceiptScannerOverlay(context: Context) : View(context) {
  var points: List<Pair<Float, Float>> = emptyList()
  var frameAspect = 1f
  private var mosaic: Bitmap? = null
  private val density = resources.displayMetrics.density
  // Fixed camera-overlay palette: the same mint on both application themes.
  private val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xff7ee5b7.toInt(); style = Paint.Style.STROKE; strokeWidth = 2 * density }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x387ee5b7 }
  private val paper = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xff1a2022.toInt() }
  private val bitmapPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)

  init {
    // The software layer finishes bitmap reads during drawing, allowing replaced thumbnails
    // to be recycled without a hardware display list retaining a recycled bitmap.
    setLayerType(LAYER_TYPE_SOFTWARE, null)
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    isClickable = false
  }

  fun setMosaic(value: Bitmap?) { val old = mosaic; mosaic = value; if (old !== value) old?.recycle(); invalidate() }
  fun clear() { points = emptyList(); setMosaic(null) }

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
      path.close(); canvas.drawPath(path, fill); canvas.drawPath(path, edge)
    }
    mosaic?.let { image ->
      val scale = min(width * .22f / image.width, height * .45f / image.height)
      val inset = min(12 * density, width * .035f)
      val target = RectF(inset, inset, inset + image.width * scale, inset + image.height * scale)
      val backing = RectF(target).apply { inset(-2 * density, -2 * density) }
      canvas.drawRoundRect(backing, 3 * density, 3 * density, paper)
      canvas.drawBitmap(image, null, target, bitmapPaint)
    }
  }
}
