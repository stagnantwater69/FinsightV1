package expo.modules.finsightreceiptscanner

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import java.io.File
import org.opencv.android.Utils
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith
import org.opencv.android.OpenCVLoader
import org.opencv.core.*
import org.opencv.imgproc.Imgproc
import kotlin.random.Random

/** Synthetic pixel evidence, not physical-camera or real thermal-receipt acceptance. */
@RunWith(AndroidJUnit4::class)
class ReceiptVisionInstrumentedTest {
  companion object {
    @JvmStatic @BeforeClass fun loadOpenCv() { assertTrue(OpenCVLoader.initLocal()) }
  }

  private fun paper(seed: Int = 19): Mat {
    val image = Mat(1500, 600, CvType.CV_8UC3, Scalar.all(245.0))
    val random = Random(seed)
    // Unique two-dimensional receipt-like texture avoids validating only a single line.
    for (row in 0 until 45) {
      val y = 30 + row * 32
      Imgproc.putText(image, "ITEM ${row * 137 + seed}  ${random.nextInt(100, 999)}.50", Point(30.0, y.toDouble()), Imgproc.FONT_HERSHEY_SIMPLEX, .65, Scalar.all(40.0), 2)
      for (column in 0 until 10) {
        val x = random.nextInt(20, 570); val yy = y + random.nextInt(0, 18)
        Imgproc.rectangle(image, Point(x.toDouble(), yy.toDouble()), Point((x + random.nextInt(2, 9)).toDouble(), (yy + 4).toDouble()), Scalar.all(70.0), -1)
      }
    }
    return image
  }

  @Test fun registersKnownDownwardMotionAndRejectsReverseOrMissingOverlap() {
    val image = paper(); val other = paper(883)
    val top = image.submat(Rect(0, 0, 600, 800)); val next = image.submat(Rect(0, 180, 600, 800))
    val gap = image.submat(Rect(0, 600, 600, 800)); val unrelated = other.submat(Rect(0, 0, 600, 800))
    try {
      val offset = ReceiptVision.downwardOffset(top, next)
      assertNotNull("Distinct overlap should register", offset)
      assertEquals(180.0, offset!!.toDouble(), 2.0)
      assertNull("Reverse movement must not silently duplicate receipt rows", ReceiptVision.downwardOffset(next, top))
      assertNull("Insufficient overlap must not skip receipt rows", ReceiptVision.downwardOffset(top, gap))
      assertNull("Unrelated content must not be stitched", ReceiptVision.downwardOffset(top, unrelated))
    } finally { top.release(); next.release(); gap.release(); unrelated.release(); image.release(); other.release() }
  }

  @Test fun repeatedRowsDoNotFabricateConfidentMotion() {
    val image = Mat(1100, 600, CvType.CV_8UC3, Scalar.all(245.0))
    for (y in 20 until 1100 step 40) Imgproc.putText(image, "ITEM SAME       10.00", Point(30.0, y.toDouble()), Imgproc.FONT_HERSHEY_SIMPLEX, .7, Scalar.all(30.0), 2)
    val first = image.submat(Rect(0, 0, 600, 800)); val second = image.submat(Rect(0, 160, 600, 800))
    try {
      val result = ReceiptVision.downwardOffset(first, second)
      assertTrue("Indistinguishable rows may reject or hold, never invent an advance: $result", result == null || result == 0)
    } finally { first.release(); second.release(); image.release() }
  }

  @Test fun noPaperAndDarkFramesAreNotDetectedAsDocuments() {
    for (brightness in listOf(0.0, 15.0, 255.0)) {
      val image = Mat(800, 600, CvType.CV_8UC3, Scalar.all(brightness))
      try { assertNull(ReceiptVision.detect(image, false)); assertNull(ReceiptVision.detect(image, true)) }
      finally { image.release() }
    }
  }

