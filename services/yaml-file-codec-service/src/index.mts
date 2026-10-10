/**
 * codecs/text/yaml — a pure YAML codec for the frontmatter subset this corpus
 * writes: `decodeYaml` reads a YAML head (no `---` fences) into a JSON record,
 * `encodeYaml` writes one back out.
 *
 * Scope: bare keys (dots and dashes allowed) and quoted keys, quoted and bare scalars (dates
 * kept as ISO strings, never Date objects), null/~, inline arrays (nested),
 * block sequences (indented or at the key's own column), block sequences of
 * maps (`- key: value` items), nested maps, literal `|` and folded `>` block
 * scalars, and full-line or trailing `#` comments. Flow maps (`{ ... }`) are
 * outside the subset and throw rather than mis-parse. Pure string ↔ value,
 * no I/O; TypeError is the only failure mode.
 *
 * Laws: decodeYaml(encodeYaml(record)) deep-equals record for every record in
 * the subset, and decodeYaml(encodeYaml(decodeYaml(text))) = decodeYaml(text)
 * for conforming texts (canonical serialization may normalize quoting and drop
 * comments; it never loses an entry).
 */
import { requireJsonValue, type JsonRecord, type JsonValue } from "@red-cup-engineering/json-file-codec-service";

const KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/u;
const INTEGER_PATTERN = /^[+-]?\d+$/u;
const FLOAT_PATTERN = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/u;
const BLOCK_SCALAR_PATTERN = /^([|>])([+-]?)\s*$/u;

type Cursor = { pos: number };

/** Decode a YAML head (fence-free text) into a frozen JSON record. */
export function decodeYaml(text: string): JsonRecord {
  if (typeof text !== "string") throw new TypeError("yaml: document must be a string");
  const lines = text.split("\n").map(stripCr);
  const cur: Cursor = { pos: 0 };
  const record = decodeMap(lines, cur, 0, "yaml");
  skipBlank(lines, cur);
  if (cur.pos < lines.length) {
    throw new TypeError(`yaml: unexpected content at line ${cur.pos + 1}`);
  }
  return requireJsonValue(record, "yaml document") as JsonRecord;
}

/** Encode a JSON record as YAML head text (fence-free, trailing newline). */
export function encodeYaml(record: JsonRecord): string {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("yaml: document must be a plain record");
  }
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    encodeEntry(lines, key, value as JsonValue, 0, key);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

// — decoding —

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function skipBlank(lines: readonly string[], cur: Cursor): void {
  while (cur.pos < lines.length && isBlankOrComment(lines[cur.pos] ?? "")) cur.pos += 1;
}

function decodeMap(lines: readonly string[], cur: Cursor, indent: number, where: string): Record<string, JsonValue> {
  const record: Record<string, JsonValue> = {};
  for (;;) {
    skipBlank(lines, cur);
    const line = lines[cur.pos];
    if (line === undefined) break;
    const lineIndent = indentOf(line);
    if (lineIndent < indent) break;
    if (lineIndent > indent) {
      throw new TypeError(`yaml line ${cur.pos + 1}: unexpected indentation under ${where}`);
    }
    const body = line.slice(indent);
    if (body.startsWith("- ") || body === "-") break;
    const entry = decodeKeyLine(body, cur.pos + 1);
    cur.pos += 1;
    record[entry.key] = decodeValue(lines, cur, indent, entry.rest, `${where}.${entry.key}`);
  }
  return record;
}

function decodeValue(lines: readonly string[], cur: Cursor, keyIndent: number, rest: string, where: string): JsonValue {
  const trimmed = rest.trim();
  const blockScalar = trimmed.match(BLOCK_SCALAR_PATTERN);
  if (blockScalar !== null) {
    return decodeBlockScalar(lines, cur, keyIndent, blockScalar[1] === ">", blockScalar[2] ?? "");
  }
  if (trimmed !== "" && !trimmed.startsWith("#")) {
    return decodeFlow(trimmed, where);
  }
  // Bare key: the value is a block sequence (at the key's column or deeper),
  // a nested map (deeper), or null when the next line is a sibling or the end.
  skipBlank(lines, cur);
  const next = lines[cur.pos];
  if (next === undefined) return null;
  const nextIndent = indentOf(next);
  const nextBody = next.slice(nextIndent);
  const nextIsDash = nextBody.startsWith("- ") || nextBody === "-";
  if (nextIsDash && nextIndent >= keyIndent) {
    return decodeSequence(lines, cur, nextIndent, where);
  }
  if (nextIndent > keyIndent) {
    return decodeMap(lines, cur, nextIndent, where);
  }
  return null;
}

