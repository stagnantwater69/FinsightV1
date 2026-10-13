/**
 * The standard expense categories FinSight files receipt items under.
 *
 * BUSINESS FIRST. FinSight is a bookkeeping tool for small businesses, so the
 * list leads with what a business buys — stock, equipment, supplies, operating
 * costs — and keeps a separate, smaller set of personal categories for owners
 * who also track household spending. The two sets never share a name, which is
 * what keeps a personal purchase from being counted as a business cost.
 *
 * Each entry lists the names an owner may already use for the same thing
 * ("Stock", "Office Materials"), so FinSight files into THEIR category rather
 * than creating a near-duplicate beside it. A new category is created only
 * when nothing the business has matches, and only ever from this list: a name
 * made up per product ("Catsup") would fragment the books.
 */

export type ExpenseKind = "business" | "personal";

export type TaxonomyKey =
  // Business: inventory and products
  | "inventory" | "raw_materials" | "packaging_materials"
  // Business: equipment and assets
  | "equipment" | "office_equipment" | "furniture" | "electronics" | "tools" | "repairs"
  // Business: supplies
  | "office_supplies" | "store_supplies" | "cleaning_supplies" | "printing_supplies"
  // Business: operating expenses
  | "rent" | "electricity" | "water" | "telecom" | "transport" | "fuel" | "business_meals" | "advertising"
  | "software" | "professional_services" | "bank_fees" | "licenses" | "insurance" | "other_operating"
  // Business: employees and administration
  | "salaries" | "employee_benefits" | "training" | "office_admin"
  // Business: taxes and financial
  | "business_taxes" | "interest" | "other_financial"
  // Personal
  | "groceries" | "food_dining" | "personal_care" | "healthcare" | "clothing" | "personal_transport"
  | "entertainment" | "education" | "household" | "personal_bills" | "other_personal";

export interface TaxonomyCategory {
  key: TaxonomyKey;
  /** The name FinSight gives the category when it has to create it. */
  name: string;
  kind: ExpenseKind;
  group: string;
  /** Other names an owner may already use for the same category. */
  aliases: string[];
  /** Stored on a category FinSight creates, so the owner can see where it came from. */
  description: string;
}

const created = (what: string) => `${what} Added by FinSight from a scanned receipt.`;

