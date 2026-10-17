// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AxiosError } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddExpense } from "./AddExpense";
import { AddSalesRecord } from "./AddSalesRecord";
import { Records } from "./Records";
import { Profile } from "./Profile";
import { AddExpenseModal } from "../components/AddExpenseModal";
import { AddSalesModal } from "../components/AddSalesModal";
import { clearManualRecordRecoveryForOwner, clearPendingManualCreate, ManualCreateCorruptError, performManualRecordCreate, readPendingManualCreate, repairCorruptManualCreate, type ManualCreateScope } from "../lib/manualRecordCreate";
import { beginServerStateSession } from "../lib/serverStateCache";

if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
}

const mocks = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), remove: vi.fn(), logout: vi.fn(), confirm: vi.fn(), toast: vi.fn(), selected: { id: 1, timezone: "Asia/Manila" }, ownerId: 17, navigate: vi.fn(), saved: vi.fn(), close: vi.fn() }));
vi.mock("../lib/api", () => ({ api: { post: mocks.post, get: mocks.get, delete: mocks.remove } }));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ profile: { id: mocks.ownerId, firstName: "Synthetic", lastName: "Owner", email: "synthetic@example.com", avatarUrl: null }, logout: mocks.logout }) }));
vi.mock("../context/BusinessProfileContext", () => ({ useBusinessProfiles: () => ({ selected: mocks.selected, profiles: [mocks.selected], loading: false, error: null }) }));
vi.mock("../context/ExpenseCategoryContext", () => ({ useExpenseCategories: () => ({ categories: [{ id: 10, name: "Inventory" }], loading: false, recentCategoryIds: [], rememberCategory: vi.fn() }) }));
vi.mock("../components/Toast", () => ({ useToast: () => mocks.toast }));
vi.mock("../components/ConfirmDialog", () => ({ useConfirm: () => mocks.confirm }));
vi.mock("react-router-dom", async (original) => ({ ...await original<typeof import("react-router-dom")>(), useNavigate: () => mocks.navigate }));

interface FakeRequest { result?: unknown; onsuccess?: () => void; onerror?: () => void }
interface FakeTransaction { oncomplete?: () => void; onabort?: () => void; onerror?: () => void; objectStore: () => { get: (key: string) => FakeRequest; put: (value: unknown, key: string) => void; delete: (key: string) => void; openCursor: () => FakeRequest }; abort: () => void }

function browserStorage() {
  const values = new Map<string, unknown>();
  let tail = Promise.resolve(); let failDelete = false; let failWrites = false;
  const factory = {
    open: () => {
      const request: FakeRequest & { onupgradeneeded?: () => void } = {};
      const database = {
        close: vi.fn(), createObjectStore: vi.fn(),
        transaction: () => {
          let aborted = false; let cursorRequest: FakeRequest | null = null;
          const reads: Array<{ key: string; request: FakeRequest }> = [];
          const writes = new Map<string, unknown>(); const deletes = new Set<string>();
          const transaction: FakeTransaction = {
            objectStore: () => ({
              get: (key) => { const request: FakeRequest = {}; reads.push({ key, request }); return request; },
              put: (value, key) => { if (failWrites) { transaction.abort(); return; } writes.set(key, structuredClone(value)); },
              delete: (key) => { if (failDelete) { transaction.abort(); return; } deletes.add(key); },
              openCursor: () => { cursorRequest = {}; return cursorRequest; },
            }),
            abort: () => { aborted = true; },
          };
          tail = tail.then(() => new Promise<void>((resolve) => setTimeout(() => {
            while (!aborted && reads.length > 0) {
              const read = reads.shift()!;
              read.request.result = deletes.has(read.key) ? undefined : writes.has(read.key) ? structuredClone(writes.get(read.key)) : values.has(read.key) ? structuredClone(values.get(read.key)) : undefined;
              read.request.onsuccess?.();
            }
            if (cursorRequest) {
              const request = cursorRequest;
              const entries = [...values.entries()];
              const next = () => {
                const entry = entries.shift();
                request.result = entry ? { key: entry[0], value: structuredClone(entry[1]), delete: () => { if (failDelete) transaction.abort(); else deletes.add(entry[0]); }, continue: next } : null;
                request.onsuccess?.();
              };
              next();
            }
            if (aborted) transaction.onabort?.();
            else { for (const key of deletes) values.delete(key); for (const [key, value] of writes) values.set(key, value); transaction.oncomplete?.(); }
            resolve();
          }, 0)));
          return transaction;
        },
      };
      request.result = database;
      setTimeout(() => { request.onupgradeneeded?.(); request.onsuccess?.(); }, 0);
      return request;
    },
  };
  return { factory, values, failDelete: (value: boolean) => { failDelete = value; }, failWrites: (value: boolean) => { failWrites = value; } };
}