function decodeSequence(lines: readonly string[], cur: Cursor, indent: number, where: string): JsonValue[] {
  const items: JsonValue[] = [];
  for (;;) {
    skipBlank(lines, cur);
    const line = lines[cur.pos];
    if (line === undefined || indentOf(line) !== indent) break;
    const body = line.slice(indent);
    if (!(body.startsWith("- ") || body === "-")) break;
    const rest = body === "-" ? "" : body.slice(2);
    cur.pos += 1;
    items.push(decodeSequenceItem(lines, cur, indent, rest, `${where}[${items.length}]`));
  }
  return items;
}

function decodeSequenceItem(lines: readonly string[], cur: Cursor, dashIndent: number, rest: string, where: string): JsonValue {
  if (rest.trim() === "") {
    return decodeValue(lines, cur, dashIndent + 1, "", where);
  }
  // A `- - item` line opens a nested sequence inline: its first item is the
  // remainder of the line, its continuation items sit two columns deeper.
  if (rest.startsWith("- ") || rest === "-") {
    const nested: JsonValue[] = [];
    nested.push(decodeSequenceItem(lines, cur, dashIndent + 2, rest === "-" ? "" : rest.slice(2), `${where}[0]`));
    for (;;) {
      skipBlank(lines, cur);
      const line = lines[cur.pos];
      if (line === undefined || indentOf(line) !== dashIndent + 2) break;
      const body = line.slice(dashIndent + 2);
      if (!(body.startsWith("- ") || body === "-")) break;
      cur.pos += 1;
      nested.push(decodeSequenceItem(lines, cur, dashIndent + 2, body === "-" ? "" : body.slice(2), `${where}[${nested.length}]`));
    }
    return nested;
  }
  const entry = tryKeyLine(rest);
  if (entry !== undefined) {
    return decodeSequenceMapItem(lines, cur, dashIndent, entry, where);
  }
  return decodeFlow(rest.trim(), where);
}

type KeyLine = Readonly<{ key: string; rest: string }>;

function tryKeyLine(text: string): KeyLine | undefined {
  if (text.startsWith('"') || text.startsWith("'")) {
    let quoted: Quoted;
    try {
      quoted = decodeQuoted(text, 0, "yaml key");
    } catch {
      return undefined;
    }
    const after = text.slice(quoted.end);
    if (!after.startsWith(":")) return undefined;
    return Object.freeze({ key: quoted.value, rest: after.slice(1) });
  }
  const colon = text.indexOf(":");
  if (colon === -1) return undefined;
  const key = text.slice(0, colon).trim();
  const after = text[colon + 1];
  if (!KEY_PATTERN.test(key) || (after !== undefined && !/\s/u.test(after))) return undefined;
  return Object.freeze({ key, rest: text.slice(colon + 1) });
}

function decodeKeyLine(body: string, lineNumber: number): KeyLine {
  const entry = tryKeyLine(body);
  if (entry !== undefined) return entry;
  const colon = body.indexOf(":");
  if (colon === -1) throw new TypeError(`yaml line ${lineNumber}: expected \`key: value\``);
  throw new TypeError(`yaml line ${lineNumber}: \`${body.slice(0, colon).trim()}\` is not a bare key`);
}

// A `- key: value` item: the dash opens a map whose remaining entries sit
// deeper than the dash column.
function decodeSequenceMapItem(lines: readonly string[], cur: Cursor, dashIndent: number, first: KeyLine, where: string): JsonValue {
  const record: Record<string, JsonValue> = {};
  record[first.key] = decodeValue(lines, cur, dashIndent + 2, first.rest, `${where}.${first.key}`);
  for (;;) {
    skipBlank(lines, cur);
    const line = lines[cur.pos];
    if (line === undefined) break;
    const lineIndent = indentOf(line);
    if (lineIndent <= dashIndent) break;
    const entry = tryKeyLine(line.slice(lineIndent));
    if (entry === undefined) throw new TypeError(`yaml line ${cur.pos + 1}: expected \`key: value\` in ${where}`);
    cur.pos += 1;
    record[entry.key] = decodeValue(lines, cur, lineIndent, entry.rest, `${where}.${entry.key}`);
  }
  return record;
}

function decodeBlockScalar(lines: readonly string[], cur: Cursor, keyIndent: number, folded: boolean, chomp: string): string {
  const collected: string[] = [];
  let blockIndent = -1;
  while (cur.pos < lines.length) {
    const line = lines[cur.pos];
    if (line === undefined) break;
    if (line.trim() === "") {
      collected.push("");
      cur.pos += 1;
      continue;
    }
    const lineIndent = indentOf(line);
    if (lineIndent <= keyIndent) break;
    if (blockIndent === -1) blockIndent = lineIndent;
    if (lineIndent < blockIndent) break;
    collected.push(line.slice(blockIndent));
    cur.pos += 1;
  }
  while (collected.length > 0 && collected.at(-1) === "") collected.pop();
  const text = folded ? foldLines(collected) : collected.join("\n");
  if (chomp === "-") return text;
  return text === "" ? "" : `${text}\n`;
}

