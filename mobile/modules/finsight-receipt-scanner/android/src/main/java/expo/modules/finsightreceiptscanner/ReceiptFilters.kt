package expo.modules.finsightreceiptscanner

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import org.opencv.android.OpenCVLoader
import org.opencv.android.Utils
import org.opencv.core.Mat
import org.opencv.imgproc.Imgproc
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

internal const val RECEIPT_FILTER_TRANSFORM_VERSION = "android-local-filter-v1"

internal enum class ReceiptFilterMode(
  val bridgeValue: String,
  val processingMode: String,
) {
  ENHANCED("enhanced", "clear-colour"),
  GRAYSCALE("grayscale", "grayscale"),
  BLACK_WHITE("black-white", "black-white");

  companion object {
    fun fromBridge(value: String): ReceiptFilterMode = entries.firstOrNull { it.bridgeValue == value }
      ?: throw IllegalArgumentException("Unsupported receipt filter mode")
  }
}

internal data class ReceiptFilterResult(
  val uri: String,
  val width: Int,
  val height: Int,
  val processingMode: String,
) {
  fun asMap(): Map<String, Any> = mapOf(
    "uri" to uri,
    "width" to width,
    "height" to height,
    "processingMode" to processingMode,
    "transformVersion" to RECEIPT_FILTER_TRANSFORM_VERSION,
  )
}

internal fun validateReceiptFilterDimensions(width: Int, height: Int) {
  require(width in 1..40_000 && height in 1..40_000) { "The receipt image has invalid dimensions" }
  require(width.toLong() * height <= 40_000_000L) { "The receipt image is too large for safe processing" }
}

