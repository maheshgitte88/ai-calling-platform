import fs from "node:fs";
import XLSX from "xlsx";

/**
 * Parse contacts from Excel/CSV file.
 * @param {string} filePath
 * @param {string} phoneColumn
 * @param {string} nameColumn
 * @returns {{ name: string; phone: string; metadata: Record<string, unknown> }[]}
 */
export function parseContactsFromSheet(filePath, phoneColumn = "phone", nameColumn = "name") {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  const contacts = [];
  for (const row of rows) {
    const phone = String(row[phoneColumn] ?? "").trim();
    if (!phone) continue;
    const name = String(row[nameColumn] ?? "").trim();
    contacts.push({ name, phone, metadata: { ...row } });
  }
  return contacts;
}

export function safeRemoveFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // no-op
  }
}
