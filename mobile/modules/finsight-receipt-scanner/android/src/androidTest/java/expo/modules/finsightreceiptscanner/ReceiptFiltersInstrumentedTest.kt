package expo.modules.finsightreceiptscanner

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith
import org.opencv.android.OpenCVLoader

@RunWith(AndroidJUnit4::class)
class ReceiptFiltersInstrumentedTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun loadOpenCv() {
      assertTrue(OpenCVLoader.initLocal())
    }
  }

  private lateinit var root: File

  @Before
  fun createRoot() {
    val cache = InstrumentationRegistry.getInstrumentation().targetContext.cacheDir
    root = File(cache, "receipt-filter-test-${UUID.randomUUID()}")
    assertTrue(root.mkdirs())
  }

  @After
  fun removeRoot() {
    root.deleteRecursively()
  }

  @Test
  fun originalReturnsTheValidatedSourceWithoutCreatingADerivative() {
    val source = writeSource()
    val uri = Uri.fromFile(source).toString()
    val before = source.readBytes()

    val result = processor().apply(uri, "original")

    assertEquals(uri, result.uri)
    assertEquals(240, result.width)
    assertEquals(320, result.height)
    assertEquals("original", result.processingMode)
    assertArrayEquals(before, source.readBytes())
    assertFalse(File(root, "receipt-scanner").exists())
  }

  @Test
  fun writesIndependentEnhancedGrayscaleAndBlackWhiteJpegs() {
    val source = writeSource()
    val sourceBytes = source.readBytes()
    val uri = Uri.fromFile(source).toString()
    val expectedModes = mapOf(
      "enhanced" to "clear-colour",
      "grayscale" to "grayscale",
      "black-white" to "black-white",
    )

    val results = expectedModes.map { (mode, processingMode) ->
      processor().apply(uri, mode).also { result ->
        assertEquals(processingMode, result.processingMode)
        assertEquals(RECEIPT_FILTER_TRANSFORM_VERSION, result.asMap()["transformVersion"])
        assertEquals(240, result.width)
        assertEquals(320, result.height)
        assertTrue(File(Uri.parse(result.uri).path!!).isFile)
      }
    }

    assertEquals(3, results.map { it.uri }.distinct().size)
    assertArrayEquals(sourceBytes, source.readBytes())

    val grayscale = BitmapFactory.decodeFile(File(Uri.parse(results[1].uri).path!!).absolutePath)
    val blackWhite = BitmapFactory.decodeFile(File(Uri.parse(results[2].uri).path!!).absolutePath)
    try {
      assertNeutral(grayscale.getPixel(24, 24), 3)
      assertNeutral(blackWhite.getPixel(24, 24), 3)
      val dark = Color.red(blackWhite.getPixel(100, 154))
      val light = Color.red(blackWhite.getPixel(20, 20))
      assertTrue("Black and white keeps a dark text region", dark < 55)
      assertTrue("Black and white keeps a light paper region", light > 200)
    } finally {
      grayscale.recycle()
      blackWhite.recycle()
    }
  }

  @Test
  fun rejectsRemoteEscapedAndOversizedInputsBeforeDecode() {
    val source = writeSource()
    val outside = File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "outside-filter.jpg")
    source.copyTo(outside, overwrite = true)
    try {
      assertThrows(IllegalArgumentException::class.java) { processor().apply("https://example.test/receipt.jpg", "enhanced") }
      assertThrows(IllegalArgumentException::class.java) { processor().apply(Uri.fromFile(outside).toString(), "enhanced") }
      assertThrows(IllegalArgumentException::class.java) { processor().apply(Uri.fromFile(source).toString(), "sepia") }
      assertThrows(IllegalArgumentException::class.java) { validateReceiptFilterDimensions(40_001, 1) }
      assertThrows(IllegalArgumentException::class.java) { validateReceiptFilterDimensions(40_000, 1_001) }
      validateReceiptFilterDimensions(40_000, 1_000)
    } finally {
      outside.delete()
    }
  }

  @Test
  fun removesTemporaryAndFinalFilesWhenEncodingFails() {
    val source = writeSource()
    val failing = ReceiptFilterProcessor(root, listOf(root)) { _, file ->
      file.writeBytes(byteArrayOf(1, 2, 3))
      throw IOException("forced encoder failure")
    }

    assertThrows(IOException::class.java) {
      failing.apply(Uri.fromFile(source).toString(), "grayscale")
    }

    assertTrue(File(root, "receipt-scanner").listFiles()?.isEmpty() != false)
    assertTrue(source.isFile)
  }

  private fun processor() = ReceiptFilterProcessor(root, listOf(root))

  private fun writeSource(): File {
    val file = File(root, "source.jpg")
    val bitmap = Bitmap.createBitmap(240, 320, Bitmap.Config.ARGB_8888)
    try {
      val canvas = Canvas(bitmap)
      canvas.drawColor(Color.rgb(244, 232, 214))
      val ink = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(35, 55, 90) }
      canvas.drawRect(72f, 150f, 190f, 158f, ink)
      FileOutputStream(file).use { stream ->
        assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 95, stream))
      }
    } finally {
      bitmap.recycle()
    }
    return file
  }

  private fun assertNeutral(color: Int, tolerance: Int) {
    assertTrue(kotlin.math.abs(Color.red(color) - Color.green(color)) <= tolerance)
    assertTrue(kotlin.math.abs(Color.green(color) - Color.blue(color)) <= tolerance)
  }
}
