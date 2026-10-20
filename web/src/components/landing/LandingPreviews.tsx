import {
  ArrowRight, CalendarDays, Camera, ChevronDown, FileText, ReceiptText, Wallet,
} from "lucide-react";
import { Money } from "../Money";
import { IconBusiness, IconDashboard, IconInsights, IconProfile, IconRecords } from "../icons";
import { MobileDashboardPreview } from "./MobileDashboardPreview";
import "./landing-preview.css";

type PreviewProps = { compact?: boolean };

const SALES = [1800, 2600, 2100, 4700, 2400, 3500, 1800, 2900, 1900, 2200, 3100, 2400, 4200, 2100, 3500, 2400, 1900, 3200, 2200, 4100, 1900, 3600, 1800, 2400, 2100, 3600, 2600, 4800, 2300, 2400, 2000];
const EXPENSES = [1300, 1700, 1400, 1900, 1800, 1600, 1500, 1900, 1400, 1700, 2400, 1800, 1600, 1500, 2100, 1800, 1600, 2300, 1300, 2100, 1500, 2200, 1300, 1700, 1600, 2300, 1900, 2400, 1800, 2500, 2300];

const PREVIEW_NAV = [
  { heading: "Overview", items: [{ label: "Dashboard", icon: IconDashboard }, { label: "Records", icon: IconRecords }] },
  { heading: "Insights", items: [{ label: "Insights", icon: IconInsights }] },
  { heading: "Management", items: [{ label: "Business profile", icon: IconBusiness }] },
  { heading: "Account", items: [{ label: "My profile", icon: IconProfile }] },
];

function SalesChart() {
  return (
    <div className="lp-chart">
      <div className="lp-chart-heading"><strong>Sales vs Expenses</strong><div className="lp-chart-legend"><span><i />Sales</span><span><i />Expenses</span></div></div>
      <svg viewBox="0 0 600 172" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        {[0, 1, 2, 3].map((step) => (
          <g key={step}>
            <line x1="34" x2="596" y1={18 + step * 42} y2={18 + step * 42} stroke="#e9efed" />
            <text x="25" y={21 + step * 42} textAnchor="end" fill="#526a63" fontSize="10">{step === 3 ? "0" : `${6 - step * 2}K`}</text>
          </g>
        ))}
        {SALES.map((value, index) => (
          <g key={index}>
            <rect x={38 + index * 18} y={144 - value / 6000 * 126} width="6.5" height={value / 6000 * 126} rx="1.2" fill="#168168" />
            <rect x={45.5 + index * 18} y={144 - EXPENSES[index]! / 6000 * 126} width="6.5" height={EXPENSES[index]! / 6000 * 126} rx="1.2" fill="#b3e4d2" />
          </g>
        ))}
        {[0, 6, 13, 20, 27].map((day) => (
          <text key={day} x={45 + day * 18} y="165" fill="#526a63" fontSize="10" textAnchor={day ? "middle" : "start"}>Oct {day + 1}</text>
        ))}
      </svg>
    </div>
  );
}

export function CashflowPreview() {
  return (
    <img
      src="/landing/dashboard-cashflow.webp"
      alt="FinSight cash flow chart with sample data for May through October 2026: money in PHP 442,500, money out PHP 307,700, and net PHP 134,800. Bars compare money in and out; a line shows net."
      width={1658}
      height={702}
      loading="lazy"
      className="lp-cashflow-image"
    />
  );
}

