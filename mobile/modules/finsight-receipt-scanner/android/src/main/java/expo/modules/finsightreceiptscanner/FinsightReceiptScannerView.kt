package expo.modules.finsightreceiptscanner

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.view.View
import android.os.SystemClock
import android.util.Size
import androidx.camera.core.*
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
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.*

class FinsightReceiptScannerView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true
  private val onStatus by EventDispatcher()
  private val onCapture by EventDispatcher()
  private val onError by EventDispatcher()
  private val preview = PreviewView(context).apply { scaleType = PreviewView.ScaleType.FIT_CENTER; implementationMode = PreviewView.ImplementationMode.COMPATIBLE }
  private val outline = ReceiptScannerOverlay(context)
  private val previewPending = AtomicBoolean(false)
  private var worker = Executors.newSingleThreadExecutor()
  private val generation = AtomicInteger(0)
  private var provider: ProcessCameraProvider? = null
  private var analysis: ImageAnalysis? = null
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
  override fun onAttachedToWindow() { super.onAttachedToWindow(); if (worker.isShutdown) worker = Executors.newSingleThreadExecutor(); if (active) bind() }
  override fun onDetachedFromWindow() { stop(); worker.shutdown(); super.onDetachedFromWindow() }

  private fun reset() { generation.incrementAndGet(); outline.clear(); if (!worker.isShutdown) worker.execute { clear() } }
  private fun clear() { completed = false; scanning = false; manualCapture = false; stableSince = 0; lastCorners = null; lastFrameAt = 0; startedAt = 0; session.close(); endTracker.reset(); longWidth = 0; lastBottomVisible = false; previewHeight = 0 }
  private fun stop() {
    generation.incrementAndGet()
    outline.clear()
    analysis?.clearAnalyzer()
    val cases = listOfNotNull(cameraPreview, analysis).toTypedArray()
    if (cases.isNotEmpty()) provider?.unbind(*cases)
    camera = null; analysis = null; cameraPreview = null
    lifecycleOwner?.lifecycle?.removeObserver(lifecycleObserver); lifecycleOwner = null
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
        "capture" -> if (currentMode == "standard" && !completed) { manualCapture = true; status(token, "detected", "Checking receipt edges and focus…") }
        "start" -> { clear(); post { if (token == generation.get()) outline.clear() }; scanning = true; startedAt = SystemClock.elapsedRealtime(); status(token, "scanning", "Show the top edge, then move slowly downward") }
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
    try { save(result, "long", token); scanning = false; completed = true; session.close(); endTracker.reset() }
    catch (e: Exception) { error(token, e.message ?: "Could not save this receipt") }
    finally { result.release() }
  }

  private fun bind() {
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) { error(generation.get(), "Camera permission is required"); return }
    if (!OpenCVLoader.initLocal()) { error(generation.get(), "Receipt image processing could not start"); return }
    val token = generation.get()
    val future = ProcessCameraProvider.getInstance(context)
    future.addListener({
      if (!active || !isAttachedToWindow || analysis != null) return@addListener
      try {
        val owner = appContext.currentActivity as? LifecycleOwner ?: error("Camera activity unavailable")
        lifecycleOwner?.lifecycle?.removeObserver(lifecycleObserver)
        lifecycleOwner = owner; owner.lifecycle.addObserver(lifecycleObserver)
        provider = future.get()
        val p = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
        val a = ImageAnalysis.Builder().setTargetResolution(Size(1280, 960)).setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888).build()
        cameraPreview = p; analysis = a
        a.setAnalyzer(worker) { image -> analyze(image) }
        camera = provider!!.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, p, a)
        camera?.cameraControl?.enableTorch(torch)
        status(token, "ready", "Place the receipt on a contrasting surface")
      } catch (e: Exception) { error(token, "Camera unavailable. Close and reopen the scanner.") }
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
      if (paper == null) { stableSince = 0; lastCorners = null; lastBottomVisible = false; endTracker.reset(); val requested = manualCapture; manualCapture = false; status(token, "searching", if (requested) "Cannot capture yet: show all four receipt edges on a contrasting surface, then tap again" else if (currentMode == "standard") "Show all four receipt edges on a contrasting surface" else "Keep both receipt sides visible against a darker surface"); return }
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
          receipt = ReceiptVision.warp(rgb, paper.corners)
          save(receipt, "standard", token); completed = true; manualCapture = false
        }
      } else if (scanning) {
        if (now - startedAt > 90000) { scanning = false; session.close(); previewHeight = 0; post { if (token == generation.get()) outline.clear() }; error(token, "Scan timed out. Start again and move steadily from top to bottom."); return }
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
    finally { receipt?.release(); rgb?.release(); image.close() }
  }

  private fun imageRgb(image: ImageProxy): Mat {
    val plane = image.planes[0]; val bytes = ByteArray(plane.rowStride * image.height)
    val buffer = plane.buffer.duplicate(); val available = min(bytes.size, buffer.remaining()); buffer.get(bytes, 0, available)
    val rgba = Mat(image.height, plane.rowStride / 4, CvType.CV_8UC4); val cropped: Mat; val rgb = Mat()
    rgba.put(0, 0, bytes); cropped = rgba.submat(Rect(0, 0, image.width, image.height))
    try {
      Imgproc.cvtColor(cropped, rgb, Imgproc.COLOR_RGBA2RGB)
      when (image.imageInfo.rotationDegrees) { 90 -> Core.rotate(rgb, rgb, Core.ROTATE_90_CLOCKWISE); 180 -> Core.rotate(rgb, rgb, Core.ROTATE_180); 270 -> Core.rotate(rgb, rgb, Core.ROTATE_90_COUNTERCLOCKWISE) }
      if (max(rgb.cols(), rgb.rows()) > 1600) Imgproc.resize(rgb, rgb, org.opencv.core.Size(rgb.cols() * 1600.0 / max(rgb.cols(), rgb.rows()), rgb.rows() * 1600.0 / max(rgb.cols(), rgb.rows())))
      return rgb
    } catch (e: Exception) { rgb.release(); throw e }
    finally { cropped.release(); rgba.release() }
  }

  private fun save(original: Mat, captureMode: String, token: Int) {
    if (token != generation.get()) return
    status(token, "processing", "Preparing your receipt on this device")
    val enhanced = ReceiptVision.enhance(original)
    val dir = File(context.cacheDir, "receipt-scanner").apply { mkdirs() }
    // Only this module's disposable cache, never user/gallery originals.
    dir.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 86_400_000 }?.forEach { it.delete() }
    val id = java.util.UUID.randomUUID().toString()
    val raw = File(dir, "$id-original.jpg"); val processed = File(dir, "$id-scan.jpg")
    val resultWidth = original.cols(); val resultHeight = original.rows()
    try {
      writeJpeg(original, raw); writeJpeg(enhanced, processed)
      if (token != generation.get()) { raw.delete(); processed.delete(); return }
      post {
        if (token == generation.get() && active) onCapture(mapOf("originalUri" to "file://${raw.absolutePath}", "processedUri" to "file://${processed.absolutePath}", "width" to resultWidth, "height" to resultHeight, "originalWidth" to resultWidth, "originalHeight" to resultHeight, "mode" to captureMode, "transformVersion" to if (captureMode == "long") "custom-panorama-v1" else "custom-frame-v1"))
        else { raw.delete(); processed.delete() }
      }
    } catch (e: Exception) { raw.delete(); processed.delete(); throw e }
    finally { enhanced.release() }
  }
  private fun writeJpeg(mat: Mat, file: File) {
    val bitmap = Bitmap.createBitmap(mat.cols(), mat.rows(), Bitmap.Config.ARGB_8888)
    try { Utils.matToBitmap(mat, bitmap); file.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.JPEG, 92, it)) }; check(file.length() <= 10_000_000) { "Receipt image is too large. Try a shorter scan." } }
    finally { bitmap.recycle() }
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
