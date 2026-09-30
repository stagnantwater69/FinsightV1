import { useEffect, useRef, useState } from 'react';
import { launchReceiptScanner } from '../../lib/receiptScannerLaunch';
import { scanReceiptWithNativeDocumentScanner } from '../../lib/nativeReceiptScanner';
import { ANDROID_RECEIPT_SCANNER_ENABLED } from '../../lib/receiptScannerFeature';
import { ScannerFailureState, ScannerLaunchingState, ScannerUnsupportedState } from './ScannerStatusStates';
import type { ReceiptSection } from '../../lib/receiptCapture';

interface NativeReceiptCameraProps {
  initialSections?: ReceiptSection[];
  maxReceipts?: number;
  onCancel: () => void;
  onDone: (sections: ReceiptSection[]) => void;
}

const NO_RECEIPT_CAPACITY_MESSAGE =
  'There is no room for another receipt in this batch. Go back and remove one before scanning again.';

export function NativeReceiptCamera({ initialSections = [], maxReceipts, onCancel, onDone }: NativeReceiptCameraProps) {
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(true);
  const launch = async () => {
    if (locked.current) return;
    locked.current = true;
    setError(null);
    try {
      if (maxReceipts !== undefined && (!Number.isFinite(maxReceipts) || Math.floor(maxReceipts) < 1)) {
        setError(NO_RECEIPT_CAPACITY_MESSAGE);
        return;
      }
      const result = await launchReceiptScanner(initialSections, scanReceiptWithNativeDocumentScanner, ANDROID_RECEIPT_SCANNER_ENABLED);
      if (!mounted.current) return;
      if (result.kind === 'success') onDone(result.sections);
      else if (result.kind === 'cancelled') onCancel();
      else if (result.kind === 'unsupported') setUnsupported(true);
      else setError(result.message);
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof Error && err.message.trim()
          ? err.message
          : 'FinSight could not keep this scan. Go back and try again.');
      }
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