function foldLines(collected: readonly string[]): string {
  const paragraphs: string[][] = [[]];
  for (const line of collected) {
    if (line === "") paragraphs.push([]);
    else paragraphs.at(-1)!.push(line);
  }
  return paragraphs
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => paragraph.join(" "))
    .join("\n\n");
}

// — flow values —

function decodeFlow(text: string, where: string): JsonValue {
  if (text.startsWith("[")) {
    const decoded = decodeInlineArrayAt(text, 0, where);
    requireOnlyTrailingComment(text.slice(decoded.end), where);
    return decoded.value;
  }
  if (text.startsWith("{")) {
    throw new TypeError(`${where}: inline flow maps ({ ... }) are not supported; use a block map`);
  }
  if (text.startsWith('"') || text.startsWith("'")) {
    const quoted = decodeQuoted(text, 0, where);
    requireOnlyTrailingComment(text.slice(quoted.end), where);
    return quoted.value;
  }
  return decodeBareScalar(stripTrailingComment(text));
}

type InlineArray = Readonly<{ value: JsonValue[]; end: number }>;

function decodeInlineArrayAt(text: string, start: number, where: string): InlineArray {
  const items: JsonValue[] = [];
  let i = start + 1;
  let expectItem = true;
  for (;;) {
    while (i < text.length && /\s/u.test(text[i] ?? "")) i += 1;
    if (i >= text.length) throw new TypeError(`${where}: inline array is missing its closing \`]\``);
    if (text[i] === "]") return Object.freeze({ value: items, end: i + 1 });
    if (!expectItem) {
      if (text[i] !== ",") throw new TypeError(`${where}: inline array items must be comma-separated`);
      i += 1;
      expectItem = true;
      continue;
    }
    const char = text[i] ?? "";
    if (char === "{") {
      throw new TypeError(`${where}[${items.length}]: inline flow maps ({ ... }) are not supported; use a block map`);
    }
    if (char === "[") {
      const nested = decodeInlineArrayAt(text, i, `${where}[${items.length}]`);
      items.push(nested.value);
      i = nested.end;
    } else if (char === '"' || char === "'") {
      const quoted = decodeQuoted(text, i, where);
      items.push(quoted.value);
      i = quoted.end;
    } else {
      let j = i;
      while (j < text.length && text[j] !== "," && text[j] !== "]") j += 1;
      items.push(decodeBareScalar(text.slice(i, j).trim()));
      i = j;
    }
    expectItem = false;
  }
}

type Quoted = Readonly<{ value: string; end: number }>;

