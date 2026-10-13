// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
import { ExpenseCategoryProvider, useExpenseCategories } from "./ExpenseCategoryContext";
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

function CategoryProbe() {
  const { categories, loading, loadingError } = useExpenseCategories();
  return <>
    <p data-testid="category-loading">{String(loading)}</p>
    <p data-testid="category-error">{loadingError ?? "none"}</p>
    <p data-testid="category-names">{categories.map((category) => category.name).join(", ")}</p>
  </>;
}

function picker() {
  return <ExpenseCategoryProvider>
    <CategoryProbe />
    <CategorySelect id="category" value="" onChange={mocks.change} />
  </ExpenseCategoryProvider>;
}

it("reports a load failure and retries without reporting an empty category list", async () => {
  mocks.get.mockRejectedValueOnce(new Error("Category service unavailable"));
  render(picker());
  expect(await screen.findByRole("alert")).toHaveTextContent("Category service unavailable");
  expect(screen.getByTestId("category-loading")).toHaveTextContent("false");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Retry loading categories" }));
  await screen.findByRole("option", { name: "Business 1 category" });
  expect(screen.getByTestId("category-error")).toHaveTextContent("none");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(mocks.get).toHaveBeenCalledTimes(2);
  expect(mocks.get.mock.calls[1][1].params).toEqual({ businessProfileId: 1 });
});

it("keeps loading distinct from failure while a category retry is pending", async () => {
  let finish!: (value: unknown) => void;
  mocks.get.mockRejectedValueOnce(new Error("Temporary category failure"))
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  render(picker());
  await screen.findByRole("alert");
  await userEvent.click(screen.getByRole("button", { name: "Retry loading categories" }));
  expect(screen.getByTestId("category-loading")).toHaveTextContent("true");
  expect(screen.getByRole("combobox")).toBeDisabled();
  await act(async () => finish({ data: [] }));
  expect(screen.getByTestId("category-loading")).toHaveTextContent("false");
  expect(screen.getByTestId("category-error")).toHaveTextContent("none");
  expect(screen.getByRole("combobox")).toBeEnabled();
});

it("does not publish a failed old-business load into the newly selected business", async () => {
  let fail!: (reason: Error) => void;
  mocks.get.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const view = render(picker());
  mocks.selected = { id: 2 };
  view.rerender(picker());
  await screen.findByRole("option", { name: "Business 2 category" });
  await act(async () => fail(new Error("Business 1 failed late")));
  expect(screen.getByTestId("category-error")).toHaveTextContent("none");
  expect(screen.getByTestId("category-names")).toHaveTextContent("Business 2 category");
  expect(screen.queryByText("Business 1 failed late")).not.toBeInTheDocument();
});

it("does not reveal the previous business's load error while the new load is pending", async () => {
  mocks.get.mockRejectedValueOnce(new Error("Business 1 failed"));
  const view = render(picker());
  await screen.findByRole("alert");
  let finish!: (value: unknown) => void;
  mocks.get.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  mocks.selected = { id: 2 };
  view.rerender(picker());
  expect(screen.getByTestId("category-error")).toHaveTextContent("none");
  expect(screen.queryByText("Business 1 failed")).not.toBeInTheDocument();
  await act(async () => finish({ data: [] }));
});

it("shows the creation cooldown without losing the name or treating it as a load failure", async () => {
  const config = { headers: new AxiosHeaders() };
  mocks.post.mockRejectedValueOnce(new AxiosError("Rate limited", "ERR_BAD_REQUEST", config as never, {}, {
    status: 429, statusText: "", config: config as never, headers: { "retry-after": "6" }, data: {},
  }));
  render(picker());
  await screen.findByRole("option", { name: "Business 1 category" });
  await userEvent.selectOptions(screen.getByRole("combobox"), "__new__");
  await userEvent.type(screen.getByLabelText("New category name"), "Supplies");
  await userEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Try again in 6s.");
  expect(screen.getByLabelText("New category name")).toHaveValue("Supplies");
  expect(screen.getByTestId("category-error")).toHaveTextContent("none");
  await waitFor(() => expect(screen.getByRole("button", { name: "Add" })).toBeEnabled());
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
