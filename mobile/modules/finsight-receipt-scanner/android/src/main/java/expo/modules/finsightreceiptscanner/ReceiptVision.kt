package expo.modules.finsightreceiptscanner

import org.opencv.core.*
import org.opencv.imgproc.Imgproc
import org.opencv.features2d.ORB
import org.opencv.features2d.BFMatcher
import org.opencv.calib3d.Calib3d
import kotlin.math.*

/** All Mats have a single owner; callers release returned images. No global native image state. */
internal object ReceiptVision {
  data class Paper(
    val corners: Array<Point>,
    val sharpness: Double,
    val brightness: Double,
    val confidence: Double,
    val topClipped: Boolean,
    val bottomClipped: Boolean,
    val captureEligible: Boolean,
  )

  enum class CropOutcome(val bridgeValue: String) {
    PERSPECTIVE("perspective"),
    VISIBLE_SECTION("visible-section"),
    ORIGINAL_FALLBACK("original-fallback"),
  }

  data class CapturedCrop(
    val image: Mat,
    val corners: Array<Point>?,
    val outcome: CropOutcome,
  ) : AutoCloseable {
    override fun close() = image.release()
  }

  data class CapturedEnhancement(
    val image: Mat,
    val applied: Boolean,
  ) : AutoCloseable {
    override fun close() = image.release()
  }

  data class RegisteredFrame(
    val offset: Int,
    val image: Mat,
    val inlierRatio: Double,
    val meanDifference: Double,
  ) : AutoCloseable {
    override fun close() = image.release()
  }

  fun detect(rgb: Mat, long: Boolean): Paper? {
    val gray = Mat(); val blur = Mat(); val mask = Mat(); val hierarchy = Mat(); val edges = Mat()
    val contours = ArrayList<MatOfPoint>()
    try {
      Imgproc.cvtColor(rgb, gray, Imgproc.COLOR_RGB2GRAY)
      Imgproc.GaussianBlur(gray, blur, Size(5.0, 5.0), 0.0)
      Imgproc.threshold(blur, mask, 0.0, 255.0, Imgproc.THRESH_BINARY + Imgproc.THRESH_OTSU)
      Imgproc.findContours(mask, contours, hierarchy, Imgproc.RETR_EXTERNAL, Imgproc.CHAIN_APPROX_SIMPLE)
      // Otsu can merge pale paper with a light table, so edge contours provide
      // candidates governed by the same geometry, texture and confidence checks.
      Imgproc.Canny(blur, edges, 35.0, 105.0)
      val edgeContours = ArrayList<MatOfPoint>()
      Imgproc.findContours(edges, edgeContours, hierarchy, Imgproc.RETR_LIST, Imgproc.CHAIN_APPROX_SIMPLE)
      contours.addAll(edgeContours)
      val total = rgb.rows().toDouble() * rgb.cols()
      for (contour in contours.sortedByDescending { Imgproc.contourArea(it) }) {
        val contourArea = Imgproc.contourArea(contour)
        val bounds = Imgproc.boundingRect(contour)
        val verticallyClipped = bounds.y <= 4 || bounds.y + bounds.height >= rgb.rows() - 4
        val guideCandidate = long || verticallyClipped
        if (contourArea < total * (if (guideCandidate) .055 else .16)) continue
        val points = MatOfPoint2f(*contour.toArray()); val approx = MatOfPoint2f()
        val corners: Array<Point>
        var quadrilateral = false
        try {
          Imgproc.approxPolyDP(points, approx, Imgproc.arcLength(points, true) * .025, true)
          val candidate = if (approx.total() == 4L) {
            quadrilateral = true
            approx.toArray()
          } else if (verticallyClipped) {
            // Clipped receipts can have an open contour; a bounded rotated box
            // recovers only the visible strip.
            val rect = Imgproc.minAreaRect(points)
            val box = arrayOf(Point(), Point(), Point(), Point())
            rect.points(box)
            if (rect.size.area() > contourArea * 1.55) continue
            box
          } else continue
          val poly = MatOfPoint(*candidate)
          val convex = try { Imgproc.isContourConvex(poly) } finally { poly.release() }
          if (!convex) continue
          corners = orderedCorners(candidate)
        } finally { points.release(); approx.release() }
        if (corners.toSet().size != 4) continue
        if (corners.any { it.x < 5 || it.x > rgb.cols() - 6 }) continue
        val width = (distance(corners[0], corners[1]) + distance(corners[3], corners[2])) / 2
        val height = (distance(corners[0], corners[3]) + distance(corners[1], corners[2])) / 2
        if (width < rgb.cols() * (if (guideCandidate) .18 else .22) || height < width * (if (guideCandidate) .28 else .65)) continue
        val patch = warp(rgb, corners, min(600, width.toInt()))
        val pg = Mat(); val lap = Mat(); val mean = MatOfDouble(); val std = MatOfDouble()
        try {
          Imgproc.cvtColor(patch, pg, Imgproc.COLOR_RGB2GRAY)
          val texture = textTexture(pg)
          if (texture.glyphs < (if (guideCandidate) 10 else 18) || texture.bands < (if (guideCandidate) 2 else 3)) continue
          Imgproc.Laplacian(pg, lap, CvType.CV_64F)
          Core.meanStdDev(lap, mean, std)
          val areaRatio = contourArea / total
          val confidence = (areaRatio / (if (guideCandidate) .18 else .30)).coerceIn(0.0, 1.0) * .45 +
            (texture.glyphs / 30.0).coerceIn(0.0, 1.0) * .35 +
            (texture.bands / 5.0).coerceIn(0.0, 1.0) * .20
          if (confidence < (if (guideCandidate) .34 else .50)) continue
          val topClipped = corners[0].y <= 8 || corners[1].y <= 8
          val bottomClipped = corners[2].y >= rgb.rows() - 9 || corners[3].y >= rgb.rows() - 9
          return Paper(
            corners,
            std.toArray()[0].pow(2),
            Core.mean(pg).`val`[0],
            confidence,
            topClipped,
            bottomClipped,
            quadrilateral && !verticallyClipped && !topClipped && !bottomClipped,
          )
        } finally { patch.release(); pg.release(); lap.release(); mean.release(); std.release() }
      }
      return null
    } finally { gray.release(); blur.release(); mask.release(); edges.release(); hierarchy.release(); contours.forEach { it.release() } }
  }

