// Cleaning up a bot token that has been pasted through a dashboard.
//
// A token copied on a phone and pasted into a hosting dashboard often
// arrives wrapped in quotes — and frequently curly ones (U+201C/U+201D),
// because phone keyboards substitute them. The value is then stored with the
// quotes as part of it, Telegram is handed a token beginning with a quote
// character, and the only symptom is a bare 401 that says nothing about why.
//
// Shell syntax is the source of the confusion: quotes are needed in a .env
// file or a shell command, and are not wanted in a dashboard field, which
// stores the value literally. Rather than expect anyone to keep that
// straight, this strips what could never legitimately be in a token and says
// out loud when it had to.

export interface CleanedToken {
  token: string;
  /** What was removed, for a log line that explains the fix. */
  notes: string[];
  /** Shaped like a Telegram token: digits, a colon, then the secret. */
  looksValid: boolean;
}

const QUOTES = ['"', "'", "“", "”", "‘", "’", "`"];

/**
 * Peel surrounding quotes, paired or not.
 *
 * Written as a loop rather than one pass because the opening and closing
 * curly quotes are different characters, so a naive "starts and ends with the
 * same quote" check misses the exact case this exists for.
 */
function peelQuotes(input: string): { value: string; stripped: boolean } {
  let value = input;
  let stripped = false;
  for (let i = 0; i < 4; i++) {
    const first = value[0];
    const last = value[value.length - 1];
    if (value.length > 1 && QUOTES.includes(first) && QUOTES.includes(last)) {
      value = value.slice(1, -1).trim();
      stripped = true;
      continue;
    }
    if (QUOTES.includes(first)) {
      value = value.slice(1).trim();
      stripped = true;
      continue;
    }
    if (QUOTES.includes(last)) {
      value = value.slice(0, -1).trim();
      stripped = true;
      continue;
    }
    break;
  }
  return { value, stripped };
}

export function cleanToken(raw: string | undefined): CleanedToken {
  const notes: string[] = [];
  let token = (raw ?? "").trim();
  if (token === "") return { token: "", notes, looksValid: false };

  const first = peelQuotes(token);
  token = first.value;
  let strippedQuotes = first.stripped;

  // A leading "NAME=" happens when the whole line is pasted into the value
  // box rather than just the value -- and the value inside it may carry its
  // own quotes, so the peel has to run again afterwards.
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*([\s\S]+)$/.exec(token);
  if (assignment) {
    token = assignment[1].trim();
    notes.push("stripped a leading NAME= -- paste only the value, not the whole line");
    const second = peelQuotes(token);
    token = second.value;
    strippedQuotes = strippedQuotes || second.stripped;
  }

  if (strippedQuotes) {
    notes.unshift(
      "stripped surrounding quotes -- a dashboard field stores the value literally, so quotes become part of the token"
    );
  }

  // Whitespace inside a token is always damage: a line wrap from copying out
  // of a chat, usually.
  if (/\s/.test(token)) {
    token = token.replace(/\s+/g, "");
    notes.push("removed whitespace from inside the token");
  }

  return { token, notes, looksValid: /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token) };
}
