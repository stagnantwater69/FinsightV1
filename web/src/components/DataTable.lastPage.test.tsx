// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DataTable } from "./DataTable";

// Records fetches its next batch from the server only when the owner pages to
// the end of what is loaded, not while they read the first pages.

interface Row {
  id: number;
}

const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

function Table({ count, onLastPage }: { count: number; onLastPage?: () => void }) {
  return (
    <DataTable
      rows={rows(count)}
      columns={[{ key: "id", header: "Id", cell: (r: Row) => `Row ${r.id}` }]}
      getRowKey={(r) => String(r.id)}
      mobileRow={(r) => `Row ${r.id}`}
      empty={<p>None</p>}
      caption="Rows"
      defaultPageSize={10}
      onLastPage={onLastPage}
    />
  );
}

describe("DataTable onLastPage", () => {
  it("waits until the owner reaches the last page, then asks once", async () => {
    localStorage.clear();
    const onLastPage = vi.fn();
    render(<Table count={30} onLastPage={onLastPage} />);
    expect(onLastPage).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /next page/i }));
    expect(onLastPage).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /next page/i }));
    expect(onLastPage).toHaveBeenCalledTimes(1);
  });

  it("stops asking once more rows add pages after the current one", async () => {
    localStorage.clear();
    const onLastPage = vi.fn();
    const { rerender } = render(<Table count={10} onLastPage={onLastPage} />);
    expect(onLastPage).toHaveBeenCalledTimes(1);

    // The caller hands back no callback while loading, then the bigger list.
    rerender(<Table count={10} />);
    rerender(<Table count={20} onLastPage={onLastPage} />);
    expect(onLastPage).toHaveBeenCalledTimes(1);
  });
});