  /** Rectifies only inset or vertically clipped geometry from the oriented still.
   * Side-clipped or ambiguous scenes keep the complete visible camera frame. */
  internal fun cropCapturedStill(
    rgb: Mat,
    detector: (Mat) -> Paper? = { detect(it, false) },
    rectifier: (Mat, Array<Point>, Int) -> Mat = { image, points, width ->
      warp(image, points, width, maxPixels = 4_000_000L)
    },
  ): CapturedCrop {
    fun fallback() = CapturedCrop(rgb.clone(), null, CropOutcome.ORIGINAL_FALLBACK)

    return try {
      val paper = detector(rgb) ?: return fallback()
      val visibleSection = paper.topClipped || paper.bottomClipped
      if (!paper.captureEligible && !visibleSection) return fallback()

      // `detect` already rejects candidates touching a side boundary. Keep that
      // invariant here so a missing side is never fabricated from the frame.
      if (paper.corners.any { it.x < 5.0 || it.x > rgb.cols() - 6.0 }) return fallback()
      val safeCorners = expandAndClamp(paper.corners, rgb.cols(), rgb.rows())
      val receiptWidth = max(
        distance(safeCorners[0], safeCorners[1]),
        distance(safeCorners[3], safeCorners[2]),
      ).roundToInt().coerceIn(1000, 1800)
      val corrected = rectifier(rgb, safeCorners, receiptWidth)
      if (corrected.empty()) {
        corrected.release()
        fallback()
      } else {
        CapturedCrop(
          corrected,
          safeCorners,
          if (visibleSection) CropOutcome.VISIBLE_SECTION else CropOutcome.PERSPECTIVE,
        )
      }
    } catch (_: Exception) {
      fallback()
    }
  }

  /** Enhancement is optional after a successful shutter; failure keeps pixels. */
  internal fun enhanceCapturedStill(
    rgb: Mat,
    enhancer: (Mat) -> Mat = { enhance(it) },
  ): CapturedEnhancement = try {
    val result = enhancer(rgb)
    if (result.empty()) {
      result.release()
      CapturedEnhancement(rgb.clone(), false)
    } else CapturedEnhancement(result, true)
  } catch (_: Exception) {
    CapturedEnhancement(rgb.clone(), false)
  }