export function DashboardPreview({ compact = false }: PreviewProps) {
  return (
    <div className={`lp-dashboard lp-light ${compact ? "lp-dashboard-compact" : ""}`} role="img" aria-label="FinSight dashboard concept with the app's navigation. Illustrative October records: sales PHP 84,500, expenses PHP 56,200, and balance PHP 28,300. A daily chart compares sales and expenses, with recent records below.">
      <div className="lp-dashboard-shell" aria-hidden="true">
        {!compact && <div className="lp-sidebar">
          <div className="lp-brand"><img src="/newmascotlogo.png" alt="" width={35} height={35} /><span>Fin<span>Sight</span></span></div>
          <div className="lp-business"><IconBusiness /><div><strong>Sample Store</strong><small><i />Active business</small></div><ChevronDown /></div>
          <div className="lp-side-groups">
            {PREVIEW_NAV.map(({ heading, items }) => <div key={heading} className="lp-nav-group">
              <span className="lp-nav-heading">{heading}</span>
              {items.map(({ label, icon: Icon }) => <div className={`lp-nav-item ${label === "Dashboard" ? "lp-nav-active" : ""}`} key={label}><Icon /><span>{label}</span>{label === "Insights" && <ChevronDown />}</div>)}
            </div>)}
          </div>
        </div>}
        <div className="lp-dashboard-content">
          <div className="lp-dashboard-heading"><strong>Your business at a glance</strong>{!compact && <span><CalendarDays />October 2026<ChevronDown /></span>}</div>
          <div className="lp-stat-grid">
            {[
              { label: "Sales", amount: 84500, icon: Camera },
              { label: "Expenses", amount: 56200, icon: ReceiptText },
              { label: "Balance", amount: 28300, icon: Wallet },
            ].map(({ label, amount, icon: Icon }) => <div className={`lp-stat lp-stat-${label.toLowerCase()}`} key={label}>
              <span className="lp-stat-icon"><Icon /></span>
              <div><span className="lp-stat-label">{label}</span><strong>₱<Money value={amount} bare /></strong>{!compact && <small>This month</small>}</div>
            </div>)}
          </div>
          <SalesChart />
          {!compact && <div className="lp-records">
            <div className="lp-records-heading"><strong>Recent records</strong><span>View all<ArrowRight /></span></div>
            {[
              { name: "Sample supplier", type: "Supplies", date: "Oct 12, 2026", amount: 1450 },
              { name: "Cash sales", type: "Sales", date: "Oct 11, 2026", amount: 3200 },
              { name: "Office warehouse", type: "Supplies", date: "Oct 10, 2026", amount: 980 },
              { name: "Market purchase", type: "Supplies", date: "Oct 9, 2026", amount: 2430 },
            ].map((record) => <div className="lp-record-row" key={record.name}><span><FileText />{record.name}</span><span>{record.type}</span><span>{record.date}</span><strong>₱<Money value={record.amount} bare decimals /></strong></div>)}
          </div>}
        </div>
      </div>
    </div>
  );
}

export function CrossDeviceDashboardPreview() {
  return (
    <div className="lp-cross-device-preview">
      <div className="lp-cross-device-web"><DashboardPreview /></div>
      <MobileDashboardPreview compact className="lp-cross-device-mobile" />
    </div>
  );
}

export function ReceiptPreview({ compact = false }: PreviewProps) {
  return (
    <div className={`lp-receipt-scene ${compact ? "lp-receipt-scene-compact" : ""}`} role="img" aria-label="Illustrative receipt from Sample supplier. Cleaning materials PHP 650, packaging box PHP 450, tape PHP 350. Total PHP 1,450, dated 12 October 2026.">
      <div className="lp-receipt-paper" aria-hidden="true">
        <strong>SAMPLE SUPPLIER</strong>
        <span>123 Rizal St.</span><span>Makati City</span>
        <span className="lp-receipt-example">SAMPLE RECEIPT</span>
        <div className="lp-receipt-items">
          <div><span>CLEANING MATERIALS</span><Money value={650} bare decimals /></div>
          <div><span>PACKAGING BOX</span><Money value={450} bare decimals /></div>
          <div><span>TAPE</span><Money value={350} bare decimals /></div>
        </div>
        <div className="lp-receipt-total"><span>TOTAL</span><strong>₱<Money value={1450} bare decimals /></strong></div>
        <div className="lp-receipt-cash"><span>CASH</span><span>PHP</span></div>
        <span className="lp-receipt-date">12 OCT 2026 · 10:24 AM</span>
        <strong className="lp-receipt-thanks">THANK YOU!</strong>
      </div>
    </div>
  );
}