export const EXPENSE_TAXONOMY: readonly TaxonomyCategory[] = [
  // ---- Business: inventory and products
  {
    key: "inventory", name: "Inventory / Stock", kind: "business", group: "Inventory and Products",
    aliases: ["Inventory", "Stock", "Stocks", "Inventory and Stock", "Stock Inventory", "Products for Resale", "Goods for Resale",
      "Resale", "Resale Items", "Merchandise", "Merchandise Inventory", "Store Stock", "Paninda", "Restock", "Restocking"],
    description: created("Goods bought to sell again."),
  },
  {
    key: "raw_materials", name: "Raw Materials", kind: "business", group: "Inventory and Products",
    aliases: ["Raw Material", "Ingredients", "Food Ingredients", "Production Materials", "Materials", "Farm Inputs", "Agricultural Inputs"],
    description: created("Ingredients and materials used to make what the business sells."),
  },
  {
    key: "packaging_materials", name: "Packaging Materials", kind: "business", group: "Inventory and Products",
    aliases: ["Packaging", "Packaging Supplies", "Shipping and Packaging Supplies", "Packing Materials", "Packaging and Containers",
      "Disposables", "Containers"],
    description: created("Bags, containers, cups and wrapping the business packs goods in."),
  },
  // ---- Business: equipment and assets
  {
    key: "equipment", name: "Equipment", kind: "business", group: "Equipment and Assets",
    aliases: ["Business Equipment", "Store Equipment", "Kitchen Equipment", "Appliances", "Equipment and Appliances"],
    description: created("Appliances and equipment the business uses."),
  },
  {
    key: "office_equipment", name: "Office Equipment", kind: "business", group: "Equipment and Assets",
    aliases: ["Office Equipments"],
    description: created("Printers, calculators and other office equipment."),
  },
  {
    key: "furniture", name: "Furniture and Fixtures", kind: "business", group: "Equipment and Assets",
    aliases: ["Furniture", "Fixtures", "Furnitures", "Furniture and Fixture"],
    description: created("Tables, chairs, shelves and fixtures."),
  },
  {
    key: "electronics", name: "Computers and Electronics", kind: "business", group: "Equipment and Assets",
    aliases: ["Computers", "Electronics", "Computer Equipment", "IT Equipment", "Gadgets"],
    description: created("Computers, phones and electronic devices."),
  },
  {
    key: "tools", name: "Tools and Machinery", kind: "business", group: "Equipment and Assets",
    aliases: ["Tools", "Machinery", "Machines", "Hardware", "Hardware and Tools", "Tools and Equipment"],
    description: created("Hand tools, hardware and machinery."),
  },
  {
    key: "repairs", name: "Maintenance and Repairs", kind: "business", group: "Equipment and Assets",
    aliases: ["Repairs", "Maintenance", "Repairs and Maintenance", "Repair and Maintenance"],
    description: created("Repairs, parts and upkeep."),
  },
  // ---- Business: supplies
  {
    key: "office_supplies", name: "Office Supplies", kind: "business", group: "Business Supplies",
    aliases: ["Office Supply", "Office Materials", "Stationery", "Office Stationery"],
    description: created("Paper, pens, folders and other office consumables."),
  },
  {
    key: "store_supplies", name: "Store Supplies", kind: "business", group: "Business Supplies",
    aliases: ["Shop Supplies", "Store Materials", "Supplies", "Operating Supplies", "Business Supplies"],
    description: created("Consumables the store uses to operate."),
  },
  {
    key: "cleaning_supplies", name: "Cleaning Supplies", kind: "business", group: "Business Supplies",
    aliases: ["Cleaning Materials", "Janitorial Supplies", "Sanitation Supplies", "Cleaning", "Cleaning and Sanitation"],
    description: created("Cleaning agents and sanitation supplies."),
  },
  {
    key: "printing_supplies", name: "Printing Supplies", kind: "business", group: "Business Supplies",
    aliases: ["Printing", "Printer Supplies", "Ink and Toner", "Printing and Reproduction"],
    description: created("Ink, toner and printing materials."),
  },
  // ---- Business: operating expenses
  {
    key: "rent", name: "Rent and Lease", kind: "business", group: "Operating Expenses",
    aliases: ["Rent", "Rental", "Lease", "Stall Rent", "Space Rental", "Rent Expense"],
    description: created("Rent for the business's space."),
  },
  {
    key: "electricity", name: "Electricity and Utilities", kind: "business", group: "Operating Expenses",
    aliases: ["Electricity", "Utilities", "Utility", "Electric Bill", "Power", "Utility Bills", "Light and Power"],
    description: created("Electricity and other utility bills."),
  },
  {
    key: "water", name: "Water Expenses", kind: "business", group: "Operating Expenses",
    aliases: ["Water", "Water Bill", "Water Utility"],
    description: created("Water bills and water supply."),
  },
  {
    key: "telecom", name: "Internet and Telecommunications", kind: "business", group: "Operating Expenses",
    aliases: ["Internet", "Telecommunications", "Telecom", "Communication", "Communications", "Phone and Internet", "Mobile Load",
      "Phone Load", "Internet and Phone"],
    description: created("Internet, phone plans and mobile load."),
  },
  {
    key: "transport", name: "Transportation and Delivery", kind: "business", group: "Operating Expenses",
    aliases: ["Transportation", "Transport", "Delivery", "Delivery Fees", "Shipping", "Freight", "Courier", "Logistics",
      "Transportation Expense"],
    description: created("Delivery, shipping and business trips."),
  },
  {
    key: "fuel", name: "Fuel", kind: "business", group: "Operating Expenses",
    aliases: ["Gasoline", "Gas", "Diesel", "Fuel and Oil", "Fuel Expense"],
    description: created("Fuel for business vehicles and equipment."),
  },
  {
    key: "business_meals", name: "Business Meals", kind: "business", group: "Operating Expenses",
    aliases: ["Meals", "Meals and Entertainment", "Representation", "Representation Expense"],
    description: created("Meals bought for the business."),
  },
  {
    key: "advertising", name: "Advertising and Marketing", kind: "business", group: "Operating Expenses",
    aliases: ["Advertising", "Marketing", "Ads", "Promotions", "Advertisement"],
    description: created("Ads, signage and promotion."),
  },
  {
    key: "software", name: "Software and Subscriptions", kind: "business", group: "Operating Expenses",
    aliases: ["Software", "Subscriptions", "Subscription", "Apps"],
    description: created("Software and online subscriptions."),
  },
  {
    key: "professional_services", name: "Professional Services", kind: "business", group: "Operating Expenses",
    aliases: ["Professional Fees", "Consultancy", "Consulting", "Legal Fees", "Accounting Fees"],
    description: created("Accountants, lawyers and consultants."),
  },
  {
    key: "bank_fees", name: "Bank and Transaction Fees", kind: "business", group: "Operating Expenses",
    aliases: ["Bank Charges", "Bank Fees", "Transaction Fees", "Service Charges", "Fees and Charges"],
    description: created("Bank, transfer and payment fees."),
  },
  {
    key: "licenses", name: "Licenses and Permits", kind: "business", group: "Operating Expenses",
    aliases: ["Permits", "Licenses", "Permits and Licenses", "Business Permit", "Business Permits", "Registration", "Registration Fees"],
    description: created("Business permits, licences and registrations."),
  },
  {
    key: "insurance", name: "Insurance", kind: "business", group: "Operating Expenses",
    aliases: ["Insurance Expense", "Business Insurance"],
    description: created("Insurance premiums."),
  },
  {
    key: "other_operating", name: "Other Operating Expenses", kind: "business", group: "Operating Expenses",
    aliases: ["Operating Expenses", "Other Expenses", "Miscellaneous", "Misc", "Miscellaneous Expenses", "Others", "Sundry"],
    description: created("Business costs no other category fits."),
  },
  // ---- Business: employees and administration
  {
    key: "salaries", name: "Salaries and Wages", kind: "business", group: "Employee and Administrative Expenses",
    aliases: ["Salaries", "Wages", "Salary", "Payroll", "Labor", "Labour"],
    description: created("Pay for staff."),
  },
  {
    key: "employee_benefits", name: "Employee Benefits", kind: "business", group: "Employee and Administrative Expenses",
    aliases: ["Benefits", "Staff Benefits", "Contributions"],
    description: created("Staff benefits and government contributions."),
  },
  {
    key: "training", name: "Training and Development", kind: "business", group: "Employee and Administrative Expenses",
    aliases: ["Training", "Seminars", "Trainings"],
    description: created("Courses and training for the business."),
  },
  {
    key: "office_admin", name: "Office Administration", kind: "business", group: "Employee and Administrative Expenses",
    aliases: ["Administrative Expenses", "Admin", "Administration", "General and Administrative"],
    description: created("General office administration."),
  },
  // ---- Business: taxes and financial
  {
    key: "business_taxes", name: "Business Taxes", kind: "business", group: "Taxes and Financial Expenses",
    aliases: ["Taxes", "Tax", "Taxes and Licenses"],
    description: created("Taxes the business pays."),
  },
  {
    key: "interest", name: "Interest Expenses", kind: "business", group: "Taxes and Financial Expenses",
    aliases: ["Interest", "Loan Interest", "Interest Expense"],
    description: created("Interest on business loans."),
  },
  {
    key: "other_financial", name: "Other Financial Expenses", kind: "business", group: "Taxes and Financial Expenses",
    aliases: ["Financial Expenses", "Finance Charges"],
    description: created("Other financial costs."),
  },
  // ---- Personal
  {
    key: "groceries", name: "Groceries", kind: "personal", group: "Personal",
    aliases: ["Grocery", "Food and Groceries", "Household Groceries", "Personal Groceries"],
    description: created("Personal: groceries for home."),
  },
  {
    key: "food_dining", name: "Food and Dining", kind: "personal", group: "Personal",
    aliases: ["Dining", "Dining Out", "Eating Out", "Restaurants", "Personal Meals"],
    description: created("Personal: meals and eating out."),
  },
  {
    key: "personal_care", name: "Personal Care", kind: "personal", group: "Personal",
    aliases: ["Toiletries", "Hygiene", "Personal Hygiene", "Grooming"],
    description: created("Personal: toiletries and grooming."),
  },
  {
    key: "healthcare", name: "Healthcare and Medicine", kind: "personal", group: "Personal",
    aliases: ["Healthcare", "Health", "Medicine", "Medicines", "Medical", "Pharmacy", "Health and Medicine"],
    description: created("Personal: medicine and health care."),
  },
  {
    key: "clothing", name: "Clothing and Accessories", kind: "personal", group: "Personal",
    aliases: ["Clothing", "Clothes", "Apparel", "Accessories"],
    description: created("Personal: clothes and accessories."),
  },
  {
    key: "personal_transport", name: "Personal Transportation", kind: "personal", group: "Personal",
    aliases: ["Commute", "Fare", "Fares", "Personal Transport"],
    description: created("Personal: fares and personal travel."),
  },
  {
    key: "entertainment", name: "Entertainment", kind: "personal", group: "Personal",
    aliases: ["Leisure", "Recreation", "Hobbies"],
    description: created("Personal: leisure and entertainment."),
  },
  {
    key: "education", name: "Education", kind: "personal", group: "Personal",
    aliases: ["Tuition", "School", "School Expenses"],
    description: created("Personal: school and education."),
  },
  {
    key: "household", name: "Household Supplies", kind: "personal", group: "Personal",
    aliases: ["Household", "Home Supplies", "Household Items"],
    description: created("Personal: supplies for the home."),
  },
  {
    key: "personal_bills", name: "Personal Bills and Utilities", kind: "personal", group: "Personal",
    aliases: ["Home Utilities", "Household Bills", "Personal Utilities"],
    description: created("Personal: household bills."),
  },
  {
    key: "other_personal", name: "Other Personal Expenses", kind: "personal", group: "Personal",
    aliases: ["Personal", "Personal Expenses", "Personal Expense"],
    description: created("Personal: spending no other category fits."),
  },
];

