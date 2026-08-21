const fs = require('fs');
const path = require('path');

// Deterministic generator so the test dataset can be reproduced exactly.
let seed = 240801;
function random() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}
const pick = (values) => values[Math.floor(random() * values.length)];
const integer = (min, max) => Math.floor(random() * (max - min + 1)) + min;
const money = (value) => Number(value).toFixed(2);
const pad = (value, size = 2) => String(value).padStart(size, '0');
const iso = (date) => date.toISOString().slice(0, 10);

const products = [
  ['Beverage', 'Americano', 110],
  ['Beverage', 'Latte', 145],
  ['Beverage', 'Cappuccino', 140],
  ['Beverage', 'Mocha', 155],
  ['Beverage', 'Spanish Latte', 160],
  ['Beverage', 'Cold Brew', 145],
  ['Beverage', 'Caramel Frappe', 175],
  ['Beverage', 'Mocha Frappe', 180],
  ['Beverage', 'Matcha Frappe', 180],
  ['Beverage', 'Iced Tea', 95],
  ['Beverage', 'Hot Tea', 90],
  ['Food', 'Butter Croissant', 95],
  ['Food', 'Chocolate Muffin', 90],
  ['Food', 'Cinnamon Roll', 105],
  ['Food', 'Ham and Cheese Sandwich', 165],
  ['Food', 'Chicken Pesto Sandwich', 175],
  ['Food', 'Chocolate Cake Slice', 150],
  ['Food', 'Carrot Cake Slice', 155]
];
const payments = ['Cash', 'Cash', 'Cash', 'GCash', 'GCash', 'Maya', 'Credit Card', 'Debit Card'];
const namedCustomers = ['Walk-in Customer', 'Walk-in Customer', 'Walk-in Customer', 'Office Order', 'Student Customer', 'Regular Customer'];
const rows = [];
let order = 0;
const saleCounters = new Map();
const expenseCounters = new Map();

function add(date, type, category, description, quantity, unitPrice, payment, party, notes, forcedRef) {
  const key = iso(date).replaceAll('-', '');
  const counters = type === 'Sale' ? saleCounters : expenseCounters;
  const prefix = type === 'Sale' ? 'SAL' : 'EXP';
  const count = (counters.get(key) || 0) + 1;
  counters.set(key, count);
  rows.push({
    Date: iso(date),
    'Transaction Type': type,
    Category: category,
    'Item or Description': description,
    Quantity: quantity,
    'Unit Price': money(unitPrice),
    'Total Amount': money(quantity * unitPrice),
    'Payment Method': payment,
    'Supplier or Customer': party,
    'Reference Number': forcedRef || `${prefix}-${key}-${pad(count, 3)}`,
    Notes: notes,
    _order: order++
  });
}

function saleWeight(product, month) {
  const name = product[1];
  let weight = product[0] === 'Beverage' ? 7 : 3;
  if ((month >= 2 && month <= 4) && (name.includes('Cold') || name.includes('Frappe') || name === 'Iced Tea')) weight += 5;
  if ((month >= 5 && month <= 9) && (name === 'Hot Tea' || name === 'Cappuccino')) weight += 2;
  if (name === 'Latte' || name === 'Spanish Latte') weight += 4;
  return weight;
}

function weightedProduct(month) {
  const total = products.reduce((sum, product) => sum + saleWeight(product, month), 0);
  let cursor = random() * total;
  for (const product of products) {
    cursor -= saleWeight(product, month);
    if (cursor <= 0) return product;
  }
  return products[0];
}

const holidays = new Set([
  '2024-08-26', '2024-11-01', '2024-11-30', '2024-12-08', '2024-12-24', '2024-12-25', '2024-12-30', '2024-12-31',
  '2025-01-01', '2025-04-09', '2025-04-17', '2025-04-18', '2025-05-01', '2025-06-12', '2025-08-21', '2025-08-25',
  '2025-11-01', '2025-11-30', '2025-12-08', '2025-12-24', '2025-12-25', '2025-12-30', '2025-12-31',
  '2026-01-01', '2026-04-02', '2026-04-03', '2026-04-09', '2026-05-01', '2026-06-12'
]);
const start = new Date(Date.UTC(2024, 7, 1));
const end = new Date(Date.UTC(2026, 6, 31));

