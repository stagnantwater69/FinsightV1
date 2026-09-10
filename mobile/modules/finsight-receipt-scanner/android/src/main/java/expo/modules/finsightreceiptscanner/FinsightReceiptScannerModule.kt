package expo.modules.finsightreceiptscanner

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class ScannerCommand : Record {
  @Field var id: Int = 0
  @Field var type: String = "reset"
}

class FinsightReceiptScannerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("FinsightReceiptScanner")
    View(FinsightReceiptScannerView::class) {
      Events("onStatus", "onCapture", "onError")
      Prop("active") { view: FinsightReceiptScannerView, value: Boolean -> view.setActive(value) }
      Prop("mode") { view: FinsightReceiptScannerView, value: String -> view.setMode(value) }
      Prop("torch") { view: FinsightReceiptScannerView, value: Boolean -> view.setTorch(value) }
      Prop("command") { view: FinsightReceiptScannerView, value: ScannerCommand -> view.command(value) }
    }
  }
}
