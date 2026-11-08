/**
 * A small, strict XML reader for RSS 2.0 / Atom feeds.
 *
 * Why not a library: feeds are untrusted input, and the classic XML attacks (external entities,
 * "billion laughs" entity expansion) all need a DTD. This reader refuses any <!DOCTYPE> or other
 * <! declaration outright, supports only the five built-in entities plus numeric references, and
 * enforces limits on size, depth and element count. Nothing is ever fetched or evaluated.
 *
 * Output is a plain object tree (see `xmlToObject`):
 *   <item><title>A</title><category>x</category><category>y</category></item>
 *     -> { title: "A", category: ["x", "y"] }
 *   <link href="u" rel="self"/>  ->  { "@href": "u", "@rel": "self" }
 *   <guid isPermaLink="true">u</guid>  ->  { "@isPermaLink": "true", "#text": "u" }
 */

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlParseError";
  }
}

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  text: string;
}

export interface XmlLimits {
  maxDepth: number;
  maxElements: number;
}

const DEFAULT_LIMITS: XmlLimits = { maxDepth: 64, maxElements: 200_000 };

const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const ATTRIBUTE = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,8});/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isInteger(code)) return "";
      if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) return "";
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
      return String.fromCodePoint(code);
    }
    // Unknown entities (e.g. &nbsp; in sloppy feeds) are kept literally; HTML decoding happens later.
    return NAMED_ENTITIES[body] ?? match;
  });
}

function parseAttributes(source: string, tagName: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  ATTRIBUTE.lastIndex = 0;
  let position = 0;
  const text = source.trim();
  while (position < text.length) {
    while (position < text.length && /\s/.test(text[position] ?? "")) position += 1;
    if (position >= text.length) break;
    ATTRIBUTE.lastIndex = position;
    const match = ATTRIBUTE.exec(text);
    if (match === null) throw new XmlParseError(`Malformed attribute in <${tagName}>`);
    const key = match[1] ?? "";
    // Own, non-prototype key only; "__proto__" as an attribute name must not poison the object.
    if (key !== "__proto__") attributes[key] = decodeXmlEntities(match[2] ?? match[3] ?? "");
    position = ATTRIBUTE.lastIndex;
  }
  return attributes;
}

/** Index of the ">" that ends the tag starting at `from`, skipping ">" inside quoted attribute values. */
function findTagEnd(xml: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < xml.length; i += 1) {
    const char = xml[i];
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i;
    }
  }
  return -1;
}

/** Parse a whole document and return its root element. */
export function parseXml(input: string, limits: Partial<XmlLimits> = {}): XmlElement {
  const { maxDepth, maxElements } = { ...DEFAULT_LIMITS, ...limits };
  const xml = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let elementCount = 0;
  let i = 0;

  const appendText = (text: string, raw: boolean) => {
    const current = stack[stack.length - 1];
    if (current === undefined) {
      if (text.trim() !== "") throw new XmlParseError("Text outside the root element");
      return;
    }
    current.text += raw ? text : decodeXmlEntities(text);
  };

  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      appendText(xml.slice(i), false);
      break;
    }
    if (lt > i) appendText(xml.slice(i, lt), false);

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) throw new XmlParseError("Unterminated comment");
      i = end + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1) throw new XmlParseError("Unterminated CDATA section");
      appendText(xml.slice(lt + 9, end), true);
      i = end + 3;
    } else if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) throw new XmlParseError("Unterminated processing instruction");
      i = end + 2;
    } else if (xml.startsWith("<!", lt)) {
      // <!DOCTYPE ...>, <!ENTITY ...>: the doorway to XXE and entity-expansion attacks.
      throw new XmlParseError("DTDs and other <! declarations are not allowed");
    } else if (xml.startsWith("</", lt)) {
      const end = xml.indexOf(">", lt + 2);
      if (end === -1) throw new XmlParseError("Unterminated closing tag");
      const name = xml.slice(lt + 2, end).trim();
      const open = stack.pop();
      if (open === undefined || open.name !== name) {
        throw new XmlParseError(`Unexpected closing tag </${name}>`);
      }
      i = end + 1;
    } else {
      const end = findTagEnd(xml, lt + 1);
      if (end === -1) throw new XmlParseError("Unterminated tag");
      let body = xml.slice(lt + 1, end);
      const selfClosing = body.endsWith("/");
      if (selfClosing) body = body.slice(0, -1);

      const nameMatch = /^[^\s/>]+/.exec(body);
      const name = nameMatch?.[0] ?? "";
      if (!NAME.test(name)) throw new XmlParseError(`Invalid element name "${name.slice(0, 40)}"`);

      elementCount += 1;
      if (elementCount > maxElements) throw new XmlParseError("Document has too many elements");

      const element: XmlElement = {
        name,
        attributes: parseAttributes(body.slice(name.length), name),
        children: [],
        text: "",
      };
      const parent = stack[stack.length - 1];
      if (parent !== undefined) parent.children.push(element);
      else if (root === undefined) root = element;
      else throw new XmlParseError("More than one root element");

      if (!selfClosing) {
        stack.push(element);
        if (stack.length > maxDepth) throw new XmlParseError("Document is nested too deeply");
      }
      i = end + 1;
    }
  }

  if (stack.length > 0) throw new XmlParseError(`Unexpected end of document (<${stack[stack.length - 1]?.name}> not closed)`);
  if (root === undefined) throw new XmlParseError("No root element");
  return root;
}

export type XmlValue = string | XmlObject | XmlValue[];
export interface XmlObject {
  [key: string]: XmlValue;
}

/** Convert an element tree into plain objects (see the file header for the shape). */
export function xmlToObject(element: XmlElement): XmlValue {
  const attributeKeys = Object.keys(element.attributes);
  const text = element.text.trim();

  if (element.children.length === 0 && attributeKeys.length === 0) return text;

  const result: XmlObject = Object.create(null) as XmlObject;
  for (const key of attributeKeys) result[`@${key}`] = element.attributes[key] ?? "";
  if (text !== "") result["#text"] = text;

  for (const child of element.children) {
    const value = xmlToObject(child);
    const existing = result[child.name];
    if (existing === undefined) result[child.name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else result[child.name] = [existing, value];
  }
  return result;
}