let storage: ReturnType<typeof browserStorage>;
const scope: ManualCreateScope = { ownerId: 17, businessProfileId: 1, kind: "expense" };
const payload = { businessProfileId: 1, categoryId: 10, date: "2026-10-10", description: "Synthetic purchase", amount: 1234.56 };
const dto = (kind = "expense", businessProfileId = 1) => ({ id: 91, businessProfileId, type: kind, description: "Synthetic purchase", amount: 1234.56 });
const options = () => ({ signal: new AbortController().signal, isCurrent: () => true });
function rejection(status: number, code?: string) {
  return new AxiosError("Synthetic server rejection", "ERR_BAD_REQUEST", undefined, undefined, { status, data: { code }, statusText: "Synthetic", headers: {}, config: {} as never });
}
beforeEach(() => {
  storage = browserStorage(); vi.stubGlobal("indexedDB", storage.factory);
  mocks.ownerId = 17; mocks.selected = { id: 1, timezone: "Asia/Manila" };
  mocks.post.mockReset(); mocks.get.mockReset().mockResolvedValue({ data: { items: [{ id: 1 }, { id: 2 }] } });
  mocks.remove.mockReset().mockResolvedValue({ data: {} });
  mocks.logout.mockReset().mockResolvedValue(undefined); beginServerStateSession(17);
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.toast.mockReset(); mocks.navigate.mockReset(); mocks.saved.mockReset(); mocks.close.mockReset(); localStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("web durable manual create boundary", () => {
  it("persists before dispatch and retries an immutable key/body after a lost response", async () => {
    mocks.post.mockImplementationOnce(async () => { expect(storage.values.size).toBe(1); throw new Error("Lost response"); });
    await expect(performManualRecordCreate(scope, payload, options())).rejects.toThrow("Lost response");
    const first = mocks.post.mock.calls[0]![1];
    mocks.post.mockResolvedValueOnce({ data: dto() });
    const replay = await performManualRecordCreate(scope, { ...payload, amount: 0.001 }, options());
    expect(replay.record.id).toBe(91); expect(mocks.post.mock.calls[1]![1]).toEqual(first);
    expect(first.amount).toBe(1234.56); expect(first.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
    expect(await readPendingManualCreate(scope)).toBeNull();
  });

  it("blocks dispatch if recovery is unavailable or its transaction aborts", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(performManualRecordCreate(scope, payload, options())).rejects.toThrow("Nothing new was sent"); expect(mocks.post).not.toHaveBeenCalled();
    vi.stubGlobal("indexedDB", storage.factory); storage.failWrites(true);
    await expect(performManualRecordCreate(scope, payload, options())).rejects.toThrow("Nothing new was sent"); expect(mocks.post).not.toHaveBeenCalled();
  });

  it.each([
    { amount: 0.001 }, { amount: -1 }, { amount: 0 }, { categoryId: 0 }, { date: "2026-02-30" },
    { includedInAvailableFundsBaseline: true }, { availableFundsBaselineAt: "2026-10-10T00:00:00.000Z" },
  ])("rejects malformed fresh details %j before persistence or dispatch and permits a corrected fresh save", async (invalid) => {
    await expect(performManualRecordCreate(scope, { ...payload, ...invalid }, options())).rejects.toThrow();
    expect(mocks.post).not.toHaveBeenCalled(); expect(storage.values.size).toBe(0);
    mocks.post.mockResolvedValueOnce({ data: dto() });
    expect((await performManualRecordCreate(scope, payload, options())).record.id).toBe(91);
    expect(mocks.post).toHaveBeenCalledTimes(1); expect(await readPendingManualCreate(scope)).toBeNull();
  });

  it.each([401, 403, 429])("retains a prior unknown request on later %s instead of rotating its key", async (status) => {
    mocks.post.mockRejectedValueOnce(new Error("Lost response"));
    await expect(performManualRecordCreate(scope, payload, options())).rejects.toThrow();
    const prior = await readPendingManualCreate(scope);
    mocks.post.mockRejectedValueOnce(rejection(status));
    await expect(performManualRecordCreate(scope, payload, options())).rejects.toThrow();
    expect((await readPendingManualCreate(scope))?.body).toEqual(prior?.body);
    expect((await readPendingManualCreate(scope))?.dispatchCount).toBe(2);
  });

  it.each(["MANUAL_CREATE_KEY_CONFLICT", "MANUAL_CREATE_RECORD_DELETED"])("retains a refused committed identity for %s", async (code) => {
    mocks.post.mockRejectedValueOnce(rejection(409, code));
    await expect(performManualRecordCreate(scope, payload, options())).rejects.toThrow();
    expect(await readPendingManualCreate(scope)).not.toBeNull();
  });

  it("clears a definite first rejection and allows correction under a fresh key", async () => {
    mocks.post.mockRejectedValueOnce(rejection(400));
    await expect(performManualRecordCreate(scope, payload, options())).rejects.toThrow();
    expect(await readPendingManualCreate(scope)).toBeNull();
    mocks.post.mockResolvedValueOnce({ data: dto() }); await performManualRecordCreate(scope, { ...payload, amount: 500 }, options());
    expect(mocks.post.mock.calls[1]![1].idempotencyKey).not.toBe(mocks.post.mock.calls[0]![1].idempotencyKey);
  });

  it("stores confirmed identity before failed cleanup and finishes after reload with zero additional POST", async () => {
    storage.failDelete(true); mocks.post.mockResolvedValueOnce({ data: dto() });
    const confirmed = await performManualRecordCreate(scope, payload, options());
    expect(confirmed.cleanupPending).toBe(true); expect((await readPendingManualCreate(scope))?.confirmedRecord?.id).toBe(91);
    storage.failDelete(false); const finished = await performManualRecordCreate(scope, payload, options());
    expect(finished.record.id).toBe(91); expect(mocks.post).toHaveBeenCalledTimes(1); expect(await readPendingManualCreate(scope)).toBeNull();
  });

  it("keeps owner/business/kind recovery isolated and rejects stale cleanup", async () => {
    mocks.post.mockRejectedValueOnce(new Error("Lost response")); await expect(performManualRecordCreate(scope, payload, options())).rejects.toThrow();
    const pending = await readPendingManualCreate(scope);
    expect(await readPendingManualCreate({ ...scope, ownerId: 18 })).toBeNull();
    expect(await readPendingManualCreate({ ...scope, businessProfileId: 2 })).toBeNull();
    expect(await readPendingManualCreate({ ...scope, kind: "sales" })).toBeNull();
    await expect(clearPendingManualCreate(scope, "stale-key-0001")).rejects.toThrow("Another save");
    expect((await readPendingManualCreate(scope))?.body.idempotencyKey).toBe(pending?.body.idempotencyKey);
  });

  it("prevents Undo from replacing an unrelated pending save", async () => {
    mocks.post.mockRejectedValueOnce(new Error("Lost response")); await expect(performManualRecordCreate(scope, payload, options())).rejects.toThrow();
    await expect(performManualRecordCreate(scope, { ...payload, description: "Undo record" }, { ...options(), requireFresh: true })).rejects.toThrow("Another save needs review");
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it("blocks a request canceled while recovery persistence is underway", async () => {
    const controller = new AbortController(); const attempt = performManualRecordCreate(scope, payload, { signal: controller.signal, isCurrent: () => true });
    controller.abort(); await expect(attempt).rejects.toThrow("previous account or business"); expect(mocks.post).not.toHaveBeenCalled();
  });

  it("does not overwrite corrupt recovery and requires its unchanged fingerprint for explicit resolution", async () => {
    storage.values.set("17:1:expense", { version: 99, synthetic: "Corrupt saved request" });
    const error = await readPendingManualCreate(scope).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ManualCreateCorruptError);
    await expect(performManualRecordCreate(scope, payload, options())).rejects.toBeInstanceOf(ManualCreateCorruptError);
    expect(mocks.post).not.toHaveBeenCalled();
    storage.values.set("17:1:expense", { version: 99, synthetic: "Changed corrupt request" });
    await expect(repairCorruptManualCreate(scope, (error as ManualCreateCorruptError).fingerprint)).rejects.toBeInstanceOf(ManualCreateCorruptError);
    const latest = await readPendingManualCreate(scope).catch((value: unknown) => value);
    await repairCorruptManualCreate(scope, (latest as ManualCreateCorruptError).fingerprint);
    expect(await readPendingManualCreate(scope)).toBeNull(); expect(mocks.post).not.toHaveBeenCalled();
  });

  it("erases the deleted owner's valid and corrupt recovery while preserving another owner", async () => {
    mocks.post.mockRejectedValueOnce(new Error("Lost owner A response")); await expect(performManualRecordCreate(scope, payload, options())).rejects.toThrow();
    const otherScope = { ...scope, ownerId: 18 };
    mocks.post.mockRejectedValueOnce(new Error("Lost owner B response")); await expect(performManualRecordCreate(otherScope, payload, options())).rejects.toThrow();
    const other = await readPendingManualCreate(otherScope);
    storage.values.set("17:99:sales", { version: 99, privateSyntheticDetails: "Damaged old-owner payload" });
    await clearManualRecordRecoveryForOwner(17);
    expect(await readPendingManualCreate(scope)).toBeNull();
    expect([...storage.values.keys()].some((key) => key.startsWith("17:"))).toBe(false);
    expect(storage.values.get("deleted-owner:17")).toBe(true);
    expect((await readPendingManualCreate(otherScope))?.body).toEqual(other?.body);
  });

  it("does not dispatch or repopulate recovery for an owner marked deleted", async () => {
    await clearManualRecordRecoveryForOwner(17);
    await expect(performManualRecordCreate(scope, payload, options())).rejects.toThrow();
    expect(mocks.post).not.toHaveBeenCalled(); expect(storage.values.get("deleted-owner:17")).toBe(true);
    expect([...storage.values.keys()].some((key) => key.startsWith("17:"))).toBe(false);
  });

  it("does not repopulate a deleted owner's recovery from a late successful create response", async () => {
    let finish!: (value: unknown) => void;
    mocks.post.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const attempt = performManualRecordCreate(scope, payload, options());
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    await clearManualRecordRecoveryForOwner(17); finish({ data: dto() });
    await attempt.catch(() => undefined);
    expect(await readPendingManualCreate(scope)).toBeNull(); expect(mocks.post).toHaveBeenCalledTimes(1);
    expect([...storage.values.keys()].some((key) => key.startsWith("17:"))).toBe(false);
    expect(storage.values.get("deleted-owner:17")).toBe(true);
  });

  it("rolls back owner cleanup and its marker together when browser deletion fails", async () => {
    mocks.post.mockRejectedValueOnce(new Error("Lost response")); await expect(performManualRecordCreate(scope, payload, options())).rejects.toThrow();
    const prior = await readPendingManualCreate(scope); storage.failDelete(true);
    await expect(clearManualRecordRecoveryForOwner(17)).rejects.toThrow();
    expect(storage.values.has("deleted-owner:17")).toBe(false); expect((await readPendingManualCreate(scope))?.body).toEqual(prior?.body);
    storage.failDelete(false); await clearManualRecordRecoveryForOwner(17);
    expect(await readPendingManualCreate(scope)).toBeNull(); expect(mocks.post).toHaveBeenCalledTimes(1);
  });
});

const forms = [["expense", "page"], ["sales", "page"], ["expense", "modal"], ["sales", "modal"]] as const;
function tree(kind: string, surface: string, open = true) {
  return <MemoryRouter>{surface === "page" ? kind === "expense" ? <AddExpense /> : <AddSalesRecord /> : kind === "expense" ? <AddExpenseModal businessProfileId={mocks.selected.id} open={open} onSaved={mocks.saved} onClose={mocks.close} /> : <AddSalesModal businessProfileId={mocks.selected.id} open={open} onSaved={mocks.saved} onClose={mocks.close} />}</MemoryRouter>;
}
async function enter(kind: string, surface: string) {
  const user = userEvent.setup(); const q = render(tree(kind, surface));
  await waitFor(() => expect(screen.getByLabelText(/^Description/)).toBeEnabled());
  if (kind === "expense") await user.selectOptions(screen.getByLabelText(/^Category/), "10");
  fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: "Synthetic purchase" } });
  fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: "1234.56" } });
  const label = kind === "expense" ? "Save expense" : "Save sales reference";
  return { user, q, label };
}