for (let date = new Date(start); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
  const day = date.getUTCDay();
  const month = date.getUTCMonth();
  const dateText = iso(date);
  const weekend = day === 0 || day === 6;
  let tickets = weekend ? integer(31, 42) : integer(20, 28);
  if (month === 11) tickets += integer(7, 13);
  if (holidays.has(dateText)) tickets += integer(8, 16);
  if (month >= 5 && month <= 9 && random() < 0.32) tickets -= integer(4, 8);
  if (['2024-12-14', '2025-02-14', '2025-12-13', '2026-02-14'].includes(dateText)) tickets += 35;
  tickets = Math.max(12, tickets);

  for (let i = 0; i < tickets; i++) {
    const [category, item, basePrice] = weightedProduct(month);
    const quantity = random() < 0.78 ? 1 : random() < 0.94 ? 2 : integer(3, 6);
    const highSale = quantity >= 3;
    const party = highSale && random() < 0.45 ? pick(['Office Order', 'Event Customer', 'Corporate Customer']) : pick(namedCustomers);
    add(date, 'Sale', category, item, quantity, basePrice, pick(payments), party, highSale ? 'Group or bulk order' : 'Regular sale');
  }

  const dom = date.getUTCDate();
  if ([3, 10, 17, 24].includes(dom)) {
    const inventory = pick([
      ['Coffee Beans 5kg', 1, integer(3150, 3500), 'Batangas Coffee Roasters'],
      ['Fresh Milk 12L', integer(2, 4), 1080, 'Local Dairy Distributor'],
      ['Flavor Syrups 750ml', integer(4, 8), 420, 'Cafe Essentials PH'],
      ['Sugar 25kg', 1, integer(1450, 1650), 'Metro Wholesale Mart'],
      ['Pastry Ingredients Assortment', 1, integer(2400, 3900), 'Bakers Supply Depot']
    ]);
    add(date, 'Expense', 'Inventory', inventory[0], inventory[1], inventory[2], 'Bank Transfer', inventory[3], 'Scheduled inventory replenishment');
  }
  if ([6, 20].includes(dom)) {
    const supplies = pick([
      ['Paper Cups and Lids - 500 sets', 1, integer(2600, 3100), 'PackRight Philippines'],
      ['Paper Straws - 1000 pieces', 1, integer(850, 1050), 'EcoServe Packaging'],
      ['Takeout Packaging Assortment', 1, integer(1800, 2600), 'PackRight Philippines'],
      ['Cleaning Supplies Bundle', 1, integer(950, 1450), 'CleanPro Trading']
    ]);
    add(date, 'Expense', 'Supplies', supplies[0], supplies[1], supplies[2], pick(['Cash', 'GCash', 'Bank Transfer']), supplies[3], 'Operating supplies restock');
  }
  if (dom === 1) add(date, 'Expense', 'Rent', 'Monthly Shop Rent', 1, 28000, 'Bank Transfer', 'Mabini Commercial Leasing', `Rent for ${dateText.slice(0, 7)}`);
  if (dom === 5) add(date, 'Expense', 'Utilities', 'Internet Service', 1, 1699, 'Bank Transfer', 'PLDT', 'Monthly fiber internet bill');
  if (dom === 12) add(date, 'Expense', 'Utilities', 'Electricity Bill', 1, integer(month >= 2 && month <= 4 ? 10500 : 7600, month >= 2 && month <= 4 ? 14200 : 11200), 'Bank Transfer', 'Meralco', 'Monthly electricity bill');
  if (dom === 14) add(date, 'Expense', 'Utilities', 'Water Bill', 1, integer(1450, 2450), 'GCash', 'Manila Water', 'Monthly water bill');
  const tomorrow = new Date(date);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const isMonthEnd = tomorrow.getUTCMonth() !== month;
  if (dom === 15 || isMonthEnd) add(date, 'Expense', 'Payroll', 'Employee Wages', 1, integer(26500, 29200), 'Bank Transfer', 'Coffee Shop Staff', dom === 15 ? 'First-half payroll' : 'Second-half payroll');
  if (dom === 8 && random() < 0.7) add(date, 'Expense', 'Delivery', 'Supplier Delivery Fees', integer(2, 5), integer(180, 280), 'Cash', 'Third-party Courier', 'Multiple supplier deliveries');
  if (dom === 18 && random() < 0.65) add(date, 'Expense', 'Marketing', pick(['Social Media Ads', 'Printed Flyers', 'Loyalty Card Promotion']), 1, integer(1200, 4500), pick(['GCash', 'Credit Card']), pick(['Meta Philippines', 'Local Print Shop', 'PromoWorks PH']), 'Monthly promotional activity');
  if (dom === 27 && random() < 0.55) add(date, 'Expense', 'Miscellaneous', pick(['Staff Meals', 'Small Kitchen Tools', 'Transport Reimbursement', 'Pest Control']), 1, integer(500, 2300), 'Cash', pick(['Local Vendor', 'Petty Cash Vendor', 'Service Provider']), 'Routine operating expense');
}

