// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { FaqAccordion } from "./FaqAccordion";

describe("landing FAQ", () => {
  it("opens the first answer and keeps collapsed answers out of the accessibility tree", () => {
    render(<MemoryRouter><FaqAccordion /></MemoryRouter>);
    const faq = within(screen.getByRole("region", { name: "Frequently Asked Questions" }));

    const [first, ...collapsed] = screen.getAllByRole("button");
    expect(first).toHaveAttribute("aria-expanded", "true");
    const answer = screen.getByRole("region", { name: first.textContent ?? "" });
    expect(first).toHaveAttribute("aria-controls", answer.id);
    expect(answer).toHaveAttribute("aria-labelledby", first.id);
    expect(answer).toBeVisible();
    expect(faq.getAllByRole("region")).toHaveLength(1);
    for (const question of collapsed) {
      expect(question).toHaveAttribute("aria-expanded", "false");
    }
    expect(screen.getByRole("link", { name: "See all FAQs" })).toHaveAttribute("href", "/faqs");
  });

  it("lets the keyboard open another answer and collapse it again", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><FaqAccordion /></MemoryRouter>);
    const faq = within(screen.getByRole("region", { name: "Frequently Asked Questions" }));

    const [first, second] = screen.getAllByRole("button");
    second.focus();
    await user.keyboard("{Enter}");
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute("aria-expanded", "true");
    expect(first).toHaveAttribute("aria-expanded", "false");
    const answer = screen.getByRole("region", { name: second.textContent ?? "" });
    expect(second).toHaveAttribute("aria-controls", answer.id);
    expect(answer).toHaveAttribute("aria-labelledby", second.id);
    expect(faq.getAllByRole("region")).toHaveLength(1);

    await user.keyboard(" ");
    expect(second).toHaveAttribute("aria-expanded", "false");
    expect(faq.queryAllByRole("region")).toHaveLength(0);
  });
});