  @Test fun clippedReceiptGuidesPreviewAndProducesVisiblePostCaptureSection() {
    val partial = Mat(900, 700, CvType.CV_8UC3, Scalar.all(25.0))
    val plain = Mat(900, 700, CvType.CV_8UC3, Scalar.all(25.0))
    Imgproc.rectangle(partial, Point(100.0, 0.0), Point(600.0, 190.0), Scalar.all(242.0), -1)
    Imgproc.rectangle(plain, Point(100.0, 0.0), Point(600.0, 190.0), Scalar.all(242.0), -1)
    for (y in listOf(42, 92, 142)) {
      Imgproc.putText(partial, "ITEM ${y * 17}  123.45", Point(125.0, y.toDouble()), Imgproc.FONT_HERSHEY_SIMPLEX, .72, Scalar.all(35.0), 2)
    }
    try {
      val found = ReceiptVision.detect(partial, true)
      assertNotNull("A textured receipt strip clipped by the frame remains trackable", found)
      assertTrue(found!!.topClipped)
      assertFalse(found.bottomClipped)
      assertFalse(found.captureEligible)
      assertTrue(found.confidence > 0)
      assertNull("Geometry alone must not turn a bright surface into a receipt", ReceiptVision.detect(plain, true))
      val standardGuide = ReceiptVision.detect(partial, false)
      assertNotNull("Standard preview should guide around the visible receipt strip", standardGuide)
      assertTrue(standardGuide!!.topClipped)
      assertFalse("A clipped guide must not trigger Standard auto-capture", standardGuide.captureEligible)
      assertNull("Standard guidance still requires receipt-like texture", ReceiptVision.detect(plain, false))
      ReceiptVision.cropCapturedStill(partial).use { cropped ->
        assertEquals(ReceiptVision.CropOutcome.VISIBLE_SECTION, cropped.outcome)
        assertNotNull(cropped.corners)
        assertEquals(0.0, cropped.corners!![0].y, 0.0)
        assertFalse(cropped.image.empty())
      }
    } finally { partial.release(); plain.release() }
  }

  @Test fun findsInsetPaperAndWarpRemovesDarkSurroundings() {
    val image = Mat(900, 700, CvType.CV_8UC3, Scalar.all(25.0))
    Imgproc.rectangle(image, Point(100.0, 70.0), Point(600.0, 830.0), Scalar.all(240.0), -1)
    for (y in 150..700 step 70) Imgproc.putText(image, "ITEM TOTAL 123.45", Point(125.0, y.toDouble()), Imgproc.FONT_HERSHEY_SIMPLEX, .8, Scalar.all(30.0), 2)
    try {
      val found = ReceiptVision.detect(image, false)
      assertNotNull(found)
      assertTrue("A complete inset quadrilateral is eligible for capture", found!!.captureEligible)
      val result = ReceiptVision.warp(image, found.corners)
      try { assertTrue(Core.mean(result).`val`[0] > 220); assertTrue(result.rows() > result.cols()) }
      finally { result.release() }
    } finally { image.release() }
  }

  @Test fun completeCapturedStillUsesPerspectiveCropWithOutwardMargin() {
    val image = Mat(900, 700, CvType.CV_8UC3, Scalar.all(25.0))
    Imgproc.rectangle(image, Point(100.0, 70.0), Point(600.0, 830.0), Scalar.all(240.0), -1)
    val detectedCorners = arrayOf(
      Point(100.0, 70.0),
      Point(600.0, 70.0),
      Point(600.0, 830.0),
      Point(100.0, 830.0),
    )
    val paper = ReceiptVision.Paper(detectedCorners, 200.0, 240.0, .95, false, false, true)
    try {
      ReceiptVision.cropCapturedStill(image, detector = { paper }).use { cropped ->
        assertEquals(ReceiptVision.CropOutcome.PERSPECTIVE, cropped.outcome)
        val expanded = cropped.corners
        assertNotNull(expanded)
        assertTrue(expanded!![0].x < detectedCorners[0].x)
        assertTrue(expanded[0].y < detectedCorners[0].y)
        assertTrue(cropped.image.rows() > cropped.image.cols())
      }
    } finally { image.release() }
  }

