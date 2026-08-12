import type {
  AnomalyFindingFeedback,
  AnomalyFindingSeverity,
  AnomalyFindingStatus,
  AnomalyFindingType,
} from "@prisma/client";

export type FindingMetadata = Record<string, string | number | boolean | null | string[] | number[]>;

export interface DetectionFinding {
  fingerprint: string;
  businessProfileId: number;
  expenseRecordId?: number;
  type: AnomalyFindingType;
  severity: AnomalyFindingSeverity;
  score?: number;
  method: string;
  title: string;
  reasons: string[];
  metadata?: FindingMetadata;
  detectorVersion: string;
}

export interface TransactionForDetection {
  id: number;
  businessProfileId: number;
  categoryId: number;
  amount: number;
  date: Date;
  description: string;
  vendor?: string | null;
  createdAt: Date;
}

export interface DetectionContext {
  transaction: TransactionForDetection;
  history: TransactionForDetection[];
  evaluatedAt: Date;
}

export interface TransactionDetector {
  readonly name: string;
  readonly version: string;
  detect(context: DetectionContext): Promise<DetectionFinding[]>;
}

export interface FindingReview {
  status: Extract<AnomalyFindingStatus, "CONFIRMED" | "DISMISSED" | "RESOLVED">;
  feedback: AnomalyFindingFeedback;
}
