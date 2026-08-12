/**
 * Copy shared by the public pages.
 *
 * The FAQ list lives here rather than in Landing because two pages render it:
 * the landing page shows the first `LANDING_FAQ_COUNT`, and /faqs shows all of
 * them grouped. One source means the landing page can never quietly disagree
 * with the full page it links to.
 *
 * The help and legal copy joined it when the Android app grew its own Help
 * section, and the reason is the same one only more so. The panel's finding
 * was that most owners have a phone and no computer, which makes the app —
 * not this website — where they will actually read what FinSight does with
 * their records. Two hand-maintained copies of a privacy notice do not stay
 * identical, and the one an owner happens to read being the stale one is not
 * an acceptable outcome for that particular document.
 *
 * So the prose lives here as DATA, both platforms render it, and
 * `mobile/tests/helpContent.test.ts` fails if the mobile mirror drifts from
 * this file. See mobile/src/lib/helpContent.ts for why it is a mirror rather
 * than a shared import.
 */

export interface Faq {
  q: string;
  a: string;
  /** Grouping on the dedicated FAQ page. Ignored on the landing page. */
  topic: FaqTopic;
}

export const FAQ_TOPICS = ["Getting started", "Using FinSight", "Your data", "Cost and limits"] as const;
export type FaqTopic = (typeof FAQ_TOPICS)[number];

/**
 * Answered honestly, including where the answer is "no".
 *
 * The offline one especially: a landing page that pretends there are no limits
 * is one the owner stops believing the first time they hit one.
 */
export const FAQS: Faq[] = [
  {
    topic: "Getting started",
    q: "What is FinSight and who is it for?",
    a: "FinSight is a financial monitoring tool for small businesses — sari-sari stores, food stalls, small shops. It keeps the records you already keep, does the adding up, and tells you what the numbers mean while there is still time to act on them.",
  },
  {
    topic: "Getting started",
    q: "Do I need to know accounting to use it?",
    a: "No. There is no chart of accounts to set up and no bookkeeping terms to learn. You record what you spent and what you sold, in your own words, and FinSight organises it.",
  },
  {
    topic: "Getting started",
    q: "How do I start?",
    a: "Create a free account, add your business, and record about a week of expenses and sales. That is usually enough for the dashboard to start telling you something you did not already know.",
  },
  {
    topic: "Getting started",
    q: "Is it suitable for a business that is just starting?",
    a: "Yes. FinSight needs your own records and nothing else — no history to import and no minimum size. The insights get sharper as more weeks build up, but it is useful from the first month.",
  },
  {
    topic: "Using FinSight",
    q: "How does scanning a receipt work?",
    a: "You photograph the receipt and FinSight reads the date, store, total and item lines from it. Everything is shown to you to check, and nothing is saved until you confirm it.",
  },
  {
    topic: "Using FinSight",
    q: "What if it reads my receipt wrong?",
    a: "You can change any of it before saving. FinSight also checks whether the item prices add up to the printed total, and when they do not, it points at the line it was least sure of instead of leaving you to find it.",
  },
  {
    topic: "Using FinSight",
    q: "Can I bring in records I already keep in a spreadsheet?",
    a: "Yes. You can import a CSV, match up your columns, and preview every row before anything is added. Nothing is written until you confirm the preview.",
  },
  {
    topic: "Using FinSight",
    q: "Is FinSight available on mobile and desktop?",
    a: "Both. There is an Android app with the core features — expenses, sales, receipt scanning and the dashboard — so a phone alone is enough to run it. The web version works in any browser, on the same records.",
  },
  {
    topic: "Using FinSight",
    q: "Can it replace my accountant?",
    a: "No, and it is not meant to. FinSight is a monitoring tool: it shows you what your own numbers say. It does not produce official financial statements and it does not file anything for you.",
  },
  {
    topic: "Your data",
    q: "Is my data safe?",
    a: "Your records are tied to your business profile and every request is checked against it on the server, so one owner's records are never reachable from another's account. Receipt photos are kept in private storage — opening one creates a link that stops working after ten minutes.",
  },
  {
    topic: "Your data",
    q: "Does the AI assistant see my records?",
    a: "It answers using figures from your own records and nothing else. It is never given another business's data, and when your records do not contain the answer it says so rather than estimating.",
  },
  {
    topic: "Cost and limits",
    q: "Is FinSight free to use?",
    a: "Yes. It is free while in active development, and no card is asked for at sign-up.",
  },
  {
    topic: "Cost and limits",
    q: "Can I use the app offline?",
    a: "Not yet. Recording and receipt scanning both need a connection, because the reading and the analysis happen on the server. Offline recording is something we want to add, not something that works today.",
  },
];