const BY_KEY = new Map(EXPENSE_TAXONOMY.map((entry) => [entry.key, entry]));

export function taxonomyEntry(key: TaxonomyKey): TaxonomyCategory {
  return BY_KEY.get(key)!;
}

/**
 * A category name reduced to what makes it the same category: case, "&",
 * punctuation, word order and plural endings removed. "Office-Supplies",
 * "office supply" and "Supplies, Office" all come out the same.
 */
export function normaliseCategoryName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word && word !== "and")
    .map((word) => (word.length > 4 && word.endsWith("ies") ? `${word.slice(0, -3)}y` : word))
    .map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word))
    .sort()
    .join(" ");
}

const KEY_BY_NAME = new Map<string, TaxonomyKey>();
for (const entry of EXPENSE_TAXONOMY) {
  for (const name of [entry.name, ...entry.aliases]) {
    const normalised = normaliseCategoryName(name);
    if (!KEY_BY_NAME.has(normalised)) KEY_BY_NAME.set(normalised, entry.key);
  }
}

/** The standard category a name refers to — the owner's own naming included — or null. */
export function taxonomyKeyForName(name: string): TaxonomyKey | null {
  return KEY_BY_NAME.get(normaliseCategoryName(name)) ?? null;
}

/**
 * Whether a category holds business or personal spending.
 *
 * Read from the name, not stored: a standard personal category, or any
 * category the owner names as personal ("Personal Snacks"), is personal, and
 * everything else is business — the right default for a business tool, and
 * true of every category that existed before personal ones did.
 */
export function categoryKind(name: string): ExpenseKind {
  const key = taxonomyKeyForName(name);
  if (key) return taxonomyEntry(key).kind;
  return /\bpersonal\b/i.test(name) ? "personal" : "business";
}

/**
 * The owner's existing category for a standard one, if they have it under any
 * of its names. Uncategorized is never a match for anything. Where two of the
 * owner's categories answer to the same standard one, the one under the
 * standard name wins, then the first in the list the caller passes.
 */
export function findExistingCategory<T extends { name: string }>(categories: T[], key: TaxonomyKey): T | null {
  const matches = categories.filter((category) => taxonomyKeyForName(category.name) === key);
  const standard = normaliseCategoryName(taxonomyEntry(key).name);
  return matches.find((category) => normaliseCategoryName(category.name) === standard) ?? matches[0] ?? null;
}
