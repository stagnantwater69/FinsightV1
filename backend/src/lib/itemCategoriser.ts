import { taxonomyEntry, type ExpenseKind, type TaxonomyKey } from "./expenseTaxonomy";

/**
 * Local, deterministic categorisation of receipt lines — step 3 of D0-03
 * ("normalized keywords"), after explicit owner history.
 *
 * No receipt text leaves the server for this: every decision is a keyword
 * match against a Philippine retail vocabulary, read in the context the
 * receipt itself provides. It works in two steps, deliberately kept apart:
 *
 *   1. WHAT the line is — a product class ("personal care", "fuel"), from the
 *      item's own words, falling back to the kind of shop it came from.
 *   2. WHOSE expense it is — business first. The same bottle of shampoo is
 *      stock on a sari-sari store's restocking run, a restroom supply for a
 *      food stall, and personal care for a consultant. The business type, the
 *      quantities and the rest of the receipt decide which.
 *
 * Every decision carries a confidence. "medium" is the ceiling: D0-03 caps
 * anything not written by the owner below "high". "low" marks the ones the
 * owner should look at, and a line nothing supports is left uncategorised
 * rather than guessed at.
 */

export type ProductClass =
  | "staple_food" | "snack_drink" | "alcohol_tobacco" | "personal_care" | "household" | "cleaning" | "medicine"
  | "office_supply" | "printing" | "packaging" | "store_supply"
  | "office_equipment" | "electronics" | "appliance" | "furniture" | "hardware"
  | "fuel" | "electricity" | "water" | "telecom" | "transport" | "rent" | "bank_fee" | "license" | "tax" | "insurance"
  | "advertising" | "software" | "professional" | "repair" | "salary" | "training"
  | "clothing" | "agri_input" | "restaurant_meal" | "school" | "entertainment";

/** Goods a shop can sell on, and a household also buys. */
const CONSUMER_GOODS: ReadonlySet<ProductClass> = new Set([
  "staple_food", "snack_drink", "alcohol_tobacco", "personal_care", "household", "cleaning", "medicine",
]);

/**
 * The vocabulary, per class. Each entry is a word or the start of one, matched
 * at a word boundary in the lower-cased line: "alco" matches "ALCO" and
 * "ALCOHOL", which matters because registers abbreviate. A trailing space
 * ends the word ("cham " is the gum, not "champion"). Brands and unambiguous
 * phrases count for more than generic nouns (weight 3 vs 2): "EFFICASCENT OIL"
 * is a liniment, not cooking oil, and the brand is what says so.
 */
interface Vocabulary {
  strong?: string[];
  words: string[];
  /** Whole words only — too short or too common to match as a prefix. */
  exact?: string[];
}