function decodeQuoted(text: string, start: number, where: string): Quoted {
  const quote = text[start];
  if (quote === "'") {
    let value = "";
    let i = start + 1;
    while (i < text.length) {
      if (text[i] === "'") {
        if (text[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        return Object.freeze({ value, end: i + 1 });
      }
      value += text[i] ?? "";
      i += 1;
    }
    throw new TypeError(`${where}: unterminated single-quoted string`);
  }
  let value = "";
  let i = start + 1;
  while (i < text.length) {
    const char = text[i] ?? "";
    if (char === '"') return Object.freeze({ value, end: i + 1 });
    if (char === "\\") {
      const escaped = text[i + 1];
      if (escaped === undefined) throw new TypeError(`${where}: dangling escape in double-quoted string`);
      if (escaped === "n") value += "\n";
      else if (escaped === "t") value += "\t";
      else if (escaped === "r") value += "\r";
      else if (escaped === '"' || escaped === "\\") value += escaped;
      else throw new TypeError(`${where}: unsupported escape \\${escaped} in double-quoted string`);
      i += 2;
      continue;
    }
    value += char;
    i += 1;
  }
  throw new TypeError(`${where}: unterminated double-quoted string`);
}

function decodeBareScalar(token: string): JsonValue {
  if (token === "") return "";
  if (token === "true") return true;
  if (token === "false") return false;
  if (token === "null" || token === "~") return null;
  if (DATE_PATTERN.test(token)) return token;
  if (INTEGER_PATTERN.test(token)) return Number(token);
  if (FLOAT_PATTERN.test(token)) return Number(token);
  return token;
}

function stripTrailingComment(token: string): string {
  for (let i = 0; i < token.length; i += 1) {
    if (token[i] === "#" && (i === 0 || /\s/u.test(token[i - 1] ?? ""))) {
      return token.slice(0, i).trim();
    }
  }
  return token.trim();
}

function requireOnlyTrailingComment(rest: string, where: string): void {
  const trimmed = rest.trim();
  if (trimmed !== "" && !trimmed.startsWith("#")) {
    throw new TypeError(`${where}: unexpected trailing content \`${trimmed}\``);
  }
}

// — encoding —

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function encodeEntry(lines: string[], rawKey: string, value: JsonValue, indent: number, where: string): void {
  const key = KEY_PATTERN.test(rawKey) ? rawKey : quoteString(rawKey);
  const pad = " ".repeat(indent);
  if (isPlainRecord(value)) {
    lines.push(`${pad}${key}:`);
    for (const [childKey, child] of Object.entries(value)) {
      if (child === undefined) continue;
      encodeEntry(lines, childKey, child as JsonValue, indent + 2, `${where}.${childKey}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}${key}: []`);
      return;
    }
    lines.push(`${pad}${key}:`);
    encodeSequence(lines, value, indent + 2, where);
    return;
  }
  if (typeof value === "string" && value.includes("\n")) {
    encodeBlockScalar(lines, `${pad}${key}:`, value, indent + 2);
    return;
  }
  lines.push(`${pad}${key}: ${encodeScalar(value)}`);
}

function encodeSequence(lines: string[], value: readonly JsonValue[], indent: number, where: string): void {
  const pad = " ".repeat(indent);
  for (const [index, item] of value.entries()) {
    const itemWhere = `${where}[${index}]`;
    if (isPlainRecord(item)) {
      encodeSequenceMapItem(lines, item, indent, itemWhere);
      continue;
    }
    if (Array.isArray(item)) {
      lines.push(`${pad}- ${encodeInlineArray(item, itemWhere)}`);
      continue;
    }
    if (typeof item === "string" && item.includes("\n")) {
      throw new TypeError(`${itemWhere}: multi-line strings are not encodable as sequence items`);
    }
    lines.push(`${pad}- ${encodeScalar(item)}`);
  }
}

function encodeSequenceMapItem(lines: string[], item: Readonly<Record<string, unknown>>, indent: number, where: string): void {
  const entries = Object.entries(item).filter(([, child]) => child !== undefined);
  if (entries.length === 0) throw new TypeError(`${where}: sequence map items must have at least one entry`);
  const dash = `${" ".repeat(indent)}- `;
  const before = lines.length;
  for (const [key, child] of entries) {
    encodeEntry(lines, key, child as JsonValue, indent + 2, `${where}.${key}`);
  }
  const first = lines[before];
  if (first !== undefined) lines[before] = `${dash}${first.slice(indent + 2)}`;
}

function encodeInlineArray(value: readonly JsonValue[], where: string): string {
  const items = value.map((item, index) => {
    if (isPlainRecord(item)) throw new TypeError(`${where}[${index}]: records inside nested arrays are not encodable`);
    if (Array.isArray(item)) return encodeInlineArray(item, `${where}[${index}]`);
    if (typeof item === "string" && item.includes("\n")) throw new TypeError(`${where}[${index}]: multi-line strings are not encodable inline`);
    return encodeScalar(item);
  });
  return `[${items.join(", ")}]`;
}

function encodeBlockScalar(lines: string[], keyLine: string, value: string, indent: number): void {
  const pad = " ".repeat(indent);
  const chomp = value.endsWith("\n") ? "" : "-";
  const body = value.endsWith("\n") ? value.slice(0, -1) : value;
  lines.push(`${keyLine} |${chomp}`);
  for (const line of body.split("\n")) {
    lines.push(line === "" ? "" : `${pad}${line}`);
  }
}

function encodeScalar(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("yaml: numbers must be finite");
    return String(value);
  }
  if (typeof value !== "string") throw new TypeError("yaml: scalars are strings, numbers, booleans, or null");
  return needsQuote(value) ? quoteString(value) : value;
}

function needsQuote(text: string): boolean {
  if (text === "" || text !== text.trim()) return true;
  if (DATE_PATTERN.test(text)) return false;
  if (/^[[\]{}"'>|*&!?@%#,`-]/u.test(text)) return true;
  if (/\s#/u.test(text) || text.includes("\n")) return true;
  // ": " and a trailing ":" are YAML's mapping indicator, so a plain scalar
  // cannot carry them: `- a: b` reads back as the map {a: "b"}, not the string
  // "a: b". Unquoted, a string silently becomes an object — the value changes
  // type on a round-trip through this encoder, which no caller can defend
  // against because nothing in the value is malformed.
  if (/:(?:\s|$)/u.test(text)) return true;
  if (/^(?:true|false|null|~)$/iu.test(text)) return true;
  if (INTEGER_PATTERN.test(text) || FLOAT_PATTERN.test(text)) return true;
  return false;
}

function quoteString(text: string): string {
  let out = '"';
  for (const char of text) {
    if (char === "\\" || char === '"') out += `\\${char}`;
    else if (char === "\n") out += "\\n";
    else if (char === "\t") out += "\\t";
    else if (char === "\r") out += "\\r";
    else out += char;
  }
  return `${out}"`;
}