  private fun expandAndClamp(points: Array<Point>, width: Int, height: Int): Array<Point> {
    val center = Point(points.map { it.x }.average(), points.map { it.y }.average())
    val margin = (min(width, height) * .012).coerceIn(3.0, 24.0)
    return points.map { point ->
      val dx = point.x - center.x
      val dy = point.y - center.y
      val length = hypot(dx, dy).coerceAtLeast(1.0)
      Point(
        (point.x + dx / length * margin).coerceIn(0.0, width - 1.0),
        (point.y + dy / length * margin).coerceIn(0.0, height - 1.0),
      )
    }.toTypedArray()
  }

  fun distance(a: Point, b: Point) = hypot(a.x - b.x, a.y - b.y)

  /** Maps a stable analysis-frame quadrilateral into the same CameraX viewport at still resolution. */
  fun mapCornersBetweenFrames(
    corners: Array<Point>,
    analysisWidth: Int,
    analysisHeight: Int,
    stillWidth: Int,
    stillHeight: Int,
  ): Array<Point> {
    require(analysisWidth > 0 && analysisHeight > 0 && stillWidth > 0 && stillHeight > 0)
    val analysisAspect = analysisWidth.toDouble() / analysisHeight
    val stillAspect = stillWidth.toDouble() / stillHeight
    val visibleWidth: Double
    val visibleHeight: Double
    val offsetX: Double
    val offsetY: Double
    if (stillAspect > analysisAspect) {
      visibleHeight = stillHeight.toDouble()
      visibleWidth = visibleHeight * analysisAspect
      offsetX = (stillWidth - visibleWidth) / 2.0
      offsetY = 0.0
    } else {
      visibleWidth = stillWidth.toDouble()
      visibleHeight = visibleWidth / analysisAspect
      offsetX = 0.0
      offsetY = (stillHeight - visibleHeight) / 2.0
    }
    return corners.map { point ->
      Point(
        (offsetX + point.x / analysisWidth * visibleWidth).coerceIn(0.0, stillWidth - 1.0),
        (offsetY + point.y / analysisHeight * visibleHeight).coerceIn(0.0, stillHeight - 1.0),
      )
    }.toTypedArray()
  }

  private data class Texture(val glyphs: Int, val bands: Int)

  private fun orderedCorners(points: Array<Point>): Array<Point> = arrayOf(
    points.minBy { it.x + it.y },
    points.maxBy { it.x - it.y },
    points.maxBy { it.x + it.y },
    points.minBy { it.x - it.y },
  )

  private fun textTexture(gray: Mat): Texture {
    val binary = Mat(); val hierarchy = Mat(); val contours = ArrayList<MatOfPoint>()
    try {
      Imgproc.adaptiveThreshold(gray, binary, 255.0, Imgproc.ADAPTIVE_THRESH_GAUSSIAN_C, Imgproc.THRESH_BINARY_INV, 21, 12.0)
      Imgproc.findContours(binary, contours, hierarchy, Imgproc.RETR_LIST, Imgproc.CHAIN_APPROX_SIMPLE)
      val glyphs = contours.map { Imgproc.boundingRect(it) }.filter { it.height in 3..max(4, gray.rows() / 16) && it.width in 1..max(3, gray.cols() / 10) && it.area() >= 5 && it.x > 5 && it.y > 5 && it.x + it.width < gray.cols() - 5 && it.y + it.height < gray.rows() - 5 }
      return Texture(glyphs.size, glyphs.map { it.y / max(8, gray.rows() / 12) }.distinct().size)
    } finally { binary.release(); hierarchy.release(); contours.forEach { it.release() } }
  }