describe.each(forms)("%s %s recovery flow", (kind, surface) => {
  it("restores a pending request on remount and sends its exact body on explicit retry", async () => {
    mocks.post.mockRejectedValueOnce(new Error("Lost response"));
    const { user, q, label } = await enter(kind, surface);
    await user.click(screen.getByRole("button", { name: label }));
    await screen.findByRole("button", { name: "Retry original save" });
    const first = mocks.post.mock.calls[0]![1]; expect(screen.getByLabelText(/^Amount/)).toBeDisabled();
    q.unmount(); render(tree(kind, surface));
    await screen.findByRole("button", { name: "Retry original save" });
    await waitFor(() => expect(screen.getByLabelText(/^Description/)).toHaveValue("Synthetic purchase"));
    expect(screen.getByLabelText(/^Amount/)).toHaveValue(1234.56);
    mocks.post.mockResolvedValueOnce({ data: dto(kind) });
    await user.click(screen.getByRole("button", { name: "Retry original save" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2)); expect(mocks.post.mock.calls[1]![1]).toEqual(first);
  });

  it("does not repost a known successful save when clearing recovery fails", async () => {
    storage.failDelete(true); mocks.post.mockResolvedValueOnce({ data: dto(kind) });
    const { user, label } = await enter(kind, surface); await user.click(screen.getByRole("button", { name: label }));
    await screen.findByRole("button", { name: "Finish recovery" }); expect(mocks.post).toHaveBeenCalledTimes(1);
    storage.failDelete(false); await user.click(screen.getByRole("button", { name: "Finish recovery" }));
    await waitFor(() => expect(surface === "page" ? mocks.navigate : mocks.saved).toHaveBeenCalled()); expect(mocks.post).toHaveBeenCalledTimes(1);
  });
});

it("does not turn a confirmed expense into a failed save when optional celebration lookup fails", async () => {
  mocks.post.mockResolvedValueOnce({ data: dto() }); mocks.get.mockRejectedValueOnce(new Error("Optional lookup unavailable"));
  const { user, label } = await enter("expense", "page"); await user.click(screen.getByRole("button", { name: label }));
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/records"));
  expect(mocks.post).toHaveBeenCalledTimes(1); expect(await readPendingManualCreate(scope)).toBeNull();
});

it("suppresses a late success when the authenticated owner changes", async () => {
  let finish!: (value: unknown) => void; mocks.post.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const { user, q, label } = await enter("sales", "page"); await user.click(screen.getByRole("button", { name: label }));
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1)); mocks.ownerId = 18; q.rerender(tree("sales", "page"));
  await act(async () => finish({ data: dto("sales") })); expect(mocks.navigate).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByLabelText(/^Amount/)).toHaveValue(null));
});

