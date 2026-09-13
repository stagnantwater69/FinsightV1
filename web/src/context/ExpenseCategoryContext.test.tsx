// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { ExpenseCategoryProvider } from "./ExpenseCategoryContext";
import { CategorySelect } from "../components/CategorySelect";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), selected: { id: 1 }, change: vi.fn() }));
vi.mock("../lib/api", () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock("./BusinessProfileContext", () => ({ useBusinessProfiles: () => ({ selected: mocks.selected }) }));
vi.mock("../components/Toast", () => ({ useToast: () => vi.fn() }));
beforeEach(() => {
  mocks.selected = { id: 1 };
  mocks.get.mockReset(); mocks.post.mockReset(); mocks.change.mockReset();
  mocks.get.mockImplementation(async () => ({ data: [{ id: mocks.selected.id, businessProfileId: mocks.selected.id, name: `Business ${mocks.selected.id} category` }] }));
});

it("does not select a newly created category after the business changes", async () => {
  const user = userEvent.setup();
  let finish!: (value: unknown) => void;
  mocks.post.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const tree = <ExpenseCategoryProvider><CategorySelect id="category" value="" onChange={mocks.change} /></ExpenseCategoryProvider>;
  const view = render(tree);
  await screen.findByRole("option", { name: "Business 1 category" });
  await user.selectOptions(screen.getByRole("combobox"), "__new__");
  await user.type(screen.getByLabelText("New category name"), "Old business category");
  await user.click(screen.getByRole("button", { name: "Add" }));
  mocks.selected = { id: 2 };
  view.rerender(<ExpenseCategoryProvider><CategorySelect id="category" value="" onChange={mocks.change} /></ExpenseCategoryProvider>);
  await act(async () => { finish({ data: { id: 42, businessProfileId: 1, name: "Old business category" } }); });
  expect(mocks.change).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("option", { name: "Business 2 category" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Old business category" })).not.toBeInTheDocument();
});