  /**
   * `exact` normalises every long-scan frame to one width. Clamping to the
   * measured width instead makes the output a pixel narrower whenever the hand
   * drifts back, which the compositor then rejects as a distance change.
   */
  fun warp(
    rgb: Mat,
    p: Array<Point>,
    requestedWidth: Int = 1200,
    exact: Boolean = false,
    maxPixels: Long? = null,
  ): Mat {
    val natural = max(distance(p[0], p[1]), distance(p[3], p[2])).coerceAtLeast(1.0)
    var width = (if (exact) requestedWidth else min(requestedWidth, natural.roundToInt())).coerceAtLeast(32)
    val ratio = max(distance(p[0], p[3]), distance(p[1], p[2])) / natural
    var height = (width * ratio).roundToInt().coerceIn(32, 6000)
    if (maxPixels != null && width.toLong() * height > maxPixels) {
      require(maxPixels >= 32L * 32L)
      val scale = sqrt(maxPixels.toDouble() / (width.toDouble() * height))
      width = floor(width * scale).toInt().coerceAtLeast(32)
      height = floor(height * scale).toInt().coerceAtLeast(32)
      if (width.toLong() * height > maxPixels) {
        height = (maxPixels / width).toInt().coerceAtLeast(32)
      }
    }
    val from = MatOfPoint2f(*p); val to = MatOfPoint2f(Point(0.0, 0.0), Point(width - 1.0, 0.0), Point(width - 1.0, height - 1.0), Point(0.0, height - 1.0))
    val transform = Imgproc.getPerspectiveTransform(from, to); val out = Mat()
    try { Imgproc.warpPerspective(rgb, out, transform, Size(width.toDouble(), height.toDouble()), Imgproc.INTER_LINEAR, Core.BORDER_REPLICATE); return out }
    catch (e: Exception) { out.release(); throw e }
    finally { from.release(); to.release(); transform.release() }
  }

  /** Modest local illumination correction, kept in color. Never threshold thermal text. */
  fun enhance(rgb: Mat): Mat {
    val out = Mat(rgb.rows(), rgb.cols(), rgb.type())
    // Keep floating-point buffers bounded even for a 12 MP panorama. The halo
    // covers the entire finite Gaussian kernel, so tile seams are pixel-identical.
    try {
      var y = 0
      while (y < rgb.rows()) {
        val rows = min(256, rgb.rows() - y)
        val start = max(0, y - 140); val end = min(rgb.rows(), y + rows + 140)
        val source = rgb.submat(Rect(0, start, rgb.cols(), end - start))
        val corrected = try { enhanceTile(source) } finally { source.release() }
        val center = corrected.submat(Rect(0, y - start, rgb.cols(), rows))
        val target = out.submat(Rect(0, y, rgb.cols(), rows))
        try { center.copyTo(target) } finally { center.release(); target.release(); corrected.release() }
        y += rows
      }
      return out
    } catch (e: Exception) { out.release(); throw e }
  }

  internal fun enhanceTile(rgb: Mat): Mat {
    val floating = Mat(); val background = Mat(); val normalized = Mat(); val out = Mat()
    try {
      rgb.convertTo(floating, CvType.CV_32FC3)
      Imgproc.GaussianBlur(floating, background, Size(281.0, 281.0), 35.0)
      Core.max(background, Scalar.all(120.0), background)
      Core.divide(floating, background, normalized, 235.0)
      Core.addWeighted(floating, .55, normalized, .45, 0.0, out)
      out.convertTo(out, CvType.CV_8UC3)
      return out
    } catch (e: Exception) { out.release(); throw e }
    finally { floating.release(); background.release(); normalized.release() }
  }