async function deletedRecordUndo() {
  const record = { ...dto(), id: 7, categoryId: 10, date: "2026-10-10T00:00:00.000Z", source: "MANUAL_ENTRY", reviewStatus: "Reviewed", duplicateStatus: "Not a Duplicate", vendor: "Synthetic supplier" };
  mocks.get.mockImplementation(async (path: string) => ({ data: path === "/records/search" ? { items: [record], nextCursor: null } : path === "/records/flagged/count" ? { expenses: 0, sales: 0, total: 0 } : { items: [] } }));
  const q = render(<MemoryRouter><Records /></MemoryRouter>);
  await screen.findByRole("button", { name: "Delete Synthetic purchase" });
  await userEvent.click(screen.getByRole("button", { name: "Delete Synthetic purchase" }));
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("Record deleted", expect.objectContaining({ actionLabel: "Undo" })));
  const undo = mocks.toast.mock.calls.find((call) => call[0] === "Record deleted")![1].onAction as () => void;
  return { q, undo };
}

it("serializes Undo taps and preserves the same request after a lost restore response", async () => {
  let fail!: (error: Error) => void;
  mocks.post.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
  const { undo } = await deletedRecordUndo();
  await act(async () => { undo(); undo(); });
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
  const first = mocks.post.mock.calls[0]![1];
  await act(async () => fail(new Error("Lost restore response")));
  await screen.findByText(/Lost restore response/);
  mocks.post.mockResolvedValueOnce({ data: dto() }); await act(async () => undo());
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2)); expect(mocks.post.mock.calls[1]![1]).toEqual(first);
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("Record restored"));
  await act(async () => undo()); expect(mocks.post).toHaveBeenCalledTimes(2);
});

