// Builds fixtures/sample-register.xlsx from the client's original register export.
// Owner and Approvers names are replaced by fixed pseudonyms keyed by the normalised name, so the golden
// counts (12 owners, 10 approvers, 21 people, case-only spellings) survive while no employee name enters the repo.
// Every other cell is copied unchanged. Usage: node scripts/pseudonymise-sample.mjs <source.xlsx> <out.xlsx>
import ExcelJS from 'exceljs';

const PSEUDONYMS = [
  'Alpha',
  'Bravo',
  'Charlie',
  'Delta',
  'Echo',
  'Foxtrot',
  'Golf',
  'Hotel',
  'Juliett',
  'Kilo',
  'Lima',
  'Mike',
  'November',
  'Oscar',
  'Papa',
  'Quebec',
  'Romeo',
  'Sierra',
  'Tango',
  'Uniform',
  'Victor',
  'Whiskey',
  'Xray',
  'Yankee',
  'Zulu',
].map((w) => `Person ${w}`);
const PERSON_HEADERS = new Set(['Owner', 'Approvers']);

const [source, out] = process.argv.slice(2);
if (!source || !out) throw new Error('Usage: pseudonymise-sample.mjs <source.xlsx> <out.xlsx>');

const norm = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();
function withCaseOf(raw, pseudonym) {
  if (raw === raw.toLowerCase()) return pseudonym.toLowerCase();
  if (raw === raw.toUpperCase()) return pseudonym.toUpperCase();
  return pseudonym;
}

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(source);
const ws = wb.worksheets[0];
const header = ws.getRow(1);
const personCols = [];
header.eachCell((cell, col) => {
  if (PERSON_HEADERS.has(String(cell.value).trim())) personCols.push(col);
});
const byName = new Map();
ws.eachRow((row, n) => {
  if (n === 1) return;
  for (const col of personCols) {
    const cell = row.getCell(col);
    if (typeof cell.value !== 'string' || cell.value.trim() === '') continue;
    const key = norm(cell.value);
    if (!byName.has(key)) {
      if (byName.size >= PSEUDONYMS.length) throw new Error('More people than pseudonyms');
      byName.set(key, PSEUDONYMS[byName.size]);
    }
    cell.value = withCaseOf(cell.value, byName.get(key));
  }
});
// Document properties carry the names of whoever saved the file.
wb.creator = 'Canopy fixture';
wb.lastModifiedBy = 'Canopy fixture';
await wb.xlsx.writeFile(out);
console.log(`Wrote ${out}: ${ws.rowCount - 1} rows, ${byName.size} people pseudonymised`);
