/* eslint-disable no-console */
/**
 * Generates test-roster.xlsx — a 20-row enrolment roster fixture for the
 * `POST /api/roster/import` endpoint.
 *
 * Uses ExcelJS (the same library the importer reads with) so the file is
 * byte-compatible with what the server expects: one worksheet, header row in
 * row 1, data starting in row 2, plain `text` cells.
 *
 * Header row is exactly `name, email, phone` — the canonical alias for each
 * field per `src/utils/rosterWorkbook.ts` `HEADER_ALIASES`.
 *
 * Per-row validation the importer enforces:
 *   - email: passes `z.email()` (after trim+lowercase); rejected rows are
 *     reported by line number, so a single bad row does not discard the file.
 *   - name:  required, 1–150 chars (Unicode letters/spaces by extension).
 *   - phone: optional, max 40 chars.
 *
 * Phone format follows Bangladeshi mobile convention (`01[3-9]XXXXXXXX`) so
 * the values look like real cohort data when eyeballing the file. The
 * importer's phone rule is intentionally looser than the attendance form's
 * — it accepts landlines and international numbers — so any well-formed
 * phone string passes.
 *
 * Run with: `npx tsx scripts/generate-test-roster.ts`
 * Output:    `./test-roster.xlsx` (cwd-relative, i.e. backend root).
 */

import ExcelJS from 'exceljs';

type TTestRosterRow = {
  name: string;
  email: string;
  phone: string;
};

const ROWS: TTestRosterRow[] = [
  { name: 'রাকিবুল হাসান',      email: 'rakib.hasan@example.com',     phone: '01711000001' },
  { name: 'তানজিনা আহমেদ',       email: 'tanjina.ahmed@example.com',   phone: '01711000002' },
  { name: 'মাহমুদুল হক',         email: 'mahmudul.haque@example.com',  phone: '01711000003' },
  { name: 'সাদিয়া ইসলাম',       email: 'sadiya.islam@example.com',    phone: '01711000004' },
  { name: 'আবিদ হাসান',          email: 'abid.hasan@example.com',      phone: '01711000005' },
  { name: 'নুসরাত জাহান',        email: 'nusrat.jahan@example.com',    phone: '01711000006' },
  { name: 'ফাহিম মুনতাসির',      email: 'fahim.muntasir@example.com',  phone: '01711000007' },
  { name: 'সুমাইয়া আক্তার',     email: 'sumaiya.akter@example.com',   phone: '01711000008' },
  { name: 'রায়হান চৌধুরী',       email: 'rayhan.chowdhury@example.com', phone: '01711000009' },
  { name: 'মেহজাবিন রহমান',      email: 'mehjabin.rahman@example.com', phone: '01711000010' },
  { name: 'তাসনিম হাফিজ',        email: 'tasnim.hafiz@example.com',    phone: '01711000011' },
  { name: 'আশফাক রহমান',         email: 'ashfaq.rahman@example.com',   phone: '01711000012' },
  { name: 'লাবণ্য তাসনিম',       email: 'labannya.tasnim@example.com', phone: '01711000013' },
  { name: 'রাফি আহমেদ',          email: 'rafi.ahmed@example.com',      phone: '01711000014' },
  { name: 'ফারিয়া সুলতানা',      email: 'faria.sultana@example.com',   phone: '01711000015' },
  { name: 'সাকিব হোসেন',         email: 'sakib.hossain@example.com',   phone: '01711000016' },
  { name: 'তামান্না ইসলাম',       email: 'tamanna.islam@example.com',   phone: '01711000017' },
  { name: 'মুনতাসির মামুন',      email: 'muntasir.mamun@example.com',  phone: '01711000018' },
  { name: 'আনিকা তাবাসসুম',      email: 'anika.tabassum@example.com',  phone: '01711000019' },
  { name: 'হাবিবুর রহমান',       email: 'habibur.rahman@example.com',  phone: '01711000020' },
];

const assertValid = (rows: TTestRosterRow[]): void => {
  // Email uniqueness within the file mirrors the importer's last-row-wins
  // dedupe rule. Duplicates in a real import collapse silently; here we
  // forbid them so the fixture behaves predictably.
  const emails = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (!row.name.trim()) {
      throw new Error(`Row ${index + 1}: name is empty`);
    }
    if (row.name.length > 150) {
      throw new Error(`Row ${index + 1}: name exceeds 150 chars`);
    }
    const normalizedEmail = row.email.trim().toLowerCase();
    if (emails.has(normalizedEmail)) {
      throw new Error(`Row ${index + 1}: duplicate email ${normalizedEmail}`);
    }
    emails.add(normalizedEmail);
    if (row.phone.length > 40) {
      throw new Error(`Row ${index + 1}: phone exceeds 40 chars`);
    }
  }
  console.log(`Validated ${rows.length} rows; ${emails.size} unique emails.`);
};

const buildWorkbook = async (rows: TTestRosterRow[]): Promise<ExcelJS.Workbook> => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'discord-manager test fixture';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Roster', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = [
    { header: 'name',  key: 'name',  width: 28 },
    { header: 'email', key: 'email', width: 38 },
    { header: 'phone', key: 'phone', width: 16 },
  ];

  // Bold the header — cosmetic, the importer only reads `cell.text`.
  sheet.getRow(1).font = { bold: true };

  for (const row of rows) {
    sheet.addRow({ name: row.name, email: row.email, phone: row.phone });
  }

  return workbook;
};

const main = async (): Promise<void> => {
  assertValid(ROWS);

  const workbook = await buildWorkbook(ROWS);
  const outPath = 'test-roster.xlsx';
  await workbook.xlsx.writeFile(outPath);

  console.log(`Wrote ${ROWS.length} data rows + 1 header row to ${outPath}`);
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});