export function ReceiptReviewPreview({ compact = false }: PreviewProps) {
  return (
    <div className={`lp-review lp-light ${compact ? "lp-review-compact" : ""}`} role="img" aria-label="Illustrative receipt review. Merchant: Sample supplier. Date: 12 October 2026. Amount: PHP 1,450. Category: Supplies. Check extracted details before confirming a record.">
      <div aria-hidden="true">
        <strong className="lp-review-heading"><span><FileText size={16} /></span>{compact ? "Review receipt" : "Check extracted details"}</strong>
        <dl>
          <div><dt>Merchant</dt><dd>Sample supplier</dd></div>
          <div><dt>Date</dt><dd>12 October 2026<CalendarDays size={12} /></dd></div>
          <div><dt>Amount</dt><dd>₱<Money value={1450} bare decimals /></dd></div>
          <div><dt>Category</dt><dd>Supplies<ChevronDown size={12} /></dd></div>
        </dl>
        {!compact && <div className="lp-confirm-label">Confirm record</div>}
      </div>
    </div>
  );
}

const COMPARE_RECORDS = [
  { name: "Sample supplier", type: "Supplies", date: "Oct 12", amount: -1450 },
  { name: "Cash sales", type: "Sales", date: "Oct 11", amount: 3200 },
  { name: "Office warehouse", type: "Supplies", date: "Oct 10", amount: -980 },
  { name: "Market purchase", type: "Supplies", date: "Oct 9", amount: -2430 },
];

/* The same four October records, first as an owner's notebook page, then as FinSight shows them. */
export function NotebookComparisonPreview() {
  return (
    <div className="lp-compare" role="img" aria-label="Illustrative comparison of one month's records. A handwritten notebook page lists a corrected market purchase of 2,430, a warehouse cost of 980 with a question mark, cash sales of 3,200, a supplier receipt marked as missing, and a monthly total marked as unknown. Next to it, FinSight shows October for Sample Store: money in PHP 84,500, money out PHP 56,200, PHP 28,300 left, and the same four records with their categories and dates.">
      <div className="lp-compare-notebook" aria-hidden="true">
        <span className="lp-compare-tag">Your notebook</span>
        <ul className="lp-notebook-lines">
          <li><span>Oct 9</span>market <s>2,340</s> 2,430</li>
          <li><span>Oct 10</span>warehouse 980?</li>
          <li><span>Oct 11</span>sales 3,200</li>
          <li><span>Oct 12</span>supplier, receipt where??</li>
          <li><span>Total</span>ask Ate later</li>
        </ul>
        <div className="lp-scrap lp-scrap-a"><strong>SAMPLE SUPPLIER</strong><span>TOTAL 1,450.00</span></div>
        <div className="lp-scrap lp-scrap-b"><strong>MARKET</strong><span>TOTAL 2,430.00</span></div>
      </div>
      <div className="lp-compare-app lp-light" aria-hidden="true">
        <span className="lp-compare-tag lp-compare-tag-app">FinSight</span>
        <strong className="lp-compare-heading">October so far</strong>
        <dl className="lp-compare-totals">
          <div><dt>Money in</dt><dd>₱<Money value={84500} bare /></dd></div>
          <div><dt>Money out</dt><dd>₱<Money value={56200} bare /></dd></div>
          <div className="lp-compare-left"><dt>Left</dt><dd>₱<Money value={28300} bare /></dd></div>
        </dl>
        <div className="lp-compare-records">
          {COMPARE_RECORDS.map(({ name, type, date, amount }) => (
            <div className="lp-compare-row" key={name}>
              <span><FileText />{name}<small>{type} · {date}</small></span>
              <strong className={amount > 0 ? "lp-compare-in" : undefined}>{amount > 0 ? "+" : "−"}₱<Money value={Math.abs(amount)} bare /></strong>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

