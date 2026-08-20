export interface Lead {
  email: string;
  name: string | null;
}

export interface ParsedLeads {
  leads: Lead[];
  /** Rows that looked like data but held no address. */
  invalidRows: number;
  duplicates: number;
}

const EMAIL_SCAN = /[^\s@,;<>"']+@[^\s@,;<>"']+\.[A-Za-z]{2,}/g;

/** Splits one CSV row, honouring quoted cells that contain commas. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((char === ',' || char === ';' || char === '\t') && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim().replace(/^"|"$/g, '').trim());
}

/**
 * Accepts a CSV export or a plain list of addresses — every line containing an
 * address yields one lead, and a non-email cell on that line becomes the name.
 * Header rows fall out naturally because they contain no address.
 *
 * The backend re-runs the same normalisation on submit; this copy exists so
 * the composer can show a live count before anything is uploaded.
 */
export function parseLeads(text: string): ParsedLeads {
  const seen = new Set<string>();
  const leads: Lead[] = [];
  let invalidRows = 0;
  let duplicates = 0;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;

    const matches = line.match(EMAIL_SCAN);
    if (!matches) {
      invalidRows += 1;
      continue;
    }

    const cells = splitRow(line);
    const name = cells.find((cell) => cell.length > 0 && !cell.includes('@')) ?? null;

    for (const match of matches) {
      const email = match.trim().toLowerCase();
      if (seen.has(email)) {
        duplicates += 1;
        continue;
      }
      seen.add(email);
      leads.push({ email, name: name && name.length <= 200 ? name : null });
    }
  }

  // A header row ("email,name") is expected, not an error worth reporting.
  return { leads, invalidRows: Math.max(0, invalidRows - 1), duplicates };
}

export const ACCEPTED_LEAD_TYPES = '.csv,.txt,text/csv,text/plain';