it("does not create another restored record when the refresh after Undo fails", async () => {
  const { undo } = await deletedRecordUndo(); mocks.post.mockResolvedValueOnce({ data: dto() });
  mocks.get.mockRejectedValue(new Error("List refresh unavailable"));
  await act(async () => undo()); await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("Record restored"));
  await act(async () => undo()); expect(mocks.post).toHaveBeenCalledTimes(1); expect(await readPendingManualCreate(scope)).toBeNull();
});

it("retains Undo recovery after leaving Records and restores it in the Add expense form", async () => {
  const { q, undo } = await deletedRecordUndo(); mocks.post.mockRejectedValueOnce(new Error("Lost restore response"));
  await act(async () => undo()); await screen.findByText(/Lost restore response/);
  const original = mocks.post.mock.calls[0]![1]; q.unmount(); render(tree("expense", "page"));
  await screen.findByRole("button", { name: "Retry original save" });
  await waitFor(() => expect(screen.getByLabelText(/^Description/)).toHaveValue("Synthetic purchase"));
  mocks.post.mockResolvedValueOnce({ data: dto() }); await userEvent.click(screen.getByRole("button", { name: "Retry original save" }));
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2)); expect(mocks.post.mock.calls[1]![1]).toEqual(original);
});

it("refuses a stale Undo action after changing owners", async () => {
  const { q, undo } = await deletedRecordUndo(); mocks.ownerId = 18; q.rerender(<MemoryRouter><Records /></MemoryRouter>);
  await act(async () => undo()); expect(mocks.post).not.toHaveBeenCalled();
});