  @Test fun verticallyClippedCapturedStillsCropOnlyVisiblePixels() {
    val image = Mat(900, 700, CvType.CV_8UC3, Scalar.all(240.0))
    val candidates = listOf(
      ReceiptVision.Paper(
        arrayOf(Point(100.0, 0.0), Point(600.0, 0.0), Point(600.0, 800.0), Point(100.0, 800.0)),
        200.0, 240.0, .9, true, false, false,
      ),
      ReceiptVision.Paper(
        arrayOf(Point(100.0, 100.0), Point(600.0, 100.0), Point(600.0, 899.0), Point(100.0, 899.0)),
        200.0, 240.0, .9, false, true, false,
      ),
    )
    try {
      candidates.forEach { candidate ->
        ReceiptVision.cropCapturedStill(image, detector = { candidate }).use { cropped ->
          assertEquals(ReceiptVision.CropOutcome.VISIBLE_SECTION, cropped.outcome)
          val corners = cropped.corners
          assertNotNull(corners)
          assertTrue(corners!!.all { it.x in 0.0..699.0 && it.y in 0.0..899.0 })
          if (candidate.topClipped) assertEquals(0.0, corners[0].y, 0.0)
          if (candidate.bottomClipped) assertEquals(899.0, corners[2].y, 0.0)
        }
      }
    } finally { image.release() }
  }

  @Test fun capturedStillFallsBackForSideClippedAmbiguousAndMissingDocuments() {
    val image = Mat(900, 700, CvType.CV_8UC3, Scalar.all(83.0))
    val sideClipped = ReceiptVision.Paper(
      arrayOf(Point(0.0, 60.0), Point(600.0, 60.0), Point(600.0, 840.0), Point(0.0, 840.0)),
      200.0, 240.0, .9, false, false, true,
    )
    val ambiguous = ReceiptVision.Paper(
      arrayOf(Point(100.0, 60.0), Point(600.0, 60.0), Point(600.0, 840.0), Point(100.0, 840.0)),
      200.0, 240.0, .4, false, false, false,
    )
    try {
      listOf(sideClipped, ambiguous, null).forEach { candidate ->
        ReceiptVision.cropCapturedStill(image, detector = { candidate }).use { cropped ->
          assertEquals(ReceiptVision.CropOutcome.ORIGINAL_FALLBACK, cropped.outcome)
          assertNull(cropped.corners)
          assertEquals(image.cols(), cropped.image.cols())
          assertEquals(image.rows(), cropped.image.rows())
          assertEquals(0.0, Core.norm(image, cropped.image, Core.NORM_INF), 0.0)
        }
      }
    } finally { image.release() }
  }

  @Test fun capturedStillFallsBackWhenPerspectiveWarpFails() {
    val image = Mat(900, 700, CvType.CV_8UC3, Scalar.all(83.0))
    val paper = ReceiptVision.Paper(
      arrayOf(Point(100.0, 60.0), Point(600.0, 60.0), Point(600.0, 840.0), Point(100.0, 840.0)),
      200.0, 240.0, .9, false, false, true,
    )
    try {
      ReceiptVision.cropCapturedStill(
        image,
        detector = { paper },
        rectifier = { _, _, _ -> throw IllegalStateException("forced warp failure") },
      ).use { cropped ->
        assertEquals(ReceiptVision.CropOutcome.ORIGINAL_FALLBACK, cropped.outcome)
        assertNull(cropped.corners)
        assertEquals(0.0, Core.norm(image, cropped.image, Core.NORM_INF), 0.0)
      }
    } finally { image.release() }
  }

  @Test fun capturedStillEnhancementFailureReturnsUnmodifiedPixels() {
    val image = Mat(900, 700, CvType.CV_8UC3, Scalar.all(83.0))
    try {
      ReceiptVision.enhanceCapturedStill(image) {
        throw IllegalStateException("forced enhancement failure")
      }.use { enhanced ->
        assertFalse(enhanced.applied)
        assertEquals(image.cols(), enhanced.image.cols())
        assertEquals(image.rows(), enhanced.image.rows())
        assertEquals(0.0, Core.norm(image, enhanced.image, Core.NORM_INF), 0.0)
      }
    } finally { image.release() }
  }

  @Test fun analysisCornersMapToTheCenteredFullResolutionStill() {
    val corners = arrayOf(Point(96.0, 128.0), Point(864.0, 128.0), Point(864.0, 1152.0), Point(96.0, 1152.0))
    val sameAspect = ReceiptVision.mapCornersBetweenFrames(corners, 960, 1280, 3024, 4032)
    assertEquals(302.4, sameAspect[0].x, .01)
    assertEquals(403.2, sameAspect[0].y, .01)
    assertEquals(2721.6, sameAspect[2].x, .01)
    assertEquals(3628.8, sameAspect[2].y, .01)

    val widerStill = ReceiptVision.mapCornersBetweenFrames(
      arrayOf(Point(0.0, 0.0), Point(1000.0, 0.0), Point(1000.0, 1000.0), Point(0.0, 1000.0)),
      1000,
      1000,
      1200,
      1000,
    )
    assertEquals("A wider still is center-cropped to the analysis field of view", 100.0, widerStill[0].x, .01)
    assertEquals(1100.0, widerStill[1].x, .01)
  }

