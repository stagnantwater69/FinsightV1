import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { SelectInput, TextInput } from "./Field";
import { IconCheck, IconChevronDown } from "./icons";

/** Up to this many categories a native select is still quick to scan; past it the filter becomes searchable. */
export const SEARCHABLE_CATEGORY_THRESHOLD = 20;

interface CategoryOption {
  id: number;
  name: string;
}

interface Props {
  id: string;
  /** "" means every category, matching the records filter's URL value. */
  value: string;
  onChange: (categoryId: string) => void;
  categories: CategoryOption[];
  disabled?: boolean;
}

/**
 * The records Category filter. A short list keeps the plain select; a long one
 * turns into a type-to-filter combobox, because scrolling a select of sixty or
 * more names to find one is slow and impossible to search.
 */
export function CategoryFilter({ id, value, onChange, categories, disabled = false }: Props) {
  if (categories.length <= SEARCHABLE_CATEGORY_THRESHOLD) {
    return (
      <SelectInput
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="px-2 disabled:bg-paper-100 disabled:text-ink-400"
      >
        <option value="">All</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </SelectInput>
    );
  }
  return <SearchableCategoryFilter id={id} value={value} onChange={onChange} categories={categories} disabled={disabled} />;
}

function SearchableCategoryFilter({ id, value, onChange, categories, disabled }: Required<Props>) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = categories.find((category) => String(category.id) === value) ?? null;
  const needle = query.trim().toLowerCase();
  const matches = needle ? categories.filter((category) => category.name.toLowerCase().includes(needle)) : categories;
  // "All" stays reachable unless a search is narrowing the list.
  const options: Array<{ value: string; label: string }> = [
    ...(needle ? [] : [{ value: "", label: "All categories" }]),
    ...matches.map((category) => ({ value: String(category.id), label: category.name })),
  ];
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, open]);

  function openList() {
    const current = options.findIndex((option) => option.value === value);
    setActiveIndex(current === -1 ? 0 : current);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setQuery("");
  }

  function choose(next: string) {
    onChange(next);
    close();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      if (options.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => (index + step + options.length) % options.length);
    } else if (open && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? 0 : Math.max(options.length - 1, 0));
    } else if (event.key === "Enter") {
      if (!open) return;
      event.preventDefault();
      const option = options[activeIndex];
      if (option) choose(option.value);
    } else if (event.key === "Escape") {
      if (!open) return;
      event.preventDefault();
      close();
    } else if (event.key === "Tab") {
      if (open) close();
    }
  }

  const active = open ? options[activeIndex] : undefined;
  return (
    <div className="relative">
      <TextInput
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={active ? optionId(activeIndex) : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        placeholder="All categories"
        value={open ? query : selected?.name ?? ""}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
          setOpen(true);
        }}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKeyDown}
        onBlur={close}
        className="pl-2 pr-8 disabled:bg-paper-100 disabled:text-ink-400"
      />
      <IconChevronDown
        aria-hidden
        className={`pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
      />
      <p role="status" className="sr-only">
        {open ? (needle ? `${matches.length} of ${categories.length} categories match` : `${categories.length} categories`) : ""}
      </p>
      {open ? (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 animate-pop-down overflow-hidden rounded-xl border border-paper-200 bg-paper shadow-lg">
          {options.length === 0 ? (
            <p className="px-3 py-3 text-sm text-ink-500">No categories match “{query.trim()}”.</p>
          ) : null}
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label="Categories"
            className="scroll-slim max-h-72 overflow-y-auto p-1"
          >
            {options.map((option, index) => {
              const isSelected = option.value === value;
              return (
                <li
                  key={option.value || "all"}
                  id={optionId(index)}
                  data-index={index}
                  role="option"
                  aria-selected={isSelected}
                  // Keeps focus in the input so the click is not lost to its blur.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(option.value)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`flex min-h-tap cursor-pointer items-center gap-2 rounded-lg px-2.5 text-sm transition ${
                    index === activeIndex ? "bg-tint-brand text-tone-brand" : "text-ink-800"
                  } ${isSelected ? "font-semibold" : ""}`}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {isSelected ? <IconCheck aria-hidden className="h-4 w-4 shrink-0 text-tone-brand" /> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