const VOCABULARY: Record<ProductClass, Vocabulary> = {
  staple_food: {
    strong: ["century", "ligo", "555", "argentina", "purefoods", "cdo", "san marino", "holiday", "del monte", "ufc",
      "datu puti", "silver swan", "mama sita", "lucky me", "nissin", "payless", "quickchow", "golden tower", "longkou",
      "swallow", "fiesta", "clara ole", "lady s choice", "ladys choice", "knorr", "magic sarap", "ajinomoto", "maggi",
      "bear brand", "alaska", "nido", "birch tree", "anchor", "milo", "ovaltine", "nescafe", "kopiko", "great taste",
      "san mig coffee", "blend 45", "lipton", "gardenia", "reno", "spam", "hunt s", "hunts", "jolly", "carnation",
      "angel", "dari creme", "star margarine", "baguio oil", "minola", "golden fiesta"],
    words: ["rice", "bigas", "sugar", "asukal", "flour", "harina", "vinegar", "suka", "patis", "catsup", "ketchup",
      "soy sauce", "toyo", "banana sauce", "tomato sauce", "seasoning", "vetsin", "bouillon", "sardin", "tuna",
      "corned", "crndbeef", "cornbeef", "beef loaf", "meat loaf", "luncheon", "vienna", "sausage", "hotdog", "longganisa",
      "tocino", "chicken", "pork", "beef", "bangus", "tilapia", "galunggong", "noodle", "pancit", "canton", "sotanghon",
      "bihon", "misua", "miswa", "vermicelli", "odong", "spaghetti", "pasta", "macaroni", "bread", "pandesal", "loaf",
      "milk", "gatas", "evap", "condensada", "condensed", "creamer", "coffee", "kape", "cereal", "oatmeal", "oats",
      "mongo", "munggo", "garlic", "onion", "sibuyas", "tomato", "kamatis", "potato", "patatas", "carrot", "cabbage",
      "repolyo", "vegetable", "gulay", "calamansi", "butter", "margarine", "cheese", "mayonnaise", "mayo", "peanut butter",
      "liver spread", "yeast", "shortening", "cooking oil", "palm oil", "canola", "coconut oil", "pepper", "paminta"],
    exact: ["salt", "asin", "egg", "eggs", "itlog", "oil", "tea", "ham", "fish", "isda", "baboy", "manok", "beans", "corn"],
  },
  snack_drink: {
    strong: ["oishi", "jack n jill", "jnj", "piattos", "nova", "chippy", "super crunch", "cheezy", "rebisco", "skyflakes",
      "sky flakes", "fita", "my san", "mysan", "hansel", "cream o", "wafello", "calcheese", "beng beng", "cloud 9",
      "choc nut", "white rabbit", "snowbear", "kendi", "columbia", "frutos", "halls", "mentos", "hany", "maxx", "cham ",
      "starcup", "coco fruit", "fres ", "happy nuts", "super bawang", "boy bawang", "clover", "tortillos", "v cut", "lays",
      "pringles", "nagaraya", "growers", "coke", "coca cola", "pepsi", "sprite", "royal tru", "mountain dew", "7up",
      "rc cola", "tang ", "zesto", "minute maid", "gatorade", "pocari", "powerade", "cobra", "sting", "yakult", "wilkins",
      "nature spring", "absolute", "summit", "zest o", "presto", "bingo", "combi", "magic flakes", "nissin wafer",
      "stik o", "chiz curls", "potato corner", "babble", "c2 "],
    words: ["chips", "cracker", "crackling", "biscuit", "bisct", "cookie", "wafer", "candy", "candies", "lollipop",
      "bubble gum", "chocolate", "choco", "marshmallow", "jelly", "peanut", "popcorn", "pretzel", "snack", "pastry",
      "ice cream", "softdrink", "soft drink", "soda", "juice", "iced tea", "energy drink", "mineral water", "purified water",
      "bottled water", "mint candy", "menthol"],
    exact: ["gum", "nuts", "cola", "drink", "drinks", "mint"],
  },
  alcohol_tobacco: {
    strong: ["san miguel", "red horse", "pale pilsen", "ginebra", "emperador", "tanduay", "gilbey", "alfonso", "marlboro",
      "fortune", "mighty", "winston", "philip morris", "hope ", "camel", "lucky strike"],
    words: ["beer", "brandy", "whisky", "whiskey", "vodka", "liquor", "lambanog", "cigarette", "cigar", "tobacco", "vape"],
    exact: ["gin", "rum", "wine", "yosi"],
  },
  personal_care: {
    strong: ["safeguard", "palmolive", "dove", "lux", "silka", "belo", "olay", "nivea", "pond s", "ponds", "johnson",
      "babyflo", "bench", "rexona", "closeup", "close up", "colgate", "hapee", "sensodyne", "creamsilk", "cream silk",
      "sunsilk", "head shoulders", "bioderm", "kojie", "likas", "casino", "green cross", "whisper", "modess", "charmee",
      "pampers", "eq diaper", "huggies", "gillette", "vaseline", "cetaphil", "axe", "grips", "gatsby", "pantene",
      "rejoice", "clear ", "hygienix", "bluebell", "baby oil"],
    words: ["shampoo", "conditioner", "soap", "sabon", "body wash", "lotion", "deodorant", "deoltn", "toothpaste",
      "toothbrush", "tooth", "dental", "mouthwash", "cotton bud", "c bud", "napkin", "feminine", "diaper", "wipes",
      "baby powder", "bbypwd", "razor", "shaver", "shaving", "cologne", "perfume", "fragrance", "hair wax", "hairwax",
      "pomade", "hair gel", "facial", "face wash", "sunscreen", "whitening", "whtng", "alcohol", "alco", "ethyl",
      "isopropyl", "sanitizer", "hand wash", "hanky", "nail cutter", "nail polish", "lipstick", "cosmetic"],
    exact: ["deo", "gel", "wax", "spf", "comb"],
  },
  household: {
    words: ["tissue", "toilet paper", "bathroom tissue", "paper towel", "2ply", "3ply", "matches", "posporo", "lighter",
      "candle", "kandila", "battery", "batteries", "flashlight", "light bulb", "mosquito coil", "katol", "air freshener",
      "charcoal", "uling", "trash bag", "garbage bag", "cling wrap", "aluminum foil", "kitchen towel", "hanger", "clothespin",
      "insect spray", "baygon", "raid"],
    exact: ["bulb", "ply"],
  },
  cleaning: {
    strong: ["zonrox", "clorox", "downy", "surf", "tide", "ariel", "breeze", "champion", "pride", "joy dish", "axion",
      "lysol", "domex", "mr muscle", "smart dish", "smart d", "calla", "wings", "del fabric", "vim"],
    words: ["detergent", "laundry", "bleach", "fabric conditioner", "fabcon", "dishwashing", "dshwshng", "d wshng",
      "dish washing", "disinfectant", "cleaner", "cleanser", "toilet bowl", "sponge", "scrub", "mop", "broom", "walis",
      "basahan", "glass cleaner", "muriatic", "stain remover", "floor wax"],
    exact: ["rag"],
  },
  medicine: {
    strong: ["biogesic", "neozep", "bioflu", "decolgen", "alaxan", "medicol", "enervon", "centrum", "solmux", "diatabs",
      "kremil", "efficascent", "vicks", "tiger balm", "katinko", "white flower", "betadine", "band aid", "ceelin",
      "cherifer", "conzace", "stresstabs", "myra", "robitussin", "tuseran", "dolfenal", "ascof", "lagundi"],
    words: ["paracetamol", "ibuprofen", "mefenamic", "amoxicillin", "antibiotic", "vitamin", "ascorbic", "multivitamin",
      "capsule", "syrup", "cough", "loperamide", "antacid", "liniment", "bandage", "gauze", "first aid", "face mask",
      "thermometer", "medicine", "gamot", "ointment", "antiseptic"],
  },
  office_supply: {
    words: ["bond paper", "ream", "pad paper", "notebook", "ballpen", "ball pen", "pencil", "marker", "highlighter",
      "eraser", "sharpener", "ruler", "folder", "envelope", "stapler", "staple", "paper clip", "binder", "scotch tape",
      "masking tape", "glue", "scissors", "cutter", "post it", "sticky note", "index card", "record book", "ledger",
      "receipt book", "logbook", "columnar", "rubber band", "correction tape", "whiteboard", "board marker", "clipboard",
      "fastener", "puncher", "art paper", "cartolina", "manila paper"],
    exact: ["pen", "pens", "clip", "clips", "tape"],
  },
  printing: {
    words: ["ink", "toner", "cartridge", "photo paper", "sticker paper", "photocopy", "xerox", "printing", "lamination",
      "laminat", "print "],
  },
  packaging: {
    strong: ["ecopro"],
    words: ["plastic bag", "sando bag", "labo", "cellophane", "ice bag", "paper bag", "styro", "food pack", "meal box",
      "packaging", "bubble wrap", "ziplock", "zip lock", "foil tray", "disposable", "spoon", "fork", "cutlery", "chopstick",
      "container", "paper cup", "plastic cup", "cup lid", "carton", "twine", "label", "sealer", "shrink wrap"],
    exact: ["cup", "cups", "lid", "lids", "box", "boxes", "straw", "straws"],
  },
  store_supply: {
    words: ["uniform", "apron", "hairnet", "hair net", "glove", "price tag", "tag gun", "shopping bag", "name plate"],
  },
  office_equipment: {
    words: ["printer", "calculator", "photocopier", "scanner", "laminator", "shredder", "projector", "typewriter",
      "label maker", "time clock"],
  },
  electronics: {
    words: ["laptop", "computer", "desktop", "monitor", "keyboard", "mouse", "cellphone", "smartphone", "charger",
      "usb", "flash drive", "hard drive", "ssd", "memory card", "sd card", "router", "modem", "headset", "earphone",
      "speaker", "cctv", "camera", "power bank", "powerbank", "hdmi", "cable", "ipad", "tablet pc"],
  },
  appliance: {
    strong: ["rice cooker", "coffee maker", "electric fan", "water dispenser"],
    words: ["refrigerator", "freezer", "chiller", "stove", "oven", "microwave", "rice cooker", "blender", "mixer",
      "air fryer", "fryer", "griddle", "kettle", "electric fan", "aircon", "air conditioner", "water dispenser",
      "weighing scale", "cash register", "showcase", "grill", "juicer", "coffee maker", "vacuum"],
    exact: ["ref", "pos", "fan", "scale"],
  },
  furniture: {
    words: ["table", "chair", "stool", "shelf", "shelves", "cabinet", "drawer", "display case", "bench", "desk", "sofa",
      "counter top", "rack"],
  },
  hardware: {
    strong: ["boysen", "davies", "stanley", "makita", "bosch", "black decker"],
    words: ["hammer", "screwdriver", "plier", "wrench", "drill", "handsaw", "nail", "screw", "bolt", "hinge", "padlock",
      "paint", "roller", "cement", "gravel", "hollow block", "plywood", "lumber", "pipe", "pvc", "faucet",
      "wire", "electrical tape", "outlet", "circuit breaker", "ladder", "rope", "chain", "sealant", "epoxy", "sandpaper",
      "extension cord", "tool"],
    exact: ["sand"],
  },
  fuel: {
    strong: ["petron", "caltex", "seaoil", "phoenix", "cleanfuel", "unioil"],
    words: ["gasoline", "diesel", "unleaded", "xtra advance", "blaze", "turbo diesel", "v power", "fuel", "kerosene",
      "lpg", "butane", "gaas", "solane", "gasul"],
  },
  electricity: {
    strong: ["meralco", "veco", "visayan electric", "davao light", "cepalco"],
    words: ["electricity", "electric bill", "power bill", "kwh", "kilowatt"],
  },
  water: {
    strong: ["mcwd", "maynilad", "manila water"],
    words: ["water bill", "water district", "cubic meter", "water service"],
  },
  telecom: {
    strong: ["pldt", "converge", "sky cable", "dito", "sun cellular", "globe at home", "gomo", "tnt"],
    words: ["internet", "wifi", "broadband", "fiber", "prepaid load", "e load", "eload", "load wallet", "postpaid",
      "sim card", "data plan", "mobile data", "regular load", "call and text"],
    exact: ["load", "sim"],
  },
  transport: {
    strong: ["lbc", "j and t", "jnt express", "ninja van", "lalamove", "grab", "angkas", "joyride", "move it", "2go",
      "autosweep", "easytrip", "xde", "entrego", "flash express"],
    words: ["delivery fee", "delivery charge", "shipping fee", "shipping", "freight", "courier", "taxi", "jeepney",
      "tricycle", "toll", "parking", "padala", "forwarding", "trucking", "booking fee"],
    exact: ["fare", "bus"],
  },
  rent: {
    words: ["rent", "rental", "lease", "stall fee", "space fee", "monthly dues", "association dues"],
  },
  bank_fee: {
    words: ["bank charge", "transfer fee", "transaction fee", "gcash fee", "cash in fee",
      "convenience fee", "processing fee", "annual fee", "atm fee", "remittance fee", "cash out fee"],
  },
  license: {
    words: ["permit", "barangay clearance", "clearance", "registration", "license", "licence", "fire safety",
      "sanitary permit", "cedula", "community tax", "business name", "renewal fee", "mayor s permit", "dti"],
  },
  tax: {
    words: ["percentage tax", "income tax", "withholding tax", "tax payment", "real property tax", "amilyar",
      "bir form", "vat payment", "tax due"],
  },
  insurance: {
    words: ["insurance", "insurance premium", "policy premium", "pru life", "sun life", "philam", "fire insurance"],
  },
  advertising: {
    words: ["advertis", "facebook ads", "fb ads", "boost", "tarpaulin", "tarp", "flyer", "brochure", "signage",
      "banner", "calling card", "business card", "poster", "promo material", "marketing"],
    exact: ["ads", "sign"],
  },
  software: {
    strong: ["canva", "adobe", "microsoft", "office 365", "google workspace", "shopify", "quickbooks", "xero", "zoom"],
    words: ["subscription", "software", "license key", "cloud storage", "domain", "web hosting", "hosting"],
  },
  professional: {
    words: ["consultation", "consultancy", "legal fee", "notarial", "notary", "accounting fee", "bookkeeping",
      "audit fee", "professional fee", "lawyer", "attorney", "retainer"],
  },
  repair: {
    words: ["repair", "maintenance", "spare part", "tune up", "change oil", "vulcaniz", "overhaul", "labor fee",
      "calibration", "cleaning service"],
    exact: ["parts"],
  },
  salary: {
    words: ["salary", "salaries", "wage", "payroll", "sweldo", "honorarium", "overtime pay", "13th month"],
  },
  training: {
    words: ["seminar", "training", "workshop", "webinar", "certification", "course fee"],
  },
  clothing: {
    words: ["shirt", "tshirt", "t shirt", "pants", "shorts", "dress", "blouse", "skirt", "jacket", "shoes", "sandals",
      "slippers", "tsinelas", "socks", "underwear", "brief", "panty", "sweater", "hoodie"],
    exact: ["bra", "cap", "hat"],
  },
  agri_input: {
    words: ["fertilizer", "abono", "urea", "seeds", "seedling", "pesticide", "herbicide", "insecticide", "fungicide",
      "hog feed", "chicken feed", "poultry feed", "feeds", "pellet", "fingerling", "vaccine", "dewormer"],
  },
  restaurant_meal: {
    strong: ["chickenjoy", "chicken joy", "big mac", "mcchicken", "yumburger", "halo halo", "frappuccino"],
    words: ["value meal", "combo", "burger", "fries", "rice meal", "silog", "sisig", "bulalo", "lomi", "pizza",
      "sandwich", "latte", "cappuccino", "americano", "frappe", "milk tea", "milktea", "platter", "sundae", "buffet",
      "dine in", "take out", "takeout"],
    exact: ["meal", "meals"],
  },
  school: {
    words: ["tuition", "school fee", "enrollment", "enrolment", "school uniform", "textbook", "school supplies"],
  },
  entertainment: {
    strong: ["netflix", "spotify", "disney", "hbo", "youtube premium", "steam"],
    words: ["movie", "cinema", "concert", "karaoke", "videoke", "game", "toy", "ticket"],
  },
};