  /** Corrects bounded handheld motion before overlap verification; invalid travel fails closed. */
  fun registerDownward(previous: Mat, current: Mat): RegisteredFrame? {
    if (previous.cols() != current.cols()) return null
    val orb = ORB.create(1600); val matcher = BFMatcher.create(Core.NORM_HAMMING, false)
    val pg = Mat(); val cg = Mat(); val pk = MatOfKeyPoint(); val ck = MatOfKeyPoint(); val pd = Mat(); val cd = Mat(); val empty = Mat()
    val matches = ArrayList<MatOfDMatch>(); val from = MatOfPoint2f(); val to = MatOfPoint2f(); val inliers = Mat()
    var affine: Mat? = null; var stabilizer: Mat? = null; var aligned: Mat? = null
    try {
      Imgproc.cvtColor(previous, pg, Imgproc.COLOR_RGB2GRAY); Imgproc.cvtColor(current, cg, Imgproc.COLOR_RGB2GRAY)
      orb.detectAndCompute(pg, empty, pk, pd); orb.detectAndCompute(cg, empty, ck, cd)
      if (pd.empty() || cd.empty()) return null
      matcher.knnMatch(cd, pd, matches, 2)
      val good = matches.mapNotNull { val a = it.toArray(); if (a.size == 2 && a[0].distance < .74 * a[1].distance && a[0].distance < 68) a[0] else null }
      if (good.size < 18 || good.map { it.trainIdx }.distinct().size < good.size * .75) return null
      val p = pk.toArray(); val c = ck.toArray()
      from.fromArray(*good.map { c[it.queryIdx].pt }.toTypedArray()); to.fromArray(*good.map { p[it.trainIdx].pt }.toTypedArray())
      affine = Calib3d.estimateAffinePartial2D(from, to, inliers, Calib3d.RANSAC, 3.0, 2000, .995, 10)
      val inlierCount = Core.countNonZero(inliers)
      if (affine.empty() || inlierCount < max(14.0, good.size * .55)) return null
      val a = affine.get(0, 0)[0]; val b = affine.get(1, 0)[0]; val dx = affine.get(0, 2)[0]; val dy = affine.get(1, 2)[0]
      if (abs(hypot(a, b) - 1) > .06 || abs(atan2(b, a)) > Math.toRadians(3.0) || abs(dx) > current.cols() * .08) return null
      // Require distributed support, not a single repeated price/line.
      val accepted = good.indices.filter { inliers.get(it, 0)[0] != 0.0 }.map { c[good[it].queryIdx].pt }
      if ((accepted.maxOf { it.x } - accepted.minOf { it.x }) < current.cols() * .25 || (accepted.maxOf { it.y } - accepted.minOf { it.y }) < current.rows() * .12) return null
      if (dy < -12 || dy > min(previous.rows(), current.rows()) * .62) return null
      val offset = dy.roundToInt().coerceAtLeast(0)

      val rawDifference = verifiedOverlapDifference(pg, cg, offset, 28.0)
      if (rawDifference != null) {
        return RegisteredFrame(offset, current.clone(), inlierCount.toDouble() / good.size, rawDifference)
      }

      stabilizer = affine.clone()
      stabilizer.put(1, 2, dy - offset)
      aligned = Mat()
      Imgproc.warpAffine(current, aligned, stabilizer, current.size(), Imgproc.INTER_LINEAR, Core.BORDER_REPLICATE)
      val alignedGray = Mat()
      Imgproc.cvtColor(aligned, alignedGray, Imgproc.COLOR_RGB2GRAY)
      val meanDifference = verifiedOverlapDifference(pg, alignedGray, offset, 40.0)
      try {
        if (meanDifference == null) return null
        val result = RegisteredFrame(offset, aligned, inlierCount.toDouble() / good.size, meanDifference)
        aligned = null
        return result
      } finally { alignedGray.release() }
    } finally {
      pg.release(); cg.release(); pk.release(); ck.release(); pd.release(); cd.release(); empty.release(); from.release(); to.release(); inliers.release(); affine?.release(); stabilizer?.release(); aligned?.release(); matches.forEach { it.release() }; orb.clear(); matcher.clear()
    }
  }

  private fun verifiedOverlapDifference(previousGray: Mat, currentGray: Mat, offset: Int, maximumDifference: Double): Double? {
    val overlap = min(previousGray.rows() - offset, currentGray.rows())
    if (overlap < min(previousGray.rows(), currentGray.rows()) * .32) return null
    val oldPixels = previousGray.submat(Rect(0, offset, previousGray.cols(), overlap))
    val newPixels = currentGray.submat(Rect(0, 0, currentGray.cols(), overlap))
    val difference = Mat(); val ink = Mat(); val otherInk = Mat()
    try {
      Core.absdiff(oldPixels, newPixels, difference)
      Imgproc.threshold(oldPixels, ink, 160.0, 255.0, Imgproc.THRESH_BINARY_INV)
      Imgproc.threshold(newPixels, otherInk, 160.0, 255.0, Imgproc.THRESH_BINARY_INV)
      Core.bitwise_or(ink, otherInk, ink)
      if (Core.countNonZero(ink) < 100) return null
      val mean = Core.mean(difference, ink).`val`[0]
      return mean.takeIf { it <= maximumDifference }
    } finally { oldPixels.release(); newPixels.release(); difference.release(); ink.release(); otherInk.release() }
  }

  fun downwardOffset(previous: Mat, current: Mat): Int? = registerDownward(previous, current)?.use { it.offset }
}
