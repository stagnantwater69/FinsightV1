import type { Request, Response } from "express";
import { z } from "zod";
import * as notificationService from "../services/notification.service";
import { ApiError } from "../middleware/error.middleware";

const listQuerySchema = z.object({
  businessProfileId: z.coerce.number().int().positive().optional(),
});

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(400, "Invalid notification id");
  }
  return id;
}

export async function list(req: Request, res: Response) {
  const query = listQuerySchema.parse(req.query);
  const notifications = await notificationService.listNotifications(req.user!.id, query.businessProfileId);
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