  @Test fun standardDerivativeWarpKeepsAspectInsidePixelBudget() {
    val image = Mat(100, 100, CvType.CV_8UC3, Scalar.all(240.0))
    val corners = arrayOf(
      Point(0.0, 0.0),
      Point(1600.0, 0.0),
      Point(1600.0, 5000.0),
      Point(0.0, 5000.0),
    )
    val result = ReceiptVision.warp(image, corners, 1800, maxPixels = 4_000_000L)
    try {
      assertTrue(result.cols().toLong() * result.rows() <= 4_000_000L)
      assertEquals(5000.0 / 1600.0, result.rows().toDouble() / result.cols(), .01)
    } finally { result.release(); image.release() }
  }

  @Test fun standardCaptureCallbackAndDeadlineCannotBothWin() {
    val callbackWins = CaptureResultGate()
    assertTrue(callbackWins.claim())
    assertFalse("A late timeout cannot emit after a completed callback", callbackWins.claim())

    val deadlineWins = CaptureResultGate()
    assertTrue(deadlineWins.claim())
    assertFalse("A late CameraX callback cannot emit after timeout", deadlineWins.claim())
  }

  @Test fun stitchedSequencePreservesEveryRowAndRejectsGapWithoutMutation() {
    val image = paper(); val session = LongReceiptSession()
    try {
      for (offset in listOf(0, 180, 360, 540)) {
        val frame = image.submat(Rect(0, offset, 600, 800))
        try { assertTrue("Frame at $offset must register", session.accept(frame, offset.toLong() + 1)) }
        finally { frame.release() }
      }
      val result = session.result(); val expected = image.submat(Rect(0, 0, 600, 1340))
      try {
        assertEquals(1340, result.rows())
        assertEquals("Synthetic exact translations must not omit, duplicate or replace receipt rows", 0.0, Core.norm(expected, result, Core.NORM_INF), 0.0)
      } finally { result.release(); expected.release() }
      val backwards = image.submat(Rect(0, 0, 600, 800))
      try { assertFalse(session.accept(backwards, 999)); assertEquals(1340, session.height) }
      finally { backwards.release() }
    } finally { session.close(); image.release() }
    assertEquals(0, session.height)
  }

  @Test fun standardDetectsPaperBoundaryWhenLightTableMergesWithPaperThreshold() {
    val image = Mat(900, 700, CvType.CV_8UC3, Scalar.all(235.0))
    Imgproc.rectangle(image, Point(100.0, 70.0), Point(600.0, 830.0), Scalar.all(245.0), -1)
    Imgproc.rectangle(image, Point(100.0, 70.0), Point(600.0, 830.0), Scalar.all(90.0), 2)
    for (y in 150..700 step 70) Imgproc.putText(image, "ITEM TOTAL 123.45", Point(125.0, y.toDouble()), Imgproc.FONT_HERSHEY_SIMPLEX, .8, Scalar.all(30.0), 2)
    try {
      val found = ReceiptVision.detect(image, false)
      assertNotNull("Enclosed textured paper remains detectable on a light surface", found)
      assertTrue(found!!.corners.all { it.x in 95.0..605.0 && it.y in 65.0..835.0 })
    } finally { image.release() }
  }

  @Test fun registeredShorterBottomFrameCanFinishWithoutAddingBackgroundRows() {
    val image = paper(); val session = LongReceiptSession()
    val first = image.submat(Rect(0, 0, 600, 800))
    val bottom = image.submat(Rect(0, 180, 600, 600))
    try {
      assertTrue(session.accept(first, 1))
      assertFalse("A shorter middle frame must not trim accepted receipt", session.accept(bottom, 2))
      assertEquals(800, session.height)
      assertTrue("Registered paper bottom must not require mosaic growth", session.accept(bottom, 3, true))
      assertEquals(780, session.height)
      assertEquals(3L, session.lastAcceptedAt)
      assertTrue(session.accept(bottom, 4, true))
      val result = session.result(); val expected = image.submat(Rect(0, 0, 600, 780))
      try { assertEquals(0.0, Core.norm(expected, result, Core.NORM_INF), 0.0) }
      finally { result.release(); expected.release() }
    } finally { first.release(); bottom.release(); image.release(); session.close() }
  }

