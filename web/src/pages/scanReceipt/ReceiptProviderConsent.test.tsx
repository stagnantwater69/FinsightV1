// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReceiptProviderConsent } from "./ReceiptProviderConsent";

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: mocks }));

const provider = {
  key: "gemini" as const,
  label: "Google Gemini",
  version: "gemini-3.5-flash-lite",
  region: "asia-southeast1",
  policyVersion: "receipt-provider-policy-v1",
  purpose: "RECEIPT_EXTRACTION" as const,
  dataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"] as const,
  retentionHours: 6,
  trainingAllowed: false as const,
  revocable: true as const,
};

const inactive = {
  available: true,
  provider,
  consent: null,
  activeConsents: [],
};

const previousConsent = {
  reference: "consent:12",
  provider: "veryfi",
  policyVersion: "receipt-provider-policy-legacy-v2",
  purpose: "RECEIPT_EXTRACTION" as const,
  dataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"] as const,
  region: "us-west-2",
  retentionHours: 12,
  trainingAllowed: false,
  grantedAt: "2026-09-12T00:00:00.000Z",
  revocable: true as const,
};

const active = {
  ...inactive,
  consent: { reference: "consent:14", grantedAt: "2026-09-13T08:00:00.000Z", revokedAt: null },
  activeConsents: [
    {
      reference: "consent:14",
      provider: "gemini",
      policyVersion: provider.policyVersion,
      purpose: provider.purpose,
      dataClasses: provider.dataClasses,
      region: provider.region,
      retentionHours: provider.retentionHours,
      trainingAllowed: provider.trainingAllowed,
      grantedAt: "2026-09-13T08:00:00.000Z",
      revocable: true as const,
    },
  ],
};

const unavailable = {
  available: false,
  provider: null,
  consent: null,
  activeConsents: [],
};

const revokeOnly = {
  ...unavailable,
  activeConsents: [previousConsent],
};

beforeEach(() => {
  mocks.get.mockReset();
  mocks.put.mockReset();
  mocks.delete.mockReset();
});

