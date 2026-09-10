package expo.modules.finsightreceiptscanner

import org.opencv.core.*
import org.opencv.imgproc.Imgproc
import org.opencv.features2d.ORB
import org.opencv.features2d.BFMatcher
import org.opencv.calib3d.Calib3d
import kotlin.math.*

/** All Mats have a single owner; callers release returned images. No global native image state. */
internal object ReceiptVision {
  data class Paper(val corners: Array<Point>, val sharpness: Double, val brightness: Double)

  fun detect(rgb: Mat, long: Boolean): Paper? {
    val gray = Mat(); val blur = Mat(); val mask = Mat(); val hierarchy = Mat(); val edges = Mat()
    val contours = ArrayList<MatOfPoint>()
    try {
      Imgproc.cvtColor(rgb, gray, Imgproc.COLOR_RGB2GRAY)
      Imgproc.GaussianBlur(gray, blur, Size(5.0, 5.0), 0.0)
      Imgproc.threshold(blur, mask, 0.0, 255.0, Imgproc.THRESH_BINARY + Imgproc.THRESH_OTSU)
      Imgproc.findContours(mask, contours, hierarchy, Imgproc.RETR_EXTERNAL, Imgproc.CHAIN_APPROX_SIMPLE)
      // Otsu merges pale paper with a light table. Edge contours recover the
      // enclosed receipt in that case; retain all geometry and text checks.
      if (!long) {
        Imgproc.Canny(blur, edges, 35.0, 105.0)
        val edgeContours = ArrayList<MatOfPoint>()
        Imgproc.findContours(edges, edgeContours, hierarchy, Imgproc.RETR_LIST, Imgproc.CHAIN_APPROX_SIMPLE)
        contours.addAll(edgeContours)
      }
      val total = rgb.rows().toDouble() * rgb.cols()
      for (contour in contours.sortedByDescending { Imgproc.contourArea(it) }) {
        if (Imgproc.contourArea(contour) < total * .16) continue
        val points = MatOfPoint2f(*contour.toArray()); val approx = MatOfPoint2f()
        val corners: Array<Point>
        try {
          Imgproc.approxPolyDP(points, approx, Imgproc.arcLength(points, true) * .025, true)
          if (approx.total() != 4L) continue
          val poly = MatOfPoint(*approx.toArray())
          val convex = try { Imgproc.isContourConvex(poly) } finally { poly.release() }
          if (!convex) continue
          val p = approx.toArray()
          corners = arrayOf(p.minBy { it.x + it.y }, p.maxBy { it.x - it.y }, p.maxBy { it.x + it.y }, p.minBy { it.x - it.y })
        } finally { points.release(); approx.release() }
        if (corners.toSet().size != 4) continue
        if (corners.any { it.x < 5 || it.x > rgb.cols() - 6 }) continue
        if (!long && corners.any { it.y < 5 || it.y > rgb.rows() - 6 }) continue
        val width = (distance(corners[0], corners[1]) + distance(corners[3], corners[2])) / 2
        val height = (distance(corners[0], corners[3]) + distance(corners[1], corners[2])) / 2
        if (width < rgb.cols() * .22 || height < width * .65) continue
        val patch = warp(rgb, corners, min(600, width.toInt()))
        val pg = Mat(); val lap = Mat(); val mean = MatOfDouble(); val std = MatOfDouble()
        try {
          Imgproc.cvtColor(patch, pg, Imgproc.COLOR_RGB2GRAY)
          if (!hasTextTexture(pg)) continue
          Imgproc.Laplacian(pg, lap, CvType.CV_64F)
          Core.meanStdDev(lap, mean, std)
          return Paper(corners, std.toArray()[0].pow(2), Core.mean(pg).`val`[0])
        } finally { patch.release(); pg.release(); lap.release(); mean.release(); std.release() }
      }
      return null
    } finally { gray.release(); blur.release(); mask.release(); edges.release(); hierarchy.release(); contours.forEach { it.release() } }
  }

  fun distance(a: Point, b: Point) = hypot(a.x - b.x, a.y - b.y)

  private fun hasTextTexture(gray: Mat): Boolean {
    val binary = Mat(); val hierarchy = Mat(); val contours = ArrayList<MatOfPoint>()
    try {
      Imgproc.adaptiveThreshold(gray, binary, 255.0, Imgproc.ADAPTIVE_THRESH_GAUSSIAN_C, Imgproc.THRESH_BINARY_INV, 21, 12.0)
      Imgproc.findContours(binary, contours, hierarchy, Imgproc.RETR_LIST, Imgproc.CHAIN_APPROX_SIMPLE)
      val glyphs = contours.map { Imgproc.boundingRect(it) }.filter { it.height in 3..max(4, gray.rows() / 16) && it.width in 1..max(3, gray.cols() / 10) && it.area() >= 5 && it.x > 5 && it.y > 5 && it.x + it.width < gray.cols() - 5 && it.y + it.height < gray.rows() - 5 }
      return glyphs.size >= 18 && glyphs.map { it.y / max(8, gray.rows() / 12) }.distinct().size >= 3
    } finally { binary.release(); hierarchy.release(); contours.forEach { it.release() } }
  }

