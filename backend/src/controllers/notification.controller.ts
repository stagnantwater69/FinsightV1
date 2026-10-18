import type { Request, Response } from "express";
import { z } from "zod";
import * as notificationService from "../services/notification.service";
import { ApiError } from "../middleware/error.middleware";

const listQuerySchema = z.object({
  businessProfileId: z.coerce.number().int().positive().max(2147483647).optional(),
});

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) {
    throw new ApiError(400, "Invalid notification id");
  }
  return id;
}

export async function list(req: Request, res: Response) {
  const query = listQuerySchema.parse(req.query);
  const { notifications, unreadCount } = await notificationService.listNotificationsWithUnreadCount(
    req.user!.id,
    query.businessProfileId,
  );
  // The list stops at 500; the badge needs the full total. A header rather
  // than a wrapping object, so clients that read the bare array keep working.
  res.setHeader("X-Unread-Count", String(unreadCount));
  res.status(200).json(notifications);
}

export async function markRead(req: Request, res: Response) {
  const id = parseId(req.params.id!);
  const notification = await notificationService.markNotificationRead(req.user!.id, id);
  res.status(200).json(notification);
}

export async function markAllRead(req: Request, res: Response) {
  const query = listQuerySchema.parse(req.query);
  const result = await notificationService.markAllNotificationsRead(req.user!.id, query.businessProfileId);
  res.status(200).json(result);
}