describe("receipt provider consent", () => {
  it("announces the optional settings load", () => {
    mocks.get.mockImplementation(() => new Promise(() => {}));
    render(<ReceiptProviderConsent businessProfileId={7} />);
    expect(screen.getByRole("status")).toHaveTextContent(/Checking optional receipt-processing settings/);
  });

  it("offers a non-blocking retry and recovers when settings load", async () => {
    const user = userEvent.setup();
    mocks.get.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ data: inactive });
    render(<ReceiptProviderConsent businessProfileId={7} />);

    await screen.findByRole("button", { name: "Retry optional settings" });
    expect(screen.getByRole("status")).toHaveTextContent(/Standard receipt scanning is still available/);
    expect(screen.queryByRole("heading", { name: /Optional help/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry optional settings" }));

    expect(await screen.findByRole("heading", { name: "Optional help for hard-to-read receipts" })).toBeVisible();
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it("stays fully hidden when the provider is unavailable and no permission remains", async () => {
    mocks.get.mockResolvedValue({ data: unavailable });
    const { container } = render(<ReceiptProviderConsent businessProfileId={7} />);

    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows every saved term without offering a grant when only revocation is available", async () => {
    mocks.get.mockResolvedValue({ data: revokeOnly });
    render(<ReceiptProviderConsent businessProfileId={7} />);

    expect(await screen.findByRole("heading", { name: "Previous receipt-image permission" })).toBeVisible();
    expect(screen.getByText("Veryfi")).toBeVisible();
    expect(screen.getByText("receipt-provider-policy-legacy-v2")).toBeVisible();
    expect(screen.getByText("The receipt photos you uploaded.")).toBeVisible();
    expect(screen.getByText(/Cropped or enhanced copies FinSight made/)).toBeVisible();
    expect(screen.getByText("Read the receipt date, merchant, total and item lines.")).toBeVisible();
    expect(screen.getByText("us-west-2")).toBeVisible();
    expect(screen.getByText("12 hours")).toBeVisible();
    expect(screen.getByText("Not allowed under these saved terms.")).toBeVisible();
    expect(screen.getByText("Yes, from this page.")).toBeVisible();
    expect(document.querySelector("time")).toHaveAttribute("datetime", previousConsent.grantedAt);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow outside receipt reading" })).not.toBeInTheDocument();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("revokes a previous permission and hides the unavailable setting", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue({ data: revokeOnly });
    mocks.delete.mockResolvedValue({ data: unavailable });
    render(<ReceiptProviderConsent businessProfileId={7} />);

    await user.click(await screen.findByRole("button", { name: "Revoke previous receipt-image permission" }));

    expect(mocks.delete).toHaveBeenCalledWith("/records/receipts/provider-consent/7");
    expect(await screen.findByRole("status")).toHaveTextContent("Receipt-image permission revoked.");
    expect(screen.queryByRole("heading", { name: /Previous receipt-image permission/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("keeps the saved terms and revoke action when revocation cannot be confirmed", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue({ data: revokeOnly });
    mocks.delete.mockRejectedValue(new Error("connection closed"));
    render(<ReceiptProviderConsent businessProfileId={7} />);

    await user.click(await screen.findByRole("button", { name: "Revoke previous receipt-image permission" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not confirm that permission was revoked/i);
    expect(screen.getByText("receipt-provider-policy-legacy-v2")).toBeVisible();
    expect(screen.getByRole("button", { name: "Revoke previous receipt-image permission" })).toBeEnabled();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("shows exact advertised terms and sends them only after deliberate consent", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue({ data: inactive });
    mocks.put.mockResolvedValue({ data: active });
    render(<ReceiptProviderConsent businessProfileId={7} />);

    await screen.findByRole("heading", { name: "Optional help for hard-to-read receipts" });
    expect(screen.getByText("Google Gemini")).toBeVisible();
    expect(screen.getByText("The receipt photos you upload.")).toBeVisible();
    expect(screen.getByText(/Cropped or enhanced copies/)).toBeVisible();
    expect(screen.getByText(/Read the receipt date, merchant, total and item lines/)).toBeVisible();
    expect(screen.getByText("asia-southeast1")).toBeVisible();
    expect(screen.getByText("6 hours")).toBeVisible();
    expect(screen.getByText("Not allowed under these terms.")).toBeVisible();

    const checkbox = screen.getByRole("checkbox");
    const allow = screen.getByRole("button", { name: "Allow outside receipt reading" });
    expect(checkbox).not.toBeChecked();
    expect(allow).toBeDisabled();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    await user.click(checkbox);
    await user.click(allow);

    expect(mocks.put).toHaveBeenCalledWith("/records/receipts/provider-consent/7", {
      provider: "gemini",
      policyVersion: "receipt-provider-policy-v1",
      purpose: "RECEIPT_EXTRACTION",
      dataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"],
      region: "asia-southeast1",
      retentionHours: 6,
      trainingAllowed: false,
    });
    expect(await screen.findByText("Permission saved for this business.")).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "Revoke receipt-image permission" })).toBeEnabled();
  });

  it("revokes permission and returns to the unchecked state", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue({ data: active });
    mocks.delete.mockResolvedValue({ data: inactive });
    render(<ReceiptProviderConsent businessProfileId={7} />);

    await user.click(await screen.findByRole("button", { name: "Revoke receipt-image permission" }));

    expect(mocks.delete).toHaveBeenCalledWith("/records/receipts/provider-consent/7");
    expect(await screen.findByText("Receipt-image permission revoked.")).toHaveAttribute("role", "status");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("reports an ambiguous permission write without blocking the standard scanner", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue({ data: inactive });
    mocks.put.mockRejectedValue(new Error("connection closed"));
    render(<ReceiptProviderConsent businessProfileId={7} />);

    const checkbox = await screen.findByRole("checkbox");
    await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: "Allow outside receipt reading" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not confirm that permission was saved/i);
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("disables every permission action while receipt scanning is in progress", async () => {
    mocks.get.mockResolvedValue({ data: active });
    render(<ReceiptProviderConsent businessProfileId={7} disabled />);

    expect(await screen.findByRole("button", { name: "Revoke receipt-image permission" })).toBeDisabled();
  });
});
