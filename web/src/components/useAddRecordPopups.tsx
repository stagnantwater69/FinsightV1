import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { AddExpenseModal } from "./AddExpenseModal";
import { AddSalesModal } from "./AddSalesModal";

/**
 * "Add expense" and "Add sales" as the same popups Records uses, for any page
 * that offers them. Render `popups` once on the page and call `openExpense` /
 * `openSales` from its buttons, or `openEdit` to change a saved record.
 *
 * Each form mounts the first time it opens and then stays mounted, as on
 * Records: a page whose owner never adds a record from it pays nothing for
 * the forms, and closing one fades out instead of vanishing.
 *
 * A record needs a business to belong to, so with none selected the buttons
 * go to the full-page forms instead, which explain what is missing.
 */
export function useAddRecordPopups(onSaved: () => void = () => {}) {
  const { selected } = useBusinessProfiles();
  const navigate = useNavigate();
  const [open, setOpen] = useState<"expense" | "sales" | null>(null);
  // Set when the popup is editing a saved record rather than adding one.
  const [recordId, setRecordId] = useState<number | undefined>(undefined);
  const [used, setUsed] = useState({ expense: false, sales: false });

  const show = (kind: "expense" | "sales", id?: number) => {
    setUsed((current) => (current[kind] ? current : { ...current, [kind]: true }));
    setRecordId(id);
    setOpen(kind);
  };
  const close = () => setOpen(null);
  const popups = selected ? (
    <>
      {used.expense ? (
        <AddExpenseModal businessProfileId={selected.id} open={open === "expense"} recordId={open === "expense" ? recordId : undefined} onClose={close} onSaved={onSaved} />
      ) : null}
      {used.sales ? (
        <AddSalesModal businessProfileId={selected.id} open={open === "sales"} recordId={open === "sales" ? recordId : undefined} onClose={close} onSaved={onSaved} />
      ) : null}
    </>
  ) : null;

  return {
    openExpense: () => (selected ? show("expense") : navigate("/records/expenses/new")),
    openSales: () => (selected ? show("sales") : navigate("/records/sales/new")),
    /** Opens a saved record in the same popup, for editing in place. */
    openEdit: (type: "expense" | "sales", id: number) =>
      selected ? show(type, id) : navigate(`/records/${type === "sales" ? "sales" : "expenses"}/${id}/edit`),
    popups,
  };
}