  @Test fun automaticFinishRequiresContinuousAcceptedSteadyBottomFrames() {
    val tracker = ReceiptEndTracker()
    assertFalse(tracker.observe(false, 100))
    assertFalse(tracker.observe(true, 200))
    assertFalse(tracker.observe(true, 600))
    assertFalse(tracker.observe(false, 700))
    assertFalse(tracker.observe(true, 800))
    assertFalse(tracker.observe(true, 1200))
    assertFalse(tracker.observe(true, 1600))
    assertTrue(tracker.observe(true, 1900))
    tracker.reset()
    assertFalse(tracker.observe(true, 2000))
    assertFalse("A dropped frame interval must restart the hold", tracker.observe(true, 4000))
    // A slower phone analyses fewer frames per second; the hold must still be
    // confirmable there, and never by elapsed time on two frames alone.
    val slow = ReceiptEndTracker()
    assertFalse(slow.observe(true, 0))
    assertFalse("Two slow frames are not a confirmed hold", slow.observe(true, 1200))
    assertFalse(slow.observe(true, 2300))
    assertTrue("A slower analyser must still finish a steady bottom hold", slow.observe(true, 3400))
  }

  @Test fun partialBottomDetectionMustNotDeleteAcceptedReceiptRows() {
    val image = paper(); val session = LongReceiptSession()
    val first = image.submat(Rect(0, 0, 600, 800))
    val fragment = image.submat(Rect(0, 180, 600, 300))
    try {
      assertTrue(session.accept(first, 1))
      assertNotNull("The fragment must register, or this guard is untested", ReceiptVision.downwardOffset(first, fragment))
      assertFalse("A short paper detection must not trim 320 accepted rows", session.accept(fragment, 2, true))
      assertEquals(800, session.height)
      val result = session.result(); val expected = image.submat(Rect(0, 0, 600, 800))
      try { assertEquals(0.0, Core.norm(expected, result, Core.NORM_INF), 0.0) }
      finally { result.release(); expected.release() }
    } finally { first.release(); fragment.release(); image.release(); session.close() }
  }

  @Test fun enhancementKeepsFaintPrintAndDoesNotMutateOriginal() {
    val image = Mat(500, 400, CvType.CV_8UC3, Scalar.all(220.0))
    Imgproc.rectangle(image, Point(100.0, 240.0), Point(300.0, 250.0), Scalar.all(185.0), -1)
    val copy = image.clone(); val enhanced = ReceiptVision.enhance(image)
    try {
      assertEquals(0.0, Core.norm(image, copy, Core.NORM_INF), 0.0)
      val paperValue = enhanced.get(150, 200)[0]; val faintValue = enhanced.get(245, 200)[0]
      assertTrue("Faint ink remains measurably darker than paper", paperValue - faintValue > 20)
      assertTrue("Do not hard-threshold faint text", faintValue > 100)
      assertEquals(image.size(), enhanced.size())
    } finally { image.release(); copy.release(); enhanced.release() }
  }

  @Test fun firstFrameLengthLimitLeavesSessionEmpty() {
    val image = Mat(16001, 32, CvType.CV_8UC3, Scalar.all(245.0)); val session = LongReceiptSession()
    try {
      try { session.accept(image, 1); fail("Oversized first frame must fail") }
      catch (_: IllegalArgumentException) { assertEquals(0, session.height); assertEquals(0L, session.lastAcceptedAt) }
    } finally { session.close(); image.release() }
  }

  @Test fun tiledEnhancementHasNoBoundaryArtifacts() {
    val image = paper(); val tiled = ReceiptVision.enhance(image); val whole = ReceiptVision.enhanceTile(image)
    try {
      assertEquals("Halo tiles must match full-image correction including seams", 0.0, Core.norm(tiled, whole, Core.NORM_INF), 0.0)
    } finally { image.release(); tiled.release(); whole.release() }
  }

