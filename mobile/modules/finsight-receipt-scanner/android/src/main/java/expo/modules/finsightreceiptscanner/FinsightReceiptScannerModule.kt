package expo.modules.finsightreceiptscanner

import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File

class ScannerCommand : Record {
  @Field var id: Int = 0
  @Field var type: String = "reset"
}

class FinsightReceiptScannerModule : Module() {
  private val cacheFileName = Regex(
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}-(original|scan)\\.jpg$",
  )

  private fun receiptCacheDirectory(): File = File(appContext.cacheDirectory, "receipt-scanner")

  private fun ownedCacheFile(uriValue: String): File? {
    if (uriValue.length !in 1..4096) return null
    val uri = try { Uri.parse(uriValue) } catch (_: Exception) { return null }
    if (uri.scheme != "file") return null
    val path = uri.path ?: return null
    val root = try { receiptCacheDirectory().canonicalFile } catch (_: Exception) { return null }
    val file = try { File(path).canonicalFile } catch (_: Exception) { return null }
    if (file.parentFile != root || !cacheFileName.matches(file.name)) return null
    return file
  }

  private fun deleteOwnedFiles(uris: List<String>): Int = uris
    .asSequence()
    .take(32)
    .mapNotNull(::ownedCacheFile)
    .distinctBy { it.path }
    .count { !it.exists() || it.delete() }

  private fun clearOwnedCache(): Int = receiptCacheDirectory().listFiles()
    ?.asSequence()
    ?.filter { it.isFile && cacheFileName.matches(it.name) }
    ?.count { it.delete() }
    ?: 0

  override fun definition() = ModuleDefinition {
    Name("FinsightReceiptScanner")
    AsyncFunction("deleteCachedFiles") { uris: List<String> -> deleteOwnedFiles(uris) }
    AsyncFunction("clearReceiptCache") { clearOwnedCache() }
    View(FinsightReceiptScannerView::class) {
      Events("onStatus", "onCapture", "onError")
      Prop("active") { view: FinsightReceiptScannerView, value: Boolean -> view.setActive(value) }
      Prop("mode") { view: FinsightReceiptScannerView, value: String -> view.setMode(value) }
      Prop("torch") { view: FinsightReceiptScannerView, value: Boolean -> view.setTorch(value) }
      Prop("command") { view: FinsightReceiptScannerView, value: ScannerCommand -> view.command(value) }
    }
  }
}
