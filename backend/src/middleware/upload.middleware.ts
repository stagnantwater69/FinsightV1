import multer from "multer";
import { ApiError } from "./error.middleware";

const storage = multer.memoryStorage();

export const uploadReceiptImage = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) {
      cb(new ApiError(400, "Receipt image must be JPEG, PNG, or WEBP"));
      return;
    }
    cb(null, true);
  },
});

export const uploadCsv = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["text/csv", "application/vnd.ms-excel", "application/csv", "text/plain"];
    if (!allowed.includes(file.mimetype) && !file.originalname.toLowerCase().endsWith(".csv")) {
      cb(new ApiError(400, "File must be a CSV"));
      return;
    }
    cb(null, true);
  },
});

export const uploadPhoto = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) {
      cb(new ApiError(400, "Photo must be JPEG, PNG, or WEBP"));
      return;
    }
    cb(null, true);
  },
});