  @Test fun excessiveLateralDriftNeverChangesMosaic() {
    val image = paper(); val top = image.submat(Rect(0, 0, 600, 800)); val next = image.submat(Rect(0, 180, 600, 800)); val shifted = Mat()
    val transform = Mat(2, 3, CvType.CV_64F)
    try {
      transform.put(0, 0, 1.0, 0.0, 75.0, 0.0, 1.0, 0.0)
      Imgproc.warpAffine(next, shifted, transform, next.size(), Imgproc.INTER_LINEAR, Core.BORDER_REPLICATE)
      assertNull(ReceiptVision.downwardOffset(top, shifted))
    } finally { image.release(); top.release(); next.release(); shifted.release(); transform.release() }
  }

  @Test fun modestHandheldRotationScaleAndSidewaysDriftAreStabilizedBeforeStitching() {
    val image = paper(); val previous = image.submat(Rect(0, 0, 600, 800)); val source = image.submat(Rect(0, 180, 600, 800)); val moved = Mat()
    val transform = Imgproc.getRotationMatrix2D(Point(300.0, 400.0), 1.4, 1.018)
    try {
      transform.put(0, 2, transform.get(0, 2)[0] + 10.0)
      Imgproc.warpAffine(source, moved, transform, source.size(), Imgproc.INTER_LINEAR, Core.BORDER_REPLICATE)
      val registered = ReceiptVision.registerDownward(previous, moved)
      assertNotNull("Normal handheld variation should retain verified overlap", registered)
      registered!!.use {
        assertEquals(180.0, it.offset.toDouble(), 12.0)
        assertTrue(it.inlierRatio >= .55)
        assertTrue(it.meanDifference <= 40.0)
      }
    } finally { image.release(); previous.release(); source.release(); moved.release(); transform.release() }
  }

  @Test fun mosaicThumbnailIsBoundedIndependentAndClearedWithSession() {
    val session = LongReceiptSession()
    val frame = Mat(16000, 600, CvType.CV_8UC3, Scalar.all(240.0))
    val oldRows = frame.submat(Rect(0, 0, 600, 13600))
    try {
      oldRows.setTo(Scalar.all(20.0))
      assertNull(session.thumbnail())
      assertTrue(session.accept(frame, 1))
      val preview = session.thumbnail()!!
      try {
        assertEquals(240, preview.cols()); assertEquals(960, preview.rows())
        assertEquals("The rolling preview keeps the newest accepted rows readable", 240.0, Core.mean(preview).`val`[0], 0.0)
        preview.setTo(Scalar.all(0.0))
        val original = session.result()
        try { assertEquals("Mutating preview pixels must not alter the accepted mosaic", 0.0, Core.norm(frame, original, Core.NORM_INF), 0.0) }
        finally { original.release() }
      } finally { preview.release() }
      session.close(); assertNull(session.thumbnail())
    } finally { oldRows.release(); frame.release(); session.close() }
  }

  @Test fun growingThumbnailUsesAcceptedPixelsAndRejectedMotionDoesNotChangeIt() {
    val source = paper(); val session = LongReceiptSession()
    val first = source.submat(Rect(0, 0, 600, 800)); val second = source.submat(Rect(0, 180, 600, 800))
    try {
      assertTrue(session.accept(first, 1))
      val initial = session.thumbnail()!!
      try { assertEquals(240, initial.cols()); assertEquals(320, initial.rows()) }
      finally { initial.release() }
      assertTrue(session.accept(second, 2))
      val grown = session.thumbnail()!!
      try {
        assertTrue(grown.rows() > 256)
        assertFalse(session.accept(first, 3))
        val retained = session.thumbnail()!!
        try { assertEquals(0.0, Core.norm(grown, retained, Core.NORM_INF), 0.0) }
        finally { retained.release() }
      } finally { grown.release() }
    } finally { first.release(); second.release(); source.release(); session.close() }
  }

