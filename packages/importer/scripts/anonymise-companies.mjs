// Builds fixtures/sample-register-anonymised.xlsx from fixtures/sample-register.xlsx: the real group, company and town
// names become fictional ones ("Kestrel Metals Group", "Kestrel Aluminium", "Riverbend", "Kestrelganj") in every cell,
// the Organization, Location and Act columns and the comment text alike.
// Each name maps to one replacement, so every golden count survives; every other cell is copied unchanged.
// Usage: node scripts/anonymise-companies.mjs <sample-register.xlsx> <out.xlsx>
import ExcelJS from 'exceljs';

const REPLACEMENTS = [
  ['Aditya Birla Group', 'Kestrel Metals Group'],
  ['Hindalco Industries Limited', 'Kestrel Aluminium Limited'],
  ['Hindalco', 'Kestrel Aluminium'],
  ['Belur', 'Riverbend'],
  ['Renukoot', 'Kestrelganj'],
];

const [source, out] = process.argv.slice(2);
if (!source || !out) throw new Error('Usage: anonymise-companies.mjs <source.xlsx> <out.xlsx>');

const anonymise = (text) => REPLACEMENTS.reduce((s, [from, to]) => s.replaceAll(from, to), text);

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(source);
let changed = 0;
for (const ws of wb.worksheets) {
  ws.eachRow((row) =>
    row.eachCell((cell) => {
      if (typeof cell.value !== 'string') return;
      const next = anonymise(cell.value);
      if (next !== cell.value) {
        cell.value = next;
        changed += 1;
      }
    }),
  );
}
await wb.xlsx.writeFile(out);
console.log(`${changed} cells anonymised`);
