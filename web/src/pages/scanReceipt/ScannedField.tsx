import type { ReactNode } from "react";
import { Field } from "../../components/Field";
import type { FieldEvidence } from "../../lib/receiptWarnings";
import { EvidenceNote } from "./EvidenceNote";
import { OriginChip } from "./OriginChip";
import type { Origin } from "./types";

export function ScannedField({
  label,
  htmlFor,
  origin,
  required,
  optional,
  attention,
  evidence,
  children,
}: {
  label: string;
  htmlFor: string;
  origin: Origin;
  required?: boolean;
  optional?: boolean;
  /** True when the band said this is one of the values to look at. */
  attention?: boolean;
  /** Where this value was read from, when the server could locate it. */
  evidence?: FieldEvidence | null;
  children: ReactNode;
}) {
  return (
    <Field
      label={label}
      htmlFor={htmlFor}
      required={required}
      optional={optional}
      labelAction={<OriginChip origin={origin} />}
      hint={
        attention || evidence ? (
          <>
            {attention ? (
              <span className="font-medium text-tone-accent">Check this one against the receipt. </span>
            ) : null}
            <EvidenceNote evidence={evidence} />
          </>
        ) : undefined
      }
    >
      {children}
    </Field>
  );
}