/** How many appear on the landing page before "See all FAQs". */
export const LANDING_FAQ_COUNT = 8;

// ---------------------------------------------------------------- Tutorials

export interface Tutorial {
  n: number;
  title: string;
  body: string;
}

/**
 * The written steps ARE real: they describe what the product does today, so
 * this is useful before a single video exists. Each is marked "video coming
 * soon" rather than given a play button that does nothing — a control that
 * looks live and isn't teaches a visitor something worse about the product
 * than an honest label.
 */
export const TUTORIALS: Tutorial[] = [
  {
    n: 1,
    title: "Setting up your business",
    body: "Create your account, add a business profile, and set the monthly expenses you expect. That figure is what the recovery target is measured against, so it is worth a moment's thought.",
  },
  {
    n: 2,
    title: "Recording expenses and sales",
    body: "Add a purchase with its category, and record the day's sales as a single figure. This is the couple of minutes a day everything else is built on.",
  },
  {
    n: 3,
    title: "Scanning a receipt",
    body: "Photograph a receipt and let FinSight read the date, store, total and item lines. Check what it read, fix anything wrong, then confirm — nothing is saved until you do.",
  },
  {
    n: 4,
    title: "Importing a spreadsheet",
    body: "Bring in records you already keep as a CSV. Match your columns to FinSight's, preview every row, and confirm the ones you want.",
  },
  {
    n: 5,
    title: "Reading your dashboard",
    body: "What the recovery target means, how to read the category breakdown, and what a flagged expense is telling you.",
  },
  {
    n: 6,
    title: "Asking FinSight a question",
    body: "Ask about your own figures in plain language, and understand why it sometimes answers that your records don't cover the question.",
  },
];

// ---------------------------------------------------------------- Contact

/**
 * Deliberately NOT a form, on either platform. A form implies a mailbox
 * someone reads, and there is no endpoint behind one today — a contact form
 * that silently discards messages is worse than no contact page at all.
 */
export const SUPPORT_EMAIL = "support@finsight.example";

// ---------------------------------------------------------------- Legal

export interface LegalSection {
  heading: string;
  /** One or more paragraphs. */
  body: string[];
}

/**
 * The disclaimer both legal documents end with.
 *
 * It is shared because it is the sentence most likely to be quietly dropped
 * when someone tidies a page, and it is the one that must not be — it is what
 * keeps these documents honest about what they are.
 */
export const LEGAL_DISCLAIMER_HEADING = "A note on what this document is.";

/**
 * WHAT THIS IS NOT: lawyer-drafted boilerplate. Generating a document that
 * looks like a reviewed privacy policy, complete with confident claims about
 * regulatory compliance, would be inventing a legal position nobody holds. It
 * would also be the single most damaging thing here to be caught out on,
 * because it is the page a reader is most entitled to trust.
 *
 * So every statement below can be checked against the code — profile-scoped
 * queries, a private storage bucket, ten-minute signed URLs, the assistant's
 * inputs, the correction log — and the closing note says plainly what stage
 * this is at.
 */
