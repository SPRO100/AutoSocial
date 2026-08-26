// Delimiter-aware line splitter that never breaks apart a JSON value.
//
// A naive `line.split(delimiter)` shreds a JSON cookie bundle
// (`[{"name":"sessionid","value":"...","domain":".instagram.com"}, ...]`)
// into dozens of spurious columns whenever the delimiter is a comma (or the
// bundle happens to contain a colon/semicolon inside a string value) - this
// was the real production incident this module fixes: a supplier file with
// a JSON cookie column turned into "Column 1 / Column 2 / ..." instead of a
// recognizable account row. splitDelimited tracks `{`/`[` nesting depth and
// double-quoted spans, and only treats the delimiter as a real separator
// while depth is 0 and it is not inside a quoted string - so a JSON value
// (or a double-quoted CSV field) always survives as exactly one token
// regardless of what punctuation it contains internally.
function splitDelimited(line, delimiter) {
  const text = String(line ?? "");
  const tokens = [];
  let current = "";
  let depth = 0;
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      current += ch;
      if (ch === '"' && text[i - 1] !== "\\") inQuotes = false;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      current += ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth = Math.max(0, depth - 1);
      current += ch;
      continue;
    }
    if (depth === 0 && ch === delimiter) {
      tokens.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  tokens.push(current.trim());
  return tokens;
}

module.exports = { splitDelimited };
