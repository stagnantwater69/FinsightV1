import { Card } from "../../components/ui";
import { IconCamera, IconCrop, IconRecords, IconSun } from "../../components/icons";

export function ReceiptPhotoTips() {
  const tips = [
    {
      title: "Use even lighting",
      detail: "Avoid glare and strong shadows across the printed total.",
      Icon: IconSun,
    },
    {
      title: "Keep every edge in frame",
      detail: "Lay the receipt flat and keep the text in focus.",
      Icon: IconCrop,
    },
    {
      title: "Add pages in reading order",
      detail: "For a long receipt, upload up to eight overlapping photos.",
      Icon: IconRecords,
    },
  ];

  return (
    <Card className="p-5">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-tint-brand text-tone-brand">
          <IconCamera className="h-5 w-5" />
        </span>
        <div>
          <h2 id="receipt-photo-tips-title" className="font-display text-base font-semibold text-ink-900">Photo tips</h2>
          <p className="mt-0.5 text-xs text-ink-500">A clear image gives you less to correct.</p>
        </div>
      </div>
      <ul className="mt-4 divide-y divide-paper-200">
        {tips.map(({ title, detail, Icon }) => (
          <li key={title} className="flex gap-3 py-3 first:pt-0 last:pb-0">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-tint-brand text-tone-brand">
              <Icon className="h-[18px] w-[18px]" />
            </span>
            <span className="min-w-0">
              <b className="block text-sm font-semibold text-ink-800">{title}</b>
              <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">{detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
