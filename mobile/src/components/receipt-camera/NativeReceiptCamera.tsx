import { useEffect, useRef, useState } from 'react';
import { launchReceiptScanner } from '../../lib/receiptScannerLaunch';
import { scanReceiptWithNativeDocumentScanner } from '../../lib/nativeReceiptScanner';
import { ANDROID_RECEIPT_SCANNER_ENABLED } from '../../lib/receiptScannerFeature';
import { ScannerFailureState, ScannerLaunchingState, ScannerUnsupportedState } from './ScannerStatusStates';
import type { ReceiptSection } from '../../lib/receiptCapture';

export function NativeReceiptCamera({ initialSections = [], onCancel, onDone }: { initialSections?: ReceiptSection[]; onCancel: () => void; onDone: (sections: ReceiptSection[]) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(true);
  const launch = async () => {
    if (locked.current) return;
    locked.current = true;
    setError(null);
    try {
      const result = await launchReceiptScanner(initialSections, scanReceiptWithNativeDocumentScanner, ANDROID_RECEIPT_SCANNER_ENABLED);
      if (!mounted.current) return;
      if (result.kind === 'success') onDone(result.sections);
      else if (result.kind === 'cancelled') onCancel();
      else if (result.kind === 'unsupported') setUnsupported(true);
      else setError(result.message);
    } finally { locked.current = false; }
  };
  useEffect(() => {
    mounted.current = true; void launch();
    return () => { mounted.current = false; };
    // This optional native activity launches once per capture-session mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (unsupported) return <ScannerUnsupportedState onCancel={onCancel} />;
  if (error) return <ScannerFailureState message={error} onRetry={() => void launch()} onGoBack={onCancel} />;
  return <ScannerLaunchingState />;
}