internal class ReceiptFilterProcessor(
  cacheRoot: File,
  allowedSourceRoots: List<File>,
  private val jpegWriter: (Bitmap, File) -> Unit = ::writeReceiptFilterJpeg,
) {
  private data class ImageInfo(
    val width: Int,
    val height: Int,
    val orientation: Int,
  )

  private val cacheRoot = cacheRoot.canonicalFile
  private val allowedSourceRoots = allowedSourceRoots.map { it.canonicalFile }.distinctBy { it.path }

  fun apply(sourceUri: String, modeValue: String): ReceiptFilterResult {
    val source = localSourceFile(sourceUri)
    val info = readImageInfo(source)
    if (modeValue == "original") {
      val swapsAxes = info.orientation in setOf(
        ExifInterface.ORIENTATION_TRANSPOSE,
        ExifInterface.ORIENTATION_ROTATE_90,
        ExifInterface.ORIENTATION_TRANSVERSE,
        ExifInterface.ORIENTATION_ROTATE_270,
      )
      return ReceiptFilterResult(
        uri = sourceUri,
        width = if (swapsAxes) info.height else info.width,
        height = if (swapsAxes) info.width else info.height,
        processingMode = "original",
      )
    }

    val mode = ReceiptFilterMode.fromBridge(modeValue)
    val outputDirectory = receiptCacheDirectory()
    val id = UUID.randomUUID().toString()
    val temporary = File(outputDirectory, "$id-filter-${mode.bridgeValue}.tmp")
    val output = File(outputDirectory, "$id-filter-${mode.bridgeValue}.jpg")
    var committed = false
    try {
      val sourceBitmap = decodeBoundedBitmap(source, info)
      val filtered = try {
        applyFilter(sourceBitmap, mode)
      } finally {
        sourceBitmap.recycle()
      }
      try {
        jpegWriter(filtered, temporary)
      } finally {
        filtered.recycle()
      }
      check(temporary.renameTo(output)) { "The filtered receipt could not be saved" }
      val outputInfo = readImageInfo(output)
      val result = ReceiptFilterResult(
        uri = Uri.fromFile(output).toString(),
        width = outputInfo.width,
        height = outputInfo.height,
        processingMode = mode.processingMode,
      )
      committed = true
      return result
    } finally {
      temporary.delete()
      if (!committed) output.delete()
    }
  }

  private fun localSourceFile(sourceUri: String): File {
    require(sourceUri.length in 1..4096 && sourceUri.none { it == '\r' || it == '\n' || it == '\u0000' }) {
      "The receipt image URI is invalid"
    }
    val uri = Uri.parse(sourceUri)
    require(uri.scheme == "file" && uri.authority.isNullOrEmpty() && uri.query == null && uri.fragment == null) {
      "Only local receipt images can be filtered"
    }
    val source = File(requireNotNull(uri.path) { "The receipt image URI has no path" }).canonicalFile
    require(allowedSourceRoots.any { source.isStrictDescendantOf(it) }) { "The receipt image is outside FinSight storage" }
    require(source.isFile && source.canRead() && source.length() in 1..64_000_000L) { "The receipt image cannot be read" }
    return source
  }

  private fun receiptCacheDirectory(): File {
    require(cacheRoot.isDirectory || cacheRoot.mkdirs()) { "FinSight cache is unavailable" }
    val directory = File(cacheRoot, "receipt-scanner")
    require(directory.isDirectory || directory.mkdirs()) { "The receipt scanner cache is unavailable" }
    val canonical = directory.canonicalFile
    require(canonical.isStrictDescendantOf(cacheRoot)) { "The receipt scanner cache path is invalid" }
    return canonical
  }

  private fun File.isStrictDescendantOf(root: File): Boolean = path.startsWith(root.path + File.separator)

  private fun readImageInfo(file: File): ImageInfo {
    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.absolutePath, options)
    validateReceiptFilterDimensions(options.outWidth, options.outHeight)
    val orientation = try {
      ExifInterface(file.absolutePath).getAttributeInt(
        ExifInterface.TAG_ORIENTATION,
        ExifInterface.ORIENTATION_NORMAL,
      )
    } catch (_: Exception) {
      ExifInterface.ORIENTATION_NORMAL
    }
    return ImageInfo(options.outWidth, options.outHeight, orientation)
  }

  private fun decodeBoundedBitmap(file: File, info: ImageInfo): Bitmap {
    var sampleSize = 1
    while ((info.width.toLong() / sampleSize) * (info.height / sampleSize) > 4_000_000L) sampleSize *= 2
    val decoded = BitmapFactory.decodeFile(
      file.absolutePath,
      BitmapFactory.Options().apply {
        inPreferredConfig = Bitmap.Config.ARGB_8888
        inSampleSize = sampleSize
        inScaled = false
      },
    ) ?: throw IllegalArgumentException("The receipt image could not be decoded")
    return orientBitmap(decoded, info.orientation)
  }

  private fun orientBitmap(bitmap: Bitmap, orientation: Int): Bitmap {
    if (orientation == ExifInterface.ORIENTATION_NORMAL || orientation == ExifInterface.ORIENTATION_UNDEFINED) {
      return bitmap
    }
    val matrix = Matrix().apply {
      when (orientation) {
        ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> setScale(-1f, 1f)
        ExifInterface.ORIENTATION_ROTATE_180 -> setRotate(180f)
        ExifInterface.ORIENTATION_FLIP_VERTICAL -> setScale(1f, -1f)
        ExifInterface.ORIENTATION_TRANSPOSE -> { setRotate(90f); postScale(-1f, 1f) }
        ExifInterface.ORIENTATION_ROTATE_90 -> setRotate(90f)
        ExifInterface.ORIENTATION_TRANSVERSE -> { setRotate(-90f); postScale(-1f, 1f) }
        ExifInterface.ORIENTATION_ROTATE_270 -> setRotate(-90f)
      }
    }
    val oriented = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    if (oriented !== bitmap) bitmap.recycle()
    return oriented
  }

  private fun applyFilter(source: Bitmap, mode: ReceiptFilterMode): Bitmap {
    check(OpenCVLoader.initLocal()) { "Receipt image processing could not start" }
    val rgba = Mat()
    val rgb = Mat()
    var filtered: Mat? = null
    try {
      Utils.bitmapToMat(source, rgba)
      Imgproc.cvtColor(rgba, rgb, Imgproc.COLOR_RGBA2RGB)
      filtered = when (mode) {
        ReceiptFilterMode.ENHANCED -> ReceiptVision.enhance(rgb)
        ReceiptFilterMode.GRAYSCALE -> grayscale(rgb)
        ReceiptFilterMode.BLACK_WHITE -> blackAndWhite(rgb)
      }
      return Bitmap.createBitmap(filtered.cols(), filtered.rows(), Bitmap.Config.ARGB_8888).also {
        Utils.matToBitmap(filtered, it)
      }
    } finally {
      rgba.release()
      rgb.release()
      filtered?.release()
    }
  }

  private fun grayscale(rgb: Mat): Mat {
    val gray = Mat()
    val result = Mat()
    try {
      Imgproc.cvtColor(rgb, gray, Imgproc.COLOR_RGB2GRAY)
      Imgproc.cvtColor(gray, result, Imgproc.COLOR_GRAY2RGB)
      return result
    } catch (exception: Exception) {
      result.release()
      throw exception
    } finally {
      gray.release()
    }
  }

  private fun blackAndWhite(rgb: Mat): Mat {
    val gray = Mat()
    val threshold = Mat()
    val result = Mat()
    try {
      Imgproc.cvtColor(rgb, gray, Imgproc.COLOR_RGB2GRAY)
      Imgproc.adaptiveThreshold(
        gray,
        threshold,
        255.0,
        Imgproc.ADAPTIVE_THRESH_GAUSSIAN_C,
        Imgproc.THRESH_BINARY,
        31,
        15.0,
      )
      Imgproc.cvtColor(threshold, result, Imgproc.COLOR_GRAY2RGB)
      return result
    } catch (exception: Exception) {
      result.release()
      throw exception
    } finally {
      gray.release()
      threshold.release()
    }
  }
}

private fun writeReceiptFilterJpeg(bitmap: Bitmap, file: File) {
  FileOutputStream(file).use { stream ->
    check(bitmap.compress(Bitmap.CompressFormat.JPEG, 92, stream)) { "The filtered receipt could not be encoded" }
    stream.flush()
    stream.fd.sync()
  }
  check(file.length() in 1..10_000_000L) { "The filtered receipt is too large to save" }
}