function escape(word: string): string {
  // Item text is normalised to single spaces, so a space in a word is literal
  // — including a trailing one, which is what ends a short brand name.
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, " ");
}

const MATCHERS: { cls: ProductClass; weight: number; pattern: RegExp }[] = [];
for (const [cls, vocabulary] of Object.entries(VOCABULARY) as [ProductClass, Vocabulary][]) {
  if (vocabulary.strong?.length) {
    MATCHERS.push({ cls, weight: 3, pattern: new RegExp(`\\b(?:${vocabulary.strong.map(escape).join("|")})`) });
  }
  MATCHERS.push({ cls, weight: 2, pattern: new RegExp(`\\b(?:${vocabulary.words.map(escape).join("|")})`) });
  if (vocabulary.exact?.length) {
    MATCHERS.push({ cls, weight: 2, pattern: new RegExp(`\\b(?:${vocabulary.exact.map(escape).join("|")})\\b`) });
  }
}

/** Item text as the vocabulary expects it: lower case, words separated by single spaces, a trailing space. */
function normaliseItemText(text: string): string {
  return `${text.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `;
}

/**
 * What a line is, from its own words — or null when nothing recognisable is
 * on it. Classes score by their strongest evidence; a tie goes to the class
 * listed first in VOCABULARY, which puts everyday goods ahead of the rarer
 * business classes.
 */
