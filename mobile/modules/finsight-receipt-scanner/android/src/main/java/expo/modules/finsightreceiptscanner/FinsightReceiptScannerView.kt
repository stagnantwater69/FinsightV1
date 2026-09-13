package expo.modules.finsightreceiptscanner

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.ExifInterface
import android.view.View
import android.os.SystemClock
import android.util.Size
import androidx.camera.core.*
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import org.opencv.android.OpenCVLoader
import org.opencv.android.Utils
import org.opencv.core.*
import org.opencv.imgproc.Imgproc
import org.opencv.imgcodecs.Imgcodecs
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.*

internal class CaptureResultGate {
  private val settled = AtomicBoolean(false)
  fun claim(): Boolean = settled.compareAndSet(false, true)
}

class FinsightReceiptScannerView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true
  private val onStatus by EventDispatcher()
  private val onCapture by EventDispatcher()
  private val onError by EventDispatcher()
  private val preview = PreviewView(context).apply { scaleType = PreviewView.ScaleType.FIT_CENTER; implementationMode = PreviewView.ImplementationMode.COMPATIBLE }
  private val outline = ReceiptScannerOverlay(context)
  private val previewPending = AtomicBoolean(false)
  private var worker: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
  private val generation = AtomicInteger(0)
  private var provider: ProcessCameraProvider? = null
  private var analysis: ImageAnalysis? = null
  private var imageCapture: ImageCapture? = null
  private var cameraPreview: Preview? = null
  private var camera: Camera? = null
  private var lifecycleOwner: LifecycleOwner? = null
  private val lifecycleObserver = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) reset() }
  @Volatile private var active = false
  private var torch = false
  @Volatile private var mode = "standard"
  private var lastCommand = -1
  // The following state belongs only to worker.
  private var completed = false
  private var scanning = false
  private var manualCapture = false
  private var stableSince = 0L
  private var lastCorners: Array<Point>? = null
  private var lastFrameAt = 0L
  private var lastFrameCompletedAt = 0L
  private var startedAt = 0L
  private var longWidth = 0
  private var lastBottomVisible = false
  private var previewHeight = 0
  private val session = LongReceiptSession()
  private val endTracker = ReceiptEndTracker()

  init { addView(preview, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)); addView(outline, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)) }
  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    measureChild(preview, widthMeasureSpec, heightMeasureSpec)
    measureChild(outline, widthMeasureSpec, heightMeasureSpec)
    setMeasuredDimension(View.resolveSize(preview.measuredWidth, widthMeasureSpec), View.resolveSize(preview.measuredHeight, heightMeasureSpec))
  }
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) { preview.layout(0, 0, right - left, bottom - top); outline.layout(0, 0, right - left, bottom - top) }
  fun setActive(value: Boolean) { if (active == value) return; active = value; if (value && isAttachedToWindow) bind() else stop() }
  fun setMode(value: String) { val next = if (value == "long") "long" else "standard"; if (mode != next) { mode = next; reset() } }
  fun setTorch(value: Boolean) { torch = value; camera?.cameraControl?.enableTorch(value) }
  override fun onAttachedToWindow() { super.onAttachedToWindow(); if (worker.isShutdown) worker = Executors.newSingleThreadScheduledExecutor(); if (active) bind() }
  override fun onDetachedFromWindow() { stop(); worker.shutdown(); super.onDetachedFromWindow() }

  private fun reset() { generation.incrementAndGet(); outline.clear(); if (!worker.isShutdown) worker.execute { clear() } }
  private fun clear() { completed = false; scanning = false; manualCapture = false; stableSince = 0; lastCorners = null; lastFrameAt = 0; lastFrameCompletedAt = 0; startedAt = 0; session.close(); endTracker.reset(); longWidth = 0; lastBottomVisible = false; previewHeight = 0 }
  private fun releaseCameraBindings() {
    analysis?.clearAnalyzer()
    val cases = listOfNotNull(cameraPreview, analysis, imageCapture).toTypedArray()
    if (cases.isNotEmpty()) provider?.unbind(*cases)
    camera = null; analysis = null; imageCapture = null; cameraPreview = null
    lifecycleOwner?.lifecycle?.removeObserver(lifecycleObserver); lifecycleOwner = null
  }
  private fun stop() {
    generation.incrementAndGet()
    outline.clear()
    releaseCameraBindings()
    if (!worker.isShutdown) worker.execute { clear() }
  }

  fun command(command: ScannerCommand) {
    if (command.id <= lastCommand) return
    lastCommand = command.id
    if (command.type == "reset") { reset(); return }
    if (worker.isShutdown) return
    val token = generation.get(); val currentMode = mode
    worker.execute {
      if (token != generation.get() || !active) return@execute
      when (command.type) {
        "capture" -> if (currentMode == "standard" && !completed) {
          manualCapture = true
          status(token, "detected", "Checking receipt edges and focus…")
          worker.schedule({
            if (token == generation.get() && active && mode == "standard" && manualCapture && !completed) {
              manualCapture = false
              status(token, "ready", "The camera paused before it could check the receipt. Hold it steady and tap Scan again.")
            }
          }, 2500, TimeUnit.MILLISECONDS)
        }
        "start" -> {
          clear()
          post { if (token == generation.get()) outline.clear() }
          scanning = true
          startedAt = SystemClock.elapsedRealtime()
          lastFrameCompletedAt = startedAt
          scheduleLongWatchdog(token, startedAt)
          status(token, "scanning", "Show the top edge, then move slowly downward")
        }
        "finish" -> if (scanning) {
          // At the safe length limit no further frame can be accepted, so the
          // recency/bottom-edge gate would make the scan unfinishable. The
          // owner has already been told that result stops at the limit.
          val ready = session.height > 0 && (session.limitReached ||
            (SystemClock.elapsedRealtime() - session.lastAcceptedAt <= 1800 && lastBottomVisible))
          if (ready) finishLong(token) else status(token, "tracking", "Show the bottom edge and hold still before finishing")
        }
      }
    }
  }

  private fun finishLong(token: Int) {
    val result = session.result()
    try { save(result, result, "long", token); scanning = false; completed = true; session.close(); endTracker.reset() }
    catch (e: Exception) { error(token, e.message ?: "Could not save this receipt") }
    finally { result.release() }
  }

  private fun scheduleLongWatchdog(token: Int, sessionStartedAt: Long) {
    worker.schedule({
      if (token != generation.get() || !active || mode != "long" || !scanning || startedAt != sessionStartedAt) return@schedule
      val now = SystemClock.elapsedRealtime()
      when {
        now - sessionStartedAt >= 90_000 -> failLongScan(token, "Scan timed out. Start again and move steadily from top to bottom.")
        now - lastFrameCompletedAt >= 6_000 -> failLongScan(token, "The camera preview stopped updating. Start the long scan again or use manual pages.")
        else -> scheduleLongWatchdog(token, sessionStartedAt)
      }
    }, 2, TimeUnit.SECONDS)
  }

  private fun failLongScan(token: Int, message: String) {
    scanning = false
    session.close()
    endTracker.reset()
    longWidth = 0
    lastBottomVisible = false
    previewHeight = 0
    post { if (token == generation.get()) outline.clear() }
    error(token, message)
  }

  private fun bind() {
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) { error(generation.get(), "Camera permission is required"); return }
    if (!OpenCVLoader.initLocal()) { error(generation.get(), "Receipt image processing could not start"); return }
    val token = generation.get()
    val future = ProcessCameraProvider.getInstance(context)
    future.addListener({
      if (token != generation.get() || !active || !isAttachedToWindow || analysis != null) return@addListener
      try {
        val viewPort = preview.viewPort
        if (viewPort == null) {
          preview.post { if (token == generation.get() && active && analysis == null) bind() }
          return@addListener
        }
        val owner = appContext.currentActivity as? LifecycleOwner ?: error("Camera activity unavailable")
        lifecycleOwner?.lifecycle?.removeObserver(lifecycleObserver)
        lifecycleOwner = owner; owner.lifecycle.addObserver(lifecycleObserver)
        provider = future.get()
        val p = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
        val analysisResolution = ResolutionSelector.Builder()
          .setResolutionStrategy(
            ResolutionStrategy(
              Size(1280, 960),
              ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
            ),
          )
          .build()
        val stillResolution = ResolutionSelector.Builder()
          .setResolutionStrategy(
            ResolutionStrategy(
              Size(4032, 3024),
              ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
            ),
          )
          .build()
        val a = ImageAnalysis.Builder()
          .setResolutionSelector(analysisResolution)
          .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
          .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
          .build()
        val c = ImageCapture.Builder()
          .setResolutionSelector(stillResolution)
          .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
          .setJpegQuality(90)
          .build()
        cameraPreview = p; analysis = a; imageCapture = c
        a.setAnalyzer(worker) { image -> analyze(image) }
        val useCases = UseCaseGroup.Builder()
          .addUseCase(p)
          .addUseCase(a)
          .addUseCase(c)
          .setViewPort(viewPort)
          .build()
        camera = provider!!.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, useCases)
        camera?.cameraControl?.enableTorch(torch)
        status(token, "ready", "Place the receipt on a contrasting surface")
      } catch (e: Exception) {
        // A failed bind must not leave a non-null analyser that makes every
        // later retry return before binding. Clear all three use cases so the
        // same mounted scanner can recover after camera contention ends.
        releaseCameraBindings()
        error(token, "Camera unavailable. Close and reopen the scanner.")
      }
    }, ContextCompat.getMainExecutor(context))
  }

  private fun analyze(image: ImageProxy) {
    val token = generation.get(); val now = SystemClock.elapsedRealtime(); val currentMode = mode
    var rgb: Mat? = null; var receipt: Mat? = null
    try {
      if (!active || completed || now - lastFrameAt < 180) return
      lastFrameAt = now
      rgb = imageRgb(image)
      val aspect = rgb.cols().toFloat() / rgb.rows()
      post { if (token == generation.get()) outline.frameAspect = aspect }
      val paper = ReceiptVision.detect(rgb, currentMode == "long")
      if (paper == null) { stableSince = 0; lastCorners = null; lastBottomVisible = false; endTracker.reset(); val requested = manualCapture; manualCapture = false; status(token, "searching", if (requested) "Cannot capture yet: move closer and keep all four edges visible on a contrasting surface, then tap again" else if (currentMode == "standard") "Move closer and keep all four edges visible on a contrasting surface" else "Keep both receipt sides visible against a darker surface"); return }
      val corners = paper.corners.map { mapOf("x" to it.x / rgb.cols(), "y" to it.y / rgb.rows()) }
      if (paper.sharpness < 32 || paper.brightness < 75) { stableSince = 0; lastCorners = null; lastBottomVisible = false; endTracker.reset(); manualCapture = false; status(token, "quality", if (paper.brightness < 75) "Add light or turn on the flash" else "Hold still while the text comes into focus", corners); return }
      if (currentMode == "standard") {
        val previous = lastCorners
        val moving = previous == null || paper.corners.indices.any { ReceiptVision.distance(paper.corners[it], previous[it]) > rgb.cols() * .012 }
        if (moving) stableSince = now
        lastCorners = paper.corners
        val progress = ((now - stableSince) / 1100.0).coerceIn(0.0, 1.0)
        status(token, "detected", "Receipt detected · hold steady", corners, progress)
        if (manualCapture || progress >= 1) {
          manualCapture = false
          completed = true
          captureStandard(paper.corners, rgb.cols(), rgb.rows(), token)
        }
      } else if (scanning) {
        if (now - startedAt > 90000) { failLongScan(token, "Scan timed out. Start again and move steadily from top to bottom."); return }
        val topVisible = paper.corners[0].y > 8 && paper.corners[1].y > 8
        if (session.height == 0 && !topVisible) { endTracker.reset(); lastBottomVisible = false; status(token, "tracking", "Move back until the top edge is visible", corners); return }
        val naturalWidth = max(ReceiptVision.distance(paper.corners[0], paper.corners[1]), ReceiptVision.distance(paper.corners[3], paper.corners[2]))
        // A handheld sweep changes the measured paper width by a few pixels every
        // frame. Normalise to the first accepted width so registration stays
        // scale-consistent, and reject only a real change of distance.
        if (longWidth != 0 && naturalWidth < longWidth * .75) { endTracker.reset(); lastBottomVisible = false; lastCorners = paper.corners; status(token, "tracking", "Move closer and keep the phone at the same distance", corners); return }
        val frame = if (longWidth == 0) ReceiptVision.warp(rgb, paper.corners, 1000) else ReceiptVision.warp(rgb, paper.corners, longWidth, exact = true)
        receipt = frame
        if (longWidth == 0) longWidth = frame.cols()
        val bottomVisible = paper.corners[2].y < rgb.rows() - 9 && paper.corners[3].y < rgb.rows() - 9
        if (session.accept(frame, now, bottomVisible)) {
          publishMosaic(token)
          lastBottomVisible = bottomVisible
          status(token, "scanning", if (lastBottomVisible) "Bottom edge visible · hold still to finish automatically" else "Move slowly downward · keep both sides visible", corners)
          val previous = lastCorners
          val steady = previous != null && paper.corners.indices.all { ReceiptVision.distance(paper.corners[it], previous[it]) <= rgb.cols() * .012 }
          lastCorners = paper.corners
          if (endTracker.observe(bottomVisible && steady, now)) finishLong(token)
        } else if (session.limitReached) {
          // Nothing was registered, so the bottom edge remains unconfirmed; the
          // finish gate allows this case explicitly instead.
          lastCorners = paper.corners; lastBottomVisible = false; endTracker.reset()
          status(token, "limit", "Maximum safe scan length reached · tap Finish scan. Anything below this point is not included.", corners)
        } else {
          // Keep the reference corners current so the next accepted frame is
          // compared with what the camera last actually saw.
          lastCorners = paper.corners; lastBottomVisible = false; endTracker.reset()
          status(token, "tracking", "Overlap lost · move back slowly to the last area", corners)
        }
      } else status(token, "ready", "Start at the top edge of the receipt", corners)
    } catch (e: Exception) { endTracker.reset(); lastBottomVisible = false; manualCapture = false; error(token, e.message ?: "Could not process this frame") }
    finally {
      if (token == generation.get() && active) lastFrameCompletedAt = SystemClock.elapsedRealtime()
      receipt?.release(); rgb?.release(); image.close()
    }
  }

  private fun imageRgb(image: ImageProxy): Mat {
    val plane = image.planes[0]; val bytes = ByteArray(plane.rowStride * image.height)
    val buffer = plane.buffer.duplicate(); val available = min(bytes.size, buffer.remaining()); buffer.get(bytes, 0, available)
    val rgba = Mat(image.height, plane.rowStride / 4, CvType.CV_8UC4); val cropped: Mat; val rgb = Mat()
    val crop = image.cropRect
    rgba.put(0, 0, bytes); cropped = rgba.submat(Rect(crop.left, crop.top, crop.width(), crop.height()))
    try {
      Imgproc.cvtColor(cropped, rgb, Imgproc.COLOR_RGBA2RGB)
      when (image.imageInfo.rotationDegrees) { 90 -> Core.rotate(rgb, rgb, Core.ROTATE_90_CLOCKWISE); 180 -> Core.rotate(rgb, rgb, Core.ROTATE_180); 270 -> Core.rotate(rgb, rgb, Core.ROTATE_90_COUNTERCLOCKWISE) }
      if (max(rgb.cols(), rgb.rows()) > 1600) Imgproc.resize(rgb, rgb, org.opencv.core.Size(rgb.cols() * 1600.0 / max(rgb.cols(), rgb.rows()), rgb.rows() * 1600.0 / max(rgb.cols(), rgb.rows())))
      return rgb
    } catch (e: Exception) { rgb.release(); throw e }
    finally { cropped.release(); rgba.release() }
  }

  private fun captureStandard(corners: Array<Point>, analysisWidth: Int, analysisHeight: Int, token: Int) {
    val capture = imageCapture
    if (capture == null) {
      completed = false
      error(token, "The full-resolution camera is not ready. Close and reopen the scanner.")
      return
    }
    status(token, "processing", "Taking a full-resolution receipt photo")
    val dir = receiptDirectory()
    val id = java.util.UUID.randomUUID().toString()
    val raw = File(dir, "$id-original.jpg")
    val resultGate = CaptureResultGate()
    val callbackTimeout = worker.schedule({
      if (!resultGate.claim()) return@schedule
      raw.delete()
      if (token == generation.get() && active) {
        completed = false
        error(token, "The full-resolution photo timed out. Hold still and scan again.")
      }
    }, 8, TimeUnit.SECONDS)
    try {
      val output = ImageCapture.OutputFileOptions.Builder(raw).build()
      capture.takePicture(output, worker, object : ImageCapture.OnImageSavedCallback {
        override fun onImageSaved(result: ImageCapture.OutputFileResults) {
          // The deadline and CameraX callback race for this one gate. A late
          // callback only removes its file; it cannot emit a second result.
          if (!resultGate.claim()) { raw.delete(); return }
          callbackTimeout.cancel(false)
          var sampled: SampledStill? = null
          var rectified: Mat? = null
          try {
            check(raw.exists() && raw.length() > 0) { "The full-resolution camera returned an empty photo" }
            check(raw.length() <= 10_000_000) { "The full-resolution photo is larger than 10 MB. Move closer and scan again." }
            if (token != generation.get() || !active) { raw.delete(); return }
            val captured = readSampledStill(raw)
            sampled = captured
            if (token != generation.get() || !active) { raw.delete(); return }
            val mappedSource = ReceiptVision.mapCornersBetweenFrames(
              corners,
              analysisWidth,
              analysisHeight,
              captured.originalWidth,
              captured.originalHeight,
            )
            val mappedSample = mappedSource.map { point ->
              Point(
                point.x * captured.rgb.cols() / captured.originalWidth,
                point.y * captured.rgb.rows() / captured.originalHeight,
              )
            }.toTypedArray()
            val receiptWidth = max(
              ReceiptVision.distance(mappedSample[0], mappedSample[1]),
              ReceiptVision.distance(mappedSample[3], mappedSample[2]),
            ).roundToInt().coerceIn(1000, 1800)
            // Preserve the untouched full-resolution JPEG as source evidence,
            // but keep the simultaneously decoded/warped/enhanced derivative
            // within a bounded pixel budget on lower-memory phones.
            val corrected = ReceiptVision.warp(captured.rgb, mappedSample, receiptWidth, maxPixels = 4_000_000L)
            rectified = corrected
            saveDerived(raw, corrected, "standard", token, captured.originalWidth, captured.originalHeight, mappedSource)
          } catch (exception: Exception) {
            raw.delete()
            if (token == generation.get()) {
              completed = false
              error(token, exception.message ?: "Could not prepare the full-resolution receipt photo")
            }
          } finally {
            rectified?.release()
            sampled?.rgb?.release()
          }
        }

        override fun onError(exception: ImageCaptureException) {
          if (!resultGate.claim()) { raw.delete(); return }
          callbackTimeout.cancel(false)
          raw.delete()
          if (token == generation.get()) {
            completed = false
            error(token, "The full-resolution photo failed. Hold still and scan again.")
          }
        }
      })
    } catch (exception: Exception) {
      if (resultGate.claim()) {
        callbackTimeout.cancel(false)
        raw.delete()
        completed = false
        error(token, "The full-resolution camera could not take a photo. Close and reopen the scanner.")
      }
    }
  }

  private data class SampledStill(val rgb: Mat, val originalWidth: Int, val originalHeight: Int)

  private fun readSampledStill(file: File): SampledStill {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.absolutePath, bounds)
    check(bounds.outWidth > 0 && bounds.outHeight > 0) { "The full-resolution photo dimensions could not be read" }
    check(bounds.outWidth.toLong() * bounds.outHeight <= 40_000_000L) { "The full-resolution photo is too large for safe processing" }
    val orientation = ExifInterface(file.absolutePath).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    val swapsAxes = orientation == ExifInterface.ORIENTATION_TRANSPOSE ||
      orientation == ExifInterface.ORIENTATION_ROTATE_90 ||
      orientation == ExifInterface.ORIENTATION_TRANSVERSE ||
      orientation == ExifInterface.ORIENTATION_ROTATE_270
    val originalWidth = if (swapsAxes) bounds.outHeight else bounds.outWidth
    val originalHeight = if (swapsAxes) bounds.outWidth else bounds.outHeight
    var reduction = 1
    while ((bounds.outWidth.toLong() / reduction) * (bounds.outHeight / reduction) > 4_000_000L && reduction < 8) reduction *= 2
    val reducedMode = when (reduction) {
      2 -> Imgcodecs.IMREAD_REDUCED_COLOR_2
      4 -> Imgcodecs.IMREAD_REDUCED_COLOR_4
      8 -> Imgcodecs.IMREAD_REDUCED_COLOR_8
      else -> Imgcodecs.IMREAD_COLOR
    }
    val bgr: Mat
    val rgb = Mat()
    try {
      bgr = Imgcodecs.imread(file.absolutePath, reducedMode or Imgcodecs.IMREAD_IGNORE_ORIENTATION)
      check(!bgr.empty()) { "The full-resolution photo could not be decoded" }
      try {
        Imgproc.cvtColor(bgr, rgb, Imgproc.COLOR_BGR2RGB)
      } finally {
        bgr.release()
      }
      when (orientation) {
        ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> Core.flip(rgb, rgb, 1)
        ExifInterface.ORIENTATION_ROTATE_180 -> Core.rotate(rgb, rgb, Core.ROTATE_180)
        ExifInterface.ORIENTATION_FLIP_VERTICAL -> Core.flip(rgb, rgb, 0)
        ExifInterface.ORIENTATION_TRANSPOSE -> Core.transpose(rgb, rgb)
        ExifInterface.ORIENTATION_ROTATE_90 -> Core.rotate(rgb, rgb, Core.ROTATE_90_CLOCKWISE)
        ExifInterface.ORIENTATION_TRANSVERSE -> { Core.transpose(rgb, rgb); Core.flip(rgb, rgb, -1) }
        ExifInterface.ORIENTATION_ROTATE_270 -> Core.rotate(rgb, rgb, Core.ROTATE_90_COUNTERCLOCKWISE)
      }
      check(rgb.cols().toLong() * rgb.rows() <= 4_200_000L) { "The receipt preview is too large for safe processing" }
      return SampledStill(rgb, originalWidth, originalHeight)
    } catch (exception: Exception) {
      rgb.release()
      throw exception
    }
  }

  private fun receiptDirectory(): File = File(context.cacheDir, "receipt-scanner").apply {
    mkdirs()
    listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 86_400_000 }?.forEach { it.delete() }
  }

  private fun save(
    source: Mat,
    processedBase: Mat,
    captureMode: String,
    token: Int,
    corners: Array<Point>? = null,
  ) {
    if (token != generation.get()) return
    status(token, "processing", "Preparing your receipt on this device")
    val dir = receiptDirectory()
    val id = java.util.UUID.randomUUID().toString()
    val raw = File(dir, "$id-original.jpg")
    try {
      writeJpeg(source, raw)
      saveDerived(raw, processedBase, captureMode, token, source.cols(), source.rows(), corners)
    } catch (e: Exception) {
      raw.delete()
      throw e
    }
  }

  private fun saveDerived(
    raw: File,
    processedBase: Mat,
    captureMode: String,
    token: Int,
    originalWidth: Int,
    originalHeight: Int,
    corners: Array<Point>? = null,
  ) {
    if (token != generation.get()) { raw.delete(); return }
    status(token, "processing", "Preparing your receipt on this device")
    val processed = File(raw.parentFile, raw.name.replace("-original.jpg", "-scan.jpg"))
    val resultWidth = processedBase.cols()
    val resultHeight = processedBase.rows()
    var enhanced: Mat? = null
    try {
      val corrected = ReceiptVision.enhance(processedBase)
      enhanced = corrected
      writeJpeg(corrected, processed)
      if (token != generation.get()) { raw.delete(); processed.delete(); return }
      post {
        if (token == generation.get() && active) {
          val result = mutableMapOf<String, Any>(
            "originalUri" to "file://${raw.absolutePath}",
            "processedUri" to "file://${processed.absolutePath}",
            "width" to resultWidth,
            "height" to resultHeight,
            "originalWidth" to originalWidth,
            "originalHeight" to originalHeight,
            "mode" to captureMode,
            "processingMode" to "clear-colour",
            "transformVersion" to if (captureMode == "long") "custom-panorama-v1" else "custom-still-v2",
          )
          if (corners != null) {
            result["corners"] = mapOf(
              "topLeft" to mapOf("x" to corners[0].x, "y" to corners[0].y),
              "topRight" to mapOf("x" to corners[1].x, "y" to corners[1].y),
              "bottomRight" to mapOf("x" to corners[2].x, "y" to corners[2].y),
              "bottomLeft" to mapOf("x" to corners[3].x, "y" to corners[3].y),
            )
          }
          onCapture(result)
        } else { raw.delete(); processed.delete() }
      }
    } catch (e: Exception) { raw.delete(); processed.delete(); throw e }
    finally { enhanced?.release() }
  }
  private fun writeJpeg(mat: Mat, file: File) {
    val bgr = Mat()
    val parameters = MatOfInt(Imgcodecs.IMWRITE_JPEG_QUALITY, 92)
    try {
      Imgproc.cvtColor(mat, bgr, Imgproc.COLOR_RGB2BGR)
      check(Imgcodecs.imwrite(file.absolutePath, bgr, parameters)) { "Receipt image could not be saved" }
      check(file.length() <= 10_000_000) { "Receipt image is too large. Try a shorter scan." }
    } finally {
      bgr.release()
      parameters.release()
    }
  }
  private fun publishMosaic(token: Int) {
    if (session.height == previewHeight || !previewPending.compareAndSet(false, true)) return
    var thumbnail: Mat? = null
    var bitmap: Bitmap? = null
    var posted = false
    try {
      thumbnail = session.thumbnail() ?: return
      bitmap = Bitmap.createBitmap(thumbnail.cols(), thumbnail.rows(), Bitmap.Config.ARGB_8888)
      Utils.matToBitmap(thumbnail, bitmap)
      val rendered = bitmap
      previewHeight = session.height
      // One in-flight preview only: a busy UI cannot accumulate a bitmap queue.
      // Main executor (not View.post): detached views otherwise retain a queued bitmap
      // until a later attach, which might never happen after closing the scanner.
      ContextCompat.getMainExecutor(context).execute {
        try { if (token == generation.get() && active && isAttachedToWindow) outline.setMosaic(rendered) else rendered.recycle() }
        finally { previewPending.set(false) }
      }
      posted = true
      bitmap = null
    } finally {
      thumbnail?.release()
      if (bitmap != null) bitmap.recycle()
      if (!posted) previewPending.set(false)
    }
  }
  private fun status(token: Int, state: String, message: String, corners: List<Map<String, Double>>? = null, progress: Double? = null) {
    val value = mutableMapOf<String, Any>("state" to state, "message" to message)
    if (corners != null) value["corners"] = corners
    if (progress != null) value["progress"] = progress
    if (mode == "long") value["acceptedHeight"] = session.height
    post { if (token == generation.get() && active) {
      outline.points = corners?.map { Pair(it.getValue("x").toFloat(), it.getValue("y").toFloat()) } ?: emptyList()
      outline.invalidate()
      onStatus(value)
    } }
  }
  private fun error(token: Int, message: String) { post { if (token == generation.get()) onError(mapOf("message" to message)) } }
}