export const PRIVACY_SECTIONS: LegalSection[] = [
  {
    heading: "What we store",
    body: [
      "The account details you register with, the business profiles you create, and the records you enter — expenses, sales, categories, and any receipt images or spreadsheets you upload. Nothing is collected from you beyond what you enter or upload.",
    ],
  },
  {
    heading: "Who can see it",
    body: [
      "Your records belong to your business profile, and every request to the server is checked against the profile it claims. One owner's records are not reachable from another owner's account. Receipt images are kept in private storage rather than at a public address; viewing one creates a temporary link that stops working after ten minutes.",
    ],
  },
  {
    heading: "Where AI is involved",
    body: [
      "Two features send data to third-party AI providers: reading a receipt photograph, and answering a question you ask the assistant. Reading a receipt sends the image; asking a question sends figures drawn from your own records. The assistant is never given another business's data, and when your records do not contain an answer it says so rather than estimating one.",
    ],
  },
  {
    /*
     * Added when the extraction feedback loop shipped. The practice it
     * describes is new, it is not obvious from using the app, and "nothing is
     * collected beyond what you enter" above would otherwise be doing more
     * work than it can honestly bear.
     */
    heading: "Corrections you make to a scanned receipt",
    body: [
      "When you confirm a scanned receipt, FinSight records what it read alongside what you confirmed — for every field, whether or not you changed it. That is how it measures its own accuracy and learns which figures it should have doubted.",
      "This stays inside your own records and is deleted with the receipt it came from. It is used to improve the app by hand, by a person reading a summary of what is going wrong most often. If that ever changes — if a correction of yours were to be used to improve extraction for other businesses — this page will say so first.",
    ],
  },
  {
    heading: "How long it is kept",
    body: [
      "Records stay until you delete them. Deleting one also removes the receipt photograph or spreadsheet it came from — once nothing else came from that same upload. A photographed receipt split across several categories keeps its image until the last of those records is gone, because until then the file is still the source of something you can see.",
      "One gap remains, and we would rather name it than let you assume otherwise: a receipt you photograph but never confirm is still stored. Nothing was saved to your books, so there is no record to delete, and automatic clearing of those abandoned scans is not built yet.",
    ],
  },
  {
    heading: "Getting your data out",
    body: [
      "Your records are yours. Contact us if you want a copy of them or want your account and its records removed.",
    ],
  },
];

export const PRIVACY_DISCLAIMER =
  "FinSight is in active development, and this is a plain-language description of how the system actually behaves — not a lawyer-reviewed privacy policy. It will be replaced by a reviewed one before FinSight is offered commercially.";

export const TERMS_SECTIONS: LegalSection[] = [
  {
    heading: "What FinSight is",
    body: [
      "A financial monitoring tool. It records what you enter, organises it, and shows you what your own figures say. It is free to use while in active development.",
    ],
  },
  {
    heading: "What it is not",
    body: [
      "It is not an accounting system of record, and it does not produce official financial statements or file anything with any authority. It does not give financial advice — it shows you what the numbers say and leaves the decision with you. For anything official, use a qualified accountant.",
    ],
  },
  {
    heading: "Accuracy, and your part in it",
    body: [
      "Figures read from a receipt photograph are a reading, not a fact. FinSight shows you everything it read and saves nothing until you confirm it, and it marks the values it is unsure about. Checking those before confirming is your responsibility, and the accuracy of your records depends on it.",
    ],
  },
  {
    heading: "Your account",
    body: [
      "Keep your password to yourself — anyone who has it can reach your records. Use FinSight for your own business records, and not to store anything unlawful.",
    ],
  },
  {
    heading: "Availability",
    body: [
      "This is software under active development. Features change, and the service can be unavailable at times. Keep your own copy of anything you cannot afford to lose.",
    ],
  },
];

export const TERMS_DISCLAIMER =
  "This is a plain-language statement of how FinSight is meant to be used, written for a system in development. It is not lawyer-reviewed terms of service, and it will be replaced by reviewed terms before FinSight is offered commercially.";
