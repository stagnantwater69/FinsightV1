import { alertKindFromType } from "../components/Alert";
import type { Notification } from "./types";

export function relativeTime(iso: string) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function notificationTarget(notification: Notification) {
  if (!notification.expenseRecordId) return null;
  const duplicate = alertKindFromType(notification.type) === "duplicate";
  return {
    to: `/records?${duplicate ? "reviewDuplicateId" : "highlightRecordId"}=${notification.expenseRecordId}`,
    label: duplicate ? "Review duplicate" : "Review record",
  };
}

export function dayLabel(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Earlier";
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round(
    (startOfDay(new Date()) - startOfDay(date)) / 86_400_000,
  );
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Earlier this week";
  if (days < 30) return "Earlier this month";
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
