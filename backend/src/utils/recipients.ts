export interface Recipient {
  email: string;
  name: string | null;
}

// Deliberately permissive: this is a lead list, not a signup form. We only
// reject things that clearly cannot be an address.
const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[A-Za-z]{2,}$/;
const EMAIL_SCAN = /[^\s@,;<>"']+@[^\s@,;<>"']+\.[A-Za-z]{2,}/g;

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

/** Splits one CSV line, honouring double-quoted cells with embedded commas. */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
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
 * Accepts a CSV export, a plain newline-separated list, or anything in
 * between: every line that contains an address contributes one recipient, and
 * a non-email cell on that line is used as the display name. Header rows drop
 * out naturally because they contain no address.
 */
export function parseRecipientsText(text: string): Recipient[] {
  const recipients: Recipient[] = [];

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;

    const matches = line.match(EMAIL_SCAN);
    if (!matches || matches.length === 0) continue;

    const cells = splitCsvLine(line);
    for (const match of matches) {
      const email = match.trim();
      const name = cells.find((cell) => cell.length > 0 && !cell.includes('@')) ?? null;
      recipients.push({ email, name: name && name.length <= 200 ? name : null });
    }
  }

  return recipients;
}

export interface NormalizeResult {
  recipients: Recipient[];
  invalid: string[];
  duplicates: number;
}

/**
 * Lower-cases, validates and de-duplicates while preserving input order —
 * order matters because it becomes the send sequence.
 */
export function normalizeRecipients(input: (string | Recipient)[]): NormalizeResult {
  const seen = new Set<string>();
  const recipients: Recipient[] = [];
  const invalid: string[] = [];
  let duplicates = 0;

  for (const entry of input) {
    const raw = typeof entry === 'string' ? { email: entry, name: null } : entry;
    const email = raw.email.trim().toLowerCase();

    if (!isValidEmail(email)) {
      if (email) invalid.push(raw.email.trim());
      continue;
    }
    if (seen.has(email)) {
      duplicates += 1;
      continue;
    }

    seen.add(email);
    recipients.push({ email, name: raw.name?.trim() || null });
  }

  return { recipients, invalid, duplicates };
}