async function deleteProfile() {
  const q = render(<MemoryRouter><Profile /></MemoryRouter>);
  await userEvent.click(screen.getByRole("button", { name: "Delete account" }));
  fireEvent.change(await screen.findByLabelText(/^Current password/), { target: { value: "synthetic-password" } });
  await userEvent.click(screen.getByRole("button", { name: "Delete my account" }));
  return q;
}

it("keeps account deletion confirmed when local cleanup fails, signs out, and retries cleanup without another DELETE", async () => {
  mocks.post.mockRejectedValueOnce(new Error("Lost response")); await expect(performManualRecordCreate(scope, payload, options())).rejects.toThrow();
  storage.failDelete(true); await deleteProfile();
  await waitFor(() => expect(mocks.logout).toHaveBeenCalledTimes(1));
  expect(mocks.remove).toHaveBeenCalledTimes(1); expect(mocks.remove.mock.calls[0]![0]).toBe("/auth/me");
  expect(mocks.toast).toHaveBeenCalledWith("Your account is deleted. This browser could not clear its saved recovery.");
  expect(screen.getByLabelText(/^Current password/)).toBeDisabled();
  storage.failDelete(false); await userEvent.click(screen.getByRole("button", { name: "Finish sign out" }));
  await waitFor(() => expect(mocks.logout).toHaveBeenCalledTimes(2));
  expect(mocks.remove).toHaveBeenCalledTimes(1); expect(mocks.confirm).toHaveBeenCalledTimes(1);
  expect(await readPendingManualCreate(scope)).toBeNull(); expect(storage.values.get("deleted-owner:17")).toBe(true);
});

it("retries only sign-out and local cleanup after a confirmed deletion followed by sign-out failure", async () => {
  mocks.logout.mockRejectedValueOnce(new Error("Synthetic sign-out failure")); await deleteProfile();
  await screen.findByText(/This browser could not finish signing out/);
  expect(mocks.remove).toHaveBeenCalledTimes(1); expect(storage.values.get("deleted-owner:17")).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Finish sign out" }));
  await waitFor(() => expect(mocks.logout).toHaveBeenCalledTimes(2));
  expect(mocks.remove).toHaveBeenCalledTimes(1); expect(mocks.confirm).toHaveBeenCalledTimes(1);
});

it("does not delete or sign out a new owner after the original owner's delayed confirmation", async () => {
  let finish!: (confirmed: boolean) => void;
  mocks.confirm.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const q = await deleteProfile();
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
  mocks.ownerId = 18; beginServerStateSession(18); q.rerender(<MemoryRouter><Profile /></MemoryRouter>);
  await act(async () => finish(true));
  expect(mocks.remove).not.toHaveBeenCalled(); expect(mocks.logout).not.toHaveBeenCalled();
  expect(storage.values.has("deleted-owner:18")).toBe(false);
});