export function productClassOf(itemName: string): ProductClass | null {
  const text = normaliseItemText(itemName);
  let best: ProductClass | null = null;
  let bestScore = 0;
  const scores = new Map<ProductClass, number>();
  for (const { cls, weight, pattern } of MATCHERS) {
    if (!pattern.test(text)) continue;
    const score = (scores.get(cls) ?? 0) + weight;
    scores.set(cls, score);
    if (score > bestScore) {
      best = cls;
      bestScore = score;
    }
  }
  return best;
}

// ------------------------------------------------------------
// The shop and the business
// ------------------------------------------------------------

export type VendorType =
  | "supermarket" | "hardware" | "pharmacy" | "restaurant" | "fuel_station" | "bookstore" | "electronics_store"
  | "electric_utility" | "water_utility" | "telecom";

const VENDOR_PATTERNS: [VendorType, RegExp][] = [
  ["fuel_station", /\b(petron|shell|caltex|seaoil|phoenix|cleanfuel|unioil|jetti|flying v|gas(?:oline)? station|fuel)\b/],
  ["electric_utility", /\b(meralco|veco|visayan electric|electric coop|electric cooperative|davao light|cepalco)\b/],
  ["water_utility", /\b(mcwd|maynilad|manila water|water district)\b/],
  ["telecom", /\b(pldt|globe telecom|smart communications|converge|sky ?cable|dito)\b/],
  ["pharmacy", /\b(pharmacy|drug ?store|drug|mercury|watsons|rose pharmacy|south star|generika|tgp|botika)\b/],
  ["hardware", /\b(hardware|wilcon|handyman|builders|construction supply|true value)\b/],
  ["bookstore", /\b(national book ?store|office warehouse|expressions|book ?store|pandayan|school and office)\b/],
  ["electronics_store", /\b(abenson|anson|silicon valley|pc express|octagon|villman|appliance|electronics|gadgets|cellular)\b/],
  ["restaurant", /\b(restaurant|resto|cafe|coffee|grill|eatery|carinderia|jollibee|mcdonalds?|mcdo|chowking|greenwich|mang inasal|kfc|starbucks|pizza|burger|lechon|inasal|kitchen|diner|bistro|tea house|milk ?tea)\b/],
  ["supermarket", /\b(gaisano|savemore|save more|puregold|robinsons|shopwise|landmark|waltermart|walter mart|metro|super ?market|hyper ?market|grocery|groceries|mart|market|7 ?eleven|ministop|alfamart|lawson|all day|prince|isetann|pure gold|wholesale)\b/],
];