  @Test fun detectionHighlightIsPreviewOnlyAndThumbnailIsReleased() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    instrumentation.runOnMainSync {
      val overlay = ReceiptScannerOverlay(instrumentation.targetContext)
      overlay.layout(0, 0, 400, 800)
      overlay.frameAspect = .5f
      overlay.updateDetection(listOf(.1f to .1f, .9f to .1f, .9f to .9f, .1f to .9f), 1000)
      val output = Bitmap.createBitmap(400, 800, Bitmap.Config.ARGB_8888)
      val receipt = Mat(100, 50, CvType.CV_8UC3, Scalar.all(240.0))
      val thumbnail = Bitmap.createBitmap(50, 100, Bitmap.Config.ARGB_8888)
      try {
        Utils.matToBitmap(receipt, thumbnail)
        overlay.setMosaic(thumbnail)
        overlay.draw(Canvas(output))
        val tinted = output.getPixel(200, 400)
        assertTrue("Detected interior receives a translucent highlight", Color.alpha(tinted) in 1..254)
        assertTrue(Color.green(tinted) > Color.red(tinted))
        assertTrue("The stitched preview is visible in the right-side rail", Color.alpha(output.getPixel(350, 50)) > 0)
        assertEquals("The preview no longer covers the top-left camera area", 0, Color.alpha(output.getPixel(15, 15)))
        assertEquals("Outside detection remains untouched", 0, Color.alpha(output.getPixel(395, 790)))
        assertEquals("Overlay must never mutate receipt pixels", 240.0, Core.mean(receipt).`val`[0], 0.0)
        overlay.updateDetection(emptyList(), 1500)
        output.eraseColor(Color.TRANSPARENT); overlay.draw(Canvas(output))
        assertTrue("One missed frame retains the last reliable boundary", Color.alpha(output.getPixel(200, 400)) > 0)
        overlay.updateDetection(emptyList(), 1701)
        output.eraseColor(Color.TRANSPARENT); overlay.draw(Canvas(output))
        assertEquals("A genuinely lost receipt clears the stale boundary", 0, Color.alpha(output.getPixel(200, 400)))
        overlay.clear()
        assertTrue("Reset releases the retained thumbnail", thumbnail.isRecycled)
        output.eraseColor(Color.TRANSPARENT); overlay.draw(Canvas(output))
        assertEquals(0, Color.alpha(output.getPixel(200, 400)))
      } finally { overlay.clear(); output.recycle(); receipt.release(); if (!thumbnail.isRecycled) thumbnail.recycle() }
    }
  }

  @Test fun rendersSyntheticLongReceiptOverlayEvidence() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val source = paper(); val session = LongReceiptSession()
    val frame = source.submat(Rect(0, 0, 600, 800))
    try {
      for (offset in listOf(0, 180, 360, 540)) {
        val accepted = source.submat(Rect(0, offset, 600, 800))
        try { assertTrue(session.accept(accepted, offset + 1L)) } finally { accepted.release() }
      }
      val mosaic = session.thumbnail()!!
      try {
        instrumentation.runOnMainSync {
          val overlay = ReceiptScannerOverlay(instrumentation.targetContext)
          val image = Bitmap.createBitmap(600, 1000, Bitmap.Config.ARGB_8888)
          val scene = Bitmap.createBitmap(600, 800, Bitmap.Config.ARGB_8888)
          val thumb = Bitmap.createBitmap(mosaic.cols(), mosaic.rows(), Bitmap.Config.ARGB_8888)
          try {
            Utils.matToBitmap(frame, scene); Utils.matToBitmap(mosaic, thumb)
            overlay.layout(0, 0, 600, 1000); overlay.frameAspect = .6f
            overlay.updateDetection(listOf(.2f to .08f, .8f to .08f, .8f to .92f, .2f to .92f))
            overlay.setMosaic(thumb)
            val canvas = Canvas(image); canvas.drawColor(Color.rgb(26, 32, 34))
            canvas.drawBitmap(scene, null, RectF(120f, 80f, 480f, 920f), Paint(Paint.FILTER_BITMAP_FLAG))
            overlay.draw(canvas)
            val label = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = 20f }
            canvas.drawText("SYNTHETIC NATIVE OVERLAY TEST", 20f, 980f, label)
            File(instrumentation.targetContext.filesDir, "receipt-overlay-synthetic.png").outputStream().use { assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, it)) }
          } finally { overlay.clear(); image.recycle(); scene.recycle(); if (!thumb.isRecycled) thumb.recycle() }
        }
      } finally { mosaic.release() }
    } finally { session.close(); frame.release(); source.release() }
  }
}
