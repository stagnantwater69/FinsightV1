import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { AddExpenseModal } from "./AddExpenseModal";
import { AddSalesModal } from "./AddSalesModal";

/**
 * "Add expense" and "Add sales" as the same popups Records uses, for any page
 * that offers them. Render `popups` once on the page and call `openExpense` /
 * `openSales` from its buttons.
 *
 * Each form mounts only while it is open, so a page whose owner never adds
 * a record from it pays nothing for the forms, and every popup starts blank.
 *
 * A record needs a business to belong to, so with none selected the buttons
 * go to the full-page forms instead, which explain what is missing.
 */
export function useAddRecordPopups(onSaved: () => void = () => {}) {
  const { selected } = useBusinessProfiles();
  const navigate = useNavigate();
  const [open, setOpen] = useState<"expense" | "sales" | null>(null);

  const close = () => setOpen(null);
  const popups = !selected ? null
    : open === "expense" ? <AddExpenseModal businessProfileId={selected.id} open onClose={close} onSaved={onSaved} />
      : open === "sales" ? <AddSalesModal businessProfileId={selected.id} open onClose={close} onSaved={onSaved} />
        : null;

  return {
    openExpense: () => (selected ? setOpen("expense") : navigate("/records/expenses/new")),
    openSales: () => (selected ? setOpen("sales") : navigate("/records/sales/new")),
    popups,
  };
}