export function vendorTypeOf(vendor: string | null | undefined): VendorType | null {
  if (!vendor?.trim()) return null;
  const text = normaliseItemText(vendor);
  return VENDOR_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

/** How the business uses what it buys, read from the type the owner gave at onboarding. */
export type BusinessContext = "reseller" | "food" | "agriculture" | "services" | "unknown";

export function businessContextOf(businessType: string | null | undefined): BusinessContext {
  const text = normaliseItemText(businessType ?? "");
  // Word starts, not whole words: "agri" is "Agriculture", "distribut" is "distributor".
  if (/\b(food|restaurant|cafe|carinderia|eatery|baker|bakeshop|catering|kitchen|canteen|coffee|milk ?tea|snack ?bar|food ?cart|lutong|ulam|kakanin)/.test(text)) return "food";
  if (/\b(sari|retail|online|sell|store|shop|mart\b|grocer|trading|merchandis|distribut|wholesal|reseller|dealer|tindahan|boutique)/.test(text)) return "reseller";
  if (/\b(agri|farm|poultry|pigger|livestock|fisher|fishpond|crop|garden|nurser)/.test(text)) return "agriculture";
  if (/\b(service|salon|barber|repair|laundr|consult|transport|deliver|printing|freelanc|tutor|clinic|spa\b|studio|agenc|rental)/.test(text)) return "services";
  return "unknown";
}

// ------------------------------------------------------------
// The decision
// ------------------------------------------------------------

export type CategoryConfidence = "medium" | "low";

export interface CategoryDecision {
  key: TaxonomyKey;
  kind: ExpenseKind;
  confidence: CategoryConfidence;
  /** Whether the item's own words decided it, or only the kind of shop it came from. */
  source: "item" | "shop";
  /** One owner-facing sentence on why, shown when the decision needs a look. */
  reason: string;
}

export interface CategorisableLine {
  name: string;
  quantity: number | null;
}

export interface ReceiptContext {
  businessType: string | null;
  vendor: string | null;
}

/**
 * Whether the receipt as a whole is a restocking run: mostly shop goods, and
 * bought in shop quantities. What decides a lone quantity-1 bottle of shampoo
 * on it is the other forty lines, not the bottle.
 */
function isRestock(classes: (ProductClass | null)[], lines: CategorisableLine[]): boolean {
  const known = classes.filter((cls): cls is ProductClass => cls !== null);
  if (known.length === 0) return false;
  const goods = known.filter((cls) => CONSUMER_GOODS.has(cls) || cls === "packaging").length;
  if (goods / known.length < 0.6) return false;
  const units = lines.reduce((total, line) => total + (line.quantity ?? 1), 0);
  const bulkLines = lines.filter((line) => (line.quantity ?? 1) >= 3).length;
  // Shop quantities, not a long list: ten single items is a household's weekly shop.
  return bulkLines >= 2 || units >= 12;
}

const REASON = {
  stock: "Filed as stock because this receipt looks like a bulk restock.",
  stockSingle: "Filed as store stock. If this one was for personal use, change it.",
  load: "Filed as stock. Change it if this load was for the store's own phone.",
  ingredient: "Filed as an ingredient. Change it if it was for home.",
  packaging: "Packaging for what you sell.",
  personal: "Looks like a personal purchase. Change it if the business uses it.",
  groceries: "Looks like groceries for home. Change it if the business uses it.",
  business: "Filed as a business expense. Change it if it was for home.",
  meal: "Filed as a business meal. Change it if it was personal.",
  shop: "Guessed from the kind of shop, not the item name.",
} as const;

function decision(key: TaxonomyKey, confidence: CategoryConfidence, reason: string, source: "item" | "shop" = "item"): CategoryDecision {
  return { key, kind: taxonomyEntry(key).kind, confidence, source, reason };
}

/** Personal-care lines that are really sanitation: rubbing alcohol, sanitiser, hand wash. */
const SANITATION = /\b(alco|ethyl|isopropyl|sanitiz|sanitis|hand wash|disinfect)/i;

/** Operating costs and assets: business wherever they are bought, whoever buys them. */
const BUSINESS_CLASS_KEY: Partial<Record<ProductClass, TaxonomyKey>> = {
  office_supply: "office_supplies",
  printing: "printing_supplies",
  store_supply: "store_supplies",
  office_equipment: "office_equipment",
  electronics: "electronics",
  appliance: "equipment",
  furniture: "furniture",
  hardware: "tools",
  fuel: "fuel",
  electricity: "electricity",
  water: "water",
  telecom: "telecom",
  transport: "transport",
  rent: "rent",
  bank_fee: "bank_fees",
  license: "licenses",
  tax: "business_taxes",
  insurance: "insurance",
  advertising: "advertising",
  software: "software",
  professional: "professional_services",
  repair: "repairs",
  salary: "salaries",
  training: "training",
};

function decideForClass(
  cls: ProductClass,
  line: CategorisableLine,
  business: BusinessContext,
  restock: boolean,
): CategoryDecision {
  const bulk = (line.quantity ?? 1) >= 2;
  const stockConfidence: CategoryConfidence = restock || bulk ? "medium" : "low";

  if (CONSUMER_GOODS.has(cls)) {
    if (business === "reseller") return decision("inventory", stockConfidence, restock || bulk ? REASON.stock : REASON.stockSingle);
    if (business === "food") {
      if (cls === "staple_food") return decision("raw_materials", "medium", REASON.ingredient);
      if (cls === "snack_drink" || cls === "alcohol_tobacco") {
        return decision("inventory", (line.quantity ?? 1) >= 6 || restock ? "medium" : "low", REASON.stockSingle);
      }
      if (cls === "cleaning") return decision("cleaning_supplies", "medium", REASON.business);
      if (cls === "household") return decision("store_supplies", "low", REASON.business);
      // Alcohol and sanitiser keep a food business's kitchen clean; soap and lotion do not.
      if (cls === "personal_care" && SANITATION.test(line.name)) return decision("cleaning_supplies", "low", REASON.business);
    }
    // A restocking run is stock even when the profile does not say the business sells goods.
    if (restock && business === "unknown") return decision("inventory", "low", REASON.stock);
    if (cls === "cleaning") return decision("cleaning_supplies", "low", REASON.business);
    if (cls === "personal_care") return decision("personal_care", "low", REASON.personal);
    if (cls === "medicine") return decision("healthcare", "low", REASON.personal);
    if (cls === "household") return decision("household", "low", REASON.personal);
    return decision("groceries", "low", REASON.groceries);
  }

  if (cls === "packaging") {
    if (business === "reseller" && restock) return decision("inventory", "medium", REASON.stock);
    return decision("packaging_materials", "medium", REASON.packaging);
  }
  if (cls === "agri_input") {
    if (business === "reseller" && restock) return decision("inventory", "medium", REASON.stock);
    return decision("raw_materials", business === "agriculture" ? "medium" : "low", REASON.ingredient);
  }
  if (cls === "telecom" && business === "reseller" && /\bload\b/i.test(line.name)) {
    // Load is stock on a sari-sari store's shelf, not its own phone bill.
    return decision("inventory", "low", REASON.load);
  }
  if (cls === "restaurant_meal") return decision("business_meals", "low", REASON.meal);
  if (cls === "clothing") return decision("clothing", "low", REASON.personal);
  if (cls === "school") return decision("education", "low", REASON.personal);
  if (cls === "entertainment") return decision("entertainment", "low", REASON.personal);

  const key = BUSINESS_CLASS_KEY[cls];
  if (!key) return decision("other_operating", "low", REASON.business);
  const reseller = business === "reseller" && restock && (cls === "office_supply" || cls === "hardware");
  return reseller ? decision("inventory", "low", REASON.stock) : decision(key, "medium", REASON.business);
}

/** A line whose own words said nothing: what the shop it came from suggests, at best "low". */
function decideFromVendor(
  vendor: VendorType | null,
  business: BusinessContext,
  restock: boolean,
): CategoryDecision | null {
  if (restock && business === "reseller") return decision("inventory", "low", REASON.stock, "shop");
  switch (vendor) {
    case "fuel_station": return decision("fuel", "low", REASON.shop, "shop");
    case "electric_utility": return decision("electricity", "medium", REASON.shop, "shop");
    case "water_utility": return decision("water", "medium", REASON.shop, "shop");
    case "telecom": return decision("telecom", "medium", REASON.shop, "shop");
    case "hardware": return decision("tools", "low", REASON.shop, "shop");
    case "bookstore": return decision("office_supplies", "low", REASON.shop, "shop");
    case "electronics_store": return decision("electronics", "low", REASON.shop, "shop");
    case "restaurant": return decision("business_meals", "low", REASON.meal, "shop");
    case "pharmacy": return business === "reseller" ? decision("inventory", "low", REASON.stock, "shop") : decision("healthcare", "low", REASON.personal, "shop");
    case "supermarket":
      if (business === "reseller") return decision("inventory", "low", REASON.stockSingle, "shop");
      if (business === "food") return decision("raw_materials", "low", REASON.ingredient, "shop");
      return decision("groceries", "low", REASON.groceries, "shop");
    default: return null;
  }
}

/**
 * Decides a category for every line of one receipt, or null for a line
 * nothing on the receipt explains — that line stays Uncategorized for the
 * owner, which is better than a confident-looking guess.
 */
export function categoriseReceiptLines(lines: CategorisableLine[], context: ReceiptContext): (CategoryDecision | null)[] {
  const business = businessContextOf(context.businessType);
  const vendor = vendorTypeOf(context.vendor);
  const classes = lines.map((line) => productClassOf(line.name));
  const restock = isRestock(classes, lines);
  return lines.map((line, index) => {
    // Food at a restaurant is a meal, whatever it is called ("1PC CHICKEN W/ RICE").
    const cls = vendor === "restaurant" && (classes[index] === "staple_food" || classes[index] === "snack_drink")
      ? "restaurant_meal"
      : classes[index];
    if (cls) return decideForClass(cls, line, business, restock);
    // A meal line at a restaurant rarely names itself ("C1 2PC"); the shop does.
    return decideFromVendor(vendor, business, restock);
  });
}