  /**
   * `exact` normalises every long-scan frame to one width. Clamping to the
   * measured width instead makes the output a pixel narrower whenever the hand
   * drifts back, which the compositor then rejects as a distance change.
   */
  fun warp(rgb: Mat, p: Array<Point>, requestedWidth: Int = 1200, exact: Boolean = false): Mat {
    val natural = max(distance(p[0], p[1]), distance(p[3], p[2])).coerceAtLeast(1.0)
    val width = (if (exact) requestedWidth else min(requestedWidth, natural.roundToInt())).coerceAtLeast(32)
    val ratio = max(distance(p[0], p[3]), distance(p[1], p[2])) / natural
    val height = (width * ratio).roundToInt().coerceIn(32, 6000)
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

  /** Current-to-previous registration. Reject lateral drift, zoom, rotation and weak/repeated texture. */
  fun downwardOffset(previous: Mat, current: Mat): Int? {
    if (previous.cols() != current.cols()) return null
    val orb = ORB.create(1600); val matcher = BFMatcher.create(Core.NORM_HAMMING, false)
    val pg = Mat(); val cg = Mat(); val pk = MatOfKeyPoint(); val ck = MatOfKeyPoint(); val pd = Mat(); val cd = Mat(); val empty = Mat()
    val matches = ArrayList<MatOfDMatch>(); val from = MatOfPoint2f(); val to = MatOfPoint2f(); val inliers = Mat()
    var affine: Mat? = null
    try {
      Imgproc.cvtColor(previous, pg, Imgproc.COLOR_RGB2GRAY); Imgproc.cvtColor(current, cg, Imgproc.COLOR_RGB2GRAY)
      orb.detectAndCompute(pg, empty, pk, pd); orb.detectAndCompute(cg, empty, ck, cd)
      if (pd.empty() || cd.empty()) return null
      matcher.knnMatch(cd, pd, matches, 2)
      val good = matches.mapNotNull { val a = it.toArray(); if (a.size == 2 && a[0].distance < .68 * a[1].distance && a[0].distance < 60) a[0] else null }
      if (good.size < 24 || good.map { it.trainIdx }.distinct().size < good.size * .85) return null
      val p = pk.toArray(); val c = ck.toArray()
      from.fromArray(*good.map { c[it.queryIdx].pt }.toTypedArray()); to.fromArray(*good.map { p[it.trainIdx].pt }.toTypedArray())
      affine = Calib3d.estimateAffinePartial2D(from, to, inliers, Calib3d.RANSAC, 2.0, 2000, .995, 10)
      if (affine.empty() || Core.countNonZero(inliers) < max(20.0, good.size * .75)) return null
      val a = affine.get(0, 0)[0]; val b = affine.get(1, 0)[0]; val dx = affine.get(0, 2)[0]; val dy = affine.get(1, 2)[0]
      if (abs(hypot(a, b) - 1) > .002 || abs(atan2(b, a)) > .002 || abs(dx) > 1.5) return null
      // Require distributed support, not a single repeated price/line.
      val accepted = good.indices.filter { inliers.get(it, 0)[0] != 0.0 }.map { c[good[it].queryIdx].pt }
      if ((accepted.maxOf { it.x } - accepted.minOf { it.x }) < current.cols() * .35 || (accepted.maxOf { it.y } - accepted.minOf { it.y }) < current.rows() * .2) return null
      if (dy < -8 || dy > min(previous.rows(), current.rows()) * .45) return null
      val offset = dy.roundToInt().coerceAtLeast(0)
      // The compositor applies translation only. A plausible feature transform is
      // insufficient: verify that its discarded rotation/scale/drift does not move ink.
      val overlap = min(previous.rows() - offset, current.rows())
      val oldPixels = pg.submat(Rect(0, offset, pg.cols(), overlap))
      val newPixels = cg.submat(Rect(0, 0, cg.cols(), overlap))
      val difference = Mat(); val ink = Mat(); val otherInk = Mat()
      try {
        Core.absdiff(oldPixels, newPixels, difference)
        Imgproc.threshold(oldPixels, ink, 160.0, 255.0, Imgproc.THRESH_BINARY_INV)
        Imgproc.threshold(newPixels, otherInk, 160.0, 255.0, Imgproc.THRESH_BINARY_INV)
        Core.bitwise_or(ink, otherInk, ink)
        if (Core.countNonZero(ink) < 100 || Core.mean(difference, ink).`val`[0] > 28.0) return null
      } finally { oldPixels.release(); newPixels.release(); difference.release(); ink.release(); otherInk.release() }
      return offset
    } finally {
      pg.release(); cg.release(); pk.release(); ck.release(); pd.release(); cd.release(); empty.release(); from.release(); to.release(); inliers.release(); affine?.release(); matches.forEach { it.release() }; orb.clear(); matcher.clear()
    }
  }
}
