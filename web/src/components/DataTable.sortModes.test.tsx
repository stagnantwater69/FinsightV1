// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DataTable, type Column } from "./DataTable";

/**
 * The table has two sort modes, and the difference between them is the whole
 * point of the second one existing.
 *
 * CLIENT MODE (`sortValue`) is for a table holding every row it claims to
 * sort — Categories, business profiles, the recovery checkpoints. It sorts in
 * place and offers a third click that returns to the server's order.
 *
 * SERVER MODE (`onSortChange`) is for a paged list. It reorders nothing, marks
 * only the columns the API can order by, and never offers "unsorted" because
 * the API always returns some order. Records uses it, because sorting the page
 * it had in hand answered "biggest spend" with "biggest of the last 100".
 *
 * Both are exercised here so that a change made for one cannot quietly break
 * the other.
 */

interface Row {
  id: number;
  name: string;
  amount: number;
}

const ROWS: Row[] = [
  { id: 1, name: "Beta", amount: 40 },
  { id: 2, name: "Alpha", amount: 900 },
  { id: 3, name: "Gamma", amount: 5 },
];

function renderTable(columns: Column<Row>[], extra: Record<string, unknown> = {}) {
  return render(
    <DataTable
      rows={ROWS}
      columns={columns}
      getRowKey={(r) => String(r.id)}
      mobileRow={(r) => <span>{r.name}</span>}
      empty={<p>Nothing here</p>}
      caption="Test rows"
      paginate={false}
      {...extra}
    />,
  );
}

/** The first cell of each data row, in paint order. */
function order() {
  const table = screen.getByRole("table");
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0].textContent);
}

const clientColumns: Column<Row>[] = [
  { key: "name", header: "Name", cell: (r) => r.name, sortValue: (r) => r.name },
  { key: "amount", header: "Amount", cell: (r) => r.amount, sortValue: (r) => r.amount },
];

const serverColumns: Column<Row>[] = [
  // No `sortable`, and the `sortValue` here is deliberate: in server mode it
  // must be ignored rather than used as a fallback.
  { key: "name", header: "Name", cell: (r) => r.name, sortValue: (r) => r.name },
  { key: "amount", header: "Amount", cell: (r) => r.amount, sortable: true },
];

describe("DataTable client-side sorting (unchanged)", () => {
  it("sorts the rows it holds, and cycles asc -> desc -> unsorted", async () => {
    const user = userEvent.setup();
    renderTable(clientColumns);
    expect(order()).toEqual(["Beta", "Alpha", "Gamma"]);

    await user.click(screen.getByRole("button", { name: /Amount/ }));
    expect(order()).toEqual(["Gamma", "Beta", "Alpha"]);

    await user.click(screen.getByRole("button", { name: /Amount/ }));
    expect(order()).toEqual(["Alpha", "Beta", "Gamma"]);

    // Back to the order the caller supplied.
    await user.click(screen.getByRole("button", { name: /Amount/ }));
    expect(order()).toEqual(["Beta", "Alpha", "Gamma"]);
  });
});

describe("DataTable server-side sorting", () => {
  it("reports the click instead of reordering, and starts a new column at desc", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    renderTable(serverColumns, { sort: { key: "name", direction: "desc" }, onSortChange });

    await user.click(screen.getByRole("button", { name: /Amount/ }));

    expect(onSortChange).toHaveBeenCalledWith({ key: "amount", direction: "desc" });
    // Rows untouched: only the caller's next fetch can change this order.
    expect(order()).toEqual(["Beta", "Alpha", "Gamma"]);
  });

  it("flips the active column rather than offering an 'unsorted' third state", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    renderTable(serverColumns, { sort: { key: "amount", direction: "desc" }, onSortChange });

    await user.click(screen.getByRole("button", { name: /Amount/ }));
    expect(onSortChange).toHaveBeenCalledWith({ key: "amount", direction: "asc" });
  });

  it("gives no sort affordance to a column the server cannot order by", () => {
    renderTable(serverColumns, { sort: { key: "amount", direction: "desc" }, onSortChange: vi.fn() });

    const [nameHeader, amountHeader] = screen.getAllByRole("columnheader");

    // `sortValue` is present on Name but means nothing here — a local sort
    // over one loaded page is exactly what this mode removes.
    expect(within(nameHeader).queryByRole("button")).toBeNull();
    expect(nameHeader).not.toHaveAttribute("aria-sort");

    expect(within(amountHeader).getByRole("button")).toBeInTheDocument();
    expect(amountHeader).toHaveAttribute("aria-sort", "descending");
  });
});
