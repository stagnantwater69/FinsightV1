/**
 * A real long receipt, as TEXT: a Gaisano Grand (Mandaue City) supermarket
 * receipt photographed on the mobile scanner in three sections.
 *
 * WHAT THIS IS AND IS NOT. Hand-transcribed from the owner's screenshots of
 * the three enhanced pages, not tesseract output: it pins the LAYOUT (two
 * printed lines per item, figures first, a "T" VAT flag on every total) and
 * the receipt's own arithmetic, not how any OCR engine reads the photographs.
 * The transcription is checked against the paper twice over: the 53 line
 * totals sum to the printed "Total P7967.25", and their quantities sum to the
 * printed "No Of Items : 239". Noise variants in the tests are constructed
 * from OCR confusions this codebase has recorded elsewhere, and are labelled
 * as such.
 *
 * The sections overlap by one printed line (page 1's last description is
 * page 2's first), and page 2's last figures line takes its description from
 * the top of page 3 — both exactly as photographed.
 */

/** One purchase: [code, quantity, unit price, line total, description]. */
export type ReceiptRow = [code: string, quantity: number, unitPrice: string, amount: string, name: string];

export const GAISANO_HEADER = [
  "GAISANO GRAND",
  "DYNASTY MANAGEMENT & DEV'T . COR",
  "P.",
  "J.P RIZAL, BASAK MANDAUE CITY, CEBU",
  "VAT Registered TIN 004-272-277-018",
  "Serial #6600441",
  "MIN 16102916340707661",
  "SOLD TO:",
  "ADDRESS:",
  "TIN:",
  "ITEM QTY PRICE TOTAL",
  "--------------------------------------",
];

export const GAISANO_ROWS: ReceiptRow[] = [
  // Page 1
  ["005705486", 1, "115.25", "115.25", "FEMME BT300 2PLY 128+CTTN"],
  ["003399130", 1, "88.50", "88.50", "CASINO ETHYL ALCO FEMME 5"],
  ["003399122", 10, "48.75", "487.50", "CASINO ETHYL ALCO FEMME 2"],
  ["003399159", 10, "32.25", "322.50", "CASINO ETHYL ALCO MILD 15"],
  ["004065833", 40, "22.25", "890.00", "CASINO FEMME 60ML"],
  ["003848814", 18, "17.00", "306.00", "BIODERM \"BLOOM\" PINK 60G"],
  ["005230783", 1, "200.00", "200.00", "SAFEGUARD BAR A/FRSH175/1"],
  ["005387465", 1, "130.50", "130.50", "SAFEGUARD BAR WHITE 60/65"],
  ["004527936", 5, "27.00", "135.00", "GRIPS WAX HRDMAT 5G 6S"],
  ["003026140", 9, "4.75", "42.75", "HAPPY C/BUDS PLSTCSTM 36S"],
  ["005652850", 1, "80.00", "80.00", "REXONA DLTN PD BRGHT3MLX1"],
  ["003026135", 11, "5.00", "55.00", "HAPPY C/BUDS PAPERSTM 36S"],
  ["003015298", 5, "26.00", "130.00", "SMART D/WSHNG PASTE LMN 2"],
  ["003523216", 1, "88.00", "88.00", "CLOSEUP RED HOT NEW 10G 1"],
  // Page 2
  ["005583656", 1, "154.00", "154.00", "CLOSE UP RD HT P175GX2S+T"],
  ["004209687", 1, "42.50", "42.50", "REXONA DEOLTN QUANTUM 3ML"],
  ["004461333", 1, "58.00", "58.00", "SILKA WHTNG LOT ENRG CTRS"],
  ["004461336", 1, "58.00", "58.00", "SILKA WHTN LOT SHEA BUTTR"],
  ["004794789", 2, "61.00", "122.00", "SILKA GRN PPYA LOT OLV OI"],
  ["004904954", 1, "54.00", "54.00", "SILKA PREM MM LTN SPF23 5"],
  ["005702325", 1, "76.50", "76.50", "BABYFLO BBYPWDHUNLYWHT200"],
  ["003399818", 5, "34.50", "172.50", "EFFICASCENT OIL ES 25ML"],
  ["003022859", 2, "22.00", "44.00", "JBC HAPPY NUTS GARLIC 56X"],
  ["004708850", 1, "97.50", "97.50", "SUPER BAWANG 50G/10S"],
  ["005021882", 10, "10.25", "102.50", "SUPER CRUNCH CHEESE 55G"],
  ["005021885", 10, "10.25", "102.50", "SUPER CRUNCH SWEETCORN 55"],
  ["005055693", 1, "77.50", "77.50", "NESCAFE B&B ORIG 26G/20GX"],
  ["004265948", 1, "77.50", "77.50", "KOPIKO BRWN COFFEE27.5/20"],
  ["005155554", 3, "15.50", "46.50", "ECOPRO SPOON BIG WHITEX12"],
  ["005461363", 3, "114.00", "342.00", "BEAR BRAND PWD SWAK 33G/1"],
  ["004987265", 2, "185.00", "370.00", "POCARI SWEAT 500ML/4S FNL"],
  ["005221454", 10, "13.00", "130.00", "WAFELLO CHOCOLATE WAFER 4"],
  ["005011031", 10, "12.50", "125.00", "CALCHEESE WAFER 48G"],
  ["003656743", 20, "23.75", "475.00", "UFC BANANA CATSUP S/POUCH"],
  ["005443300", 3, "99.75", "299.25", "HOLIDAY CRNDBEEF160/150GX"],
  // Page 3
  ["005443303", 2, "80.00", "160.00", "HOLIDAY BEEF LOAF 150GX4"],
  ["003018688", 5, "6.75", "33.75", "LONGKOU VERMICELLI 50G"],
  ["003462431", 2, "37.00", "74.00", "GOLDEN TOWER ODONG 20GX12"],
  ["003897097", 3, "21.50", "64.50", "SWALLOW MISUA 12S"],
  ["005678646", 1, "135.50", "135.50", "KOPIKO BLANCA TP 20GX2X10"],
  ["005694504", 1, "84.75", "84.75", "BENG-BENG CHOCOLTE WAFER2"],
  ["004977330", 1, "142.75", "142.75", "FRES BARLEY JAR 36/200G"],
  ["004417138", 1, "117.50", "117.50", "HAY STARCUP CHOCO BISCT 1"],
  ["005225577", 1, "120.00", "120.00", "COCO FRUIT SHAPE LOLLIPOP"],
  ["003392190", 1, "132.50", "132.50", "CHAM SUPER TATTOO BG 200S"],
  ["003024004", 5, "41.75", "208.75", "COLUMBIA V FRESH COOL GUM"],
  ["003021151", 2, "98.25", "196.50", "SNOWBEAR MENTHOL 100S"],
  ["003015459", 1, "90.00", "90.00", "WHITE RABBIT 100S"],
  ["003015456", 1, "90.00", "90.00", "KENDI MINT CANDY 100G"],
  ["003055952", 2, "35.00", "70.00", "COLUMBIA FRTY CHOCO POP 2"],
  ["004003293", 5, "22.00", "110.00", "BABBLE JOE 25G"],
  ["003019093", 1, "19.50", "19.50", "EMI MATCHES STNDRD 10S"],
  // Printed twice on the paper and counted twice in its total: a real repeat.
  ["003019093", 1, "19.50", "19.50", "EMI MATCHES STNDRD 10S"],
];