const specialExpenses = [
  ['2024-10-09', 'Maintenance', 'Espresso Machine Preventive Service', 6500, 'CoffeeTech Services', 'Quarterly preventive maintenance'],
  ['2024-11-18', 'Government Fees', 'Barangay and Sanitary Permits', 4200, 'City Government', 'Annual permit-related fees'],
  ['2025-01-20', 'Government Fees', 'Business Permit Renewal', 12800, 'City Government', 'Annual business permit renewal'],
  ['2025-03-07', 'Equipment', 'Commercial Blender Replacement', 18500, 'KitchenPro Philippines', 'Unexpected blender failure'],
  ['2025-06-22', 'Maintenance', 'Air-conditioner Repair', 9800, 'CoolAir Services', 'Unexpected cooling system repair'],
  ['2025-09-11', 'Maintenance', 'Espresso Machine Pump Repair', 23500, 'CoffeeTech Services', 'Unusually high emergency repair'],
  ['2025-11-18', 'Government Fees', 'Barangay and Sanitary Permits', 4500, 'City Government', 'Annual permit-related fees'],
  ['2026-01-20', 'Government Fees', 'Business Permit Renewal', 13600, 'City Government', 'Annual business permit renewal'],
  ['2026-03-16', 'Equipment', 'Under-counter Chiller', 48500, 'KitchenPro Philippines', 'Unusually high equipment replacement'],
  ['2026-05-23', 'Maintenance', 'Plumbing Emergency Repair', 11750, 'RapidFix Plumbing', 'Unexpected pipe leak repair']
];
for (const [dateText, category, item, amount, supplier, notes] of specialExpenses) {
  add(new Date(`${dateText}T00:00:00Z`), 'Expense', category, item, 1, amount, 'Bank Transfer', supplier, notes);
}

rows.sort((a, b) => a.Date.localeCompare(b.Date) || a._order - b._order);

// Exact repeated rows are intentional test fixtures for duplicate detection.
const duplicateIndexes = [157, 611, 1044, 1688, 2250, 2961, 3577, 4210, 4899, 5525, 6170, 6834];
const duplicates = duplicateIndexes.filter((i) => i < rows.length).map((i) => ({ ...rows[i], _order: rows[i]._order + 0.1 }));
rows.push(...duplicates);
rows.sort((a, b) => a.Date.localeCompare(b.Date) || a._order - b._order);

const headers = ['Date', 'Transaction Type', 'Category', 'Item or Description', 'Quantity', 'Unit Price', 'Total Amount', 'Payment Method', 'Supplier or Customer', 'Reference Number', 'Notes'];
function csvCell(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
const csv = [headers.join(','), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(','))].join('\n') + '\n';
const output = path.resolve(__dirname, '..', 'philippines_coffee_shop_2_year_transactions.csv');
fs.writeFileSync(output, csv, 'utf8');
console.log(JSON.stringify({ output, records: rows.length, duplicates: duplicates.length, firstDate: rows[0].Date, lastDate: rows.at(-1).Date }));