export const GAISANO_FOOTER = [
  "Total P7967.25",
  "Cash 8,000.00",
  "CHANGE ===> 32.75",
  "Cashier : 37006",
  "No Of Items : 239",
  "VATable Sales : P7,113.65",
  "VAT : P853.60",
  "Non-Vatable Sales : P0.00",
];

export const GAISANO_TOTAL = 7967.25;

/** The two printed lines of one row, figures first, as this register prints them. */
export function rowLines([code, quantity, unitPrice, amount, name]: ReceiptRow): string[] {
  return [`${code} ${quantity} ${unitPrice} ${amount}T`, name];
}

/**
 * The receipt cut into photographs after the given row counts, the way the
 * scanner captures it: every section after the first repeats `overlapLines`
 * printed lines from the end of the one before it.
 */
export function photographedSections(rowsPerSection: number[], overlapLines = 0): string[] {
  const lines = [...GAISANO_HEADER, ...GAISANO_ROWS.flatMap(rowLines), ...GAISANO_FOOTER];
  const breaks: number[] = [];
  let rows = 0;
  for (const count of rowsPerSection.slice(0, -1)) {
    rows += count;
    breaks.push(GAISANO_HEADER.length + rows * 2);
  }
  const sections: string[] = [];
  let start = 0;
  for (const end of [...breaks, lines.length]) {
    sections.push(lines.slice(Math.max(0, start - (sections.length > 0 ? overlapLines : 0)), end).join("\n"));
    start = end;
  }
  return sections;
}

/**
 * The three sections exactly as the owner photographed them: page 1 ends on
 * CLOSEUP's description, which page 2 repeats at its top, and page 2 ends on
 * a figures line whose description opens page 3.
 */
export function asPhotographed(): [string, string, string] {
  const lines = GAISANO_ROWS.flatMap(rowLines);
  const page1 = [...GAISANO_HEADER, ...lines.slice(0, 28)];
  const page2 = [lines[27]!, ...lines.slice(28, 69)];
  const page3 = [...lines.slice(69), ...GAISANO_FOOTER];
  return [page1.join("\n"), page2.join("\n"), page3.join("\n")];
}

/**
 * The Puregold-style layout from the owner's other long receipt: the
 * description first, then quantity, unit price and a "V"-flagged total.
 * Transcribed from one screenshot section; there is no printed total in it.
 */
export const NAME_FIRST_SECTION = [
  "--------------------------------------",
  "OISHI FISH CRACKERS 24g/100",
  "        4        6.80      27.20V",
  "OISHI CRACKLING S&V 24g/100",
  "        7        6.80      47.60V",
  "CHIPPY BBQ 25g/100",
  "        3        7.45      22.35V",
  "CHIPPY CHILICHS 25g/100",
  "        3        7.45      22.35V",
  "SUPER CRUNCH SWTCORN 6 55g/10s/5",
  "        2       10.10      20.20V",
  "SUPER CRUNCH CHS B 55g/10s/5",
  "        2       10.10      20.20V",
  "CHEEZY CC RH SPCY&CHSY 22g/10S",
  "       10        7.95      79.50V",
].join("\n");
