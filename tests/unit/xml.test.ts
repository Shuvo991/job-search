import { describe, expect, it } from "vitest";
import { parseXml, xmlToObject, XmlParseError } from "@/lib/feeds/xml";

describe("parseXml / xmlToObject", () => {
  it("reads elements, repeated children, CDATA, entities and attributes", () => {
    const root = parseXml(`<?xml version="1.0" encoding="UTF-8"?>
      <!-- a comment -->
      <rss version="2.0" xmlns:tt="http://www.teamtailor.com/rss">
        <channel>
          <title>Jobs &amp; more</title>
          <item>
            <title>Dev &#38; Ops &#x41;</title>
            <description><![CDATA[<p>Hello <b>world</b> &amp; friends</p>]]></description>
            <category>a</category><category>b</category>
            <guid isPermaLink="true">https://x.test/1</guid>
            <tt:department>Engineering</tt:department>
            <link href="https://x.test/self" rel="self"/>
          </item>
        </channel>
      </rss>`);

    expect(root.name).toBe("rss");
    const object = xmlToObject(root) as Record<string, any>;
    expect(object["@version"]).toBe("2.0");
    expect(object["channel"]["title"]).toBe("Jobs & more");
    const item = object["channel"]["item"];
    expect(item["title"]).toBe("Dev & Ops A");
    // CDATA is taken literally: markup and entities inside it are left for the HTML sanitiser
    expect(item["description"]).toBe("<p>Hello <b>world</b> &amp; friends</p>");
    expect(item["category"]).toEqual(["a", "b"]);
    expect(item["guid"]).toEqual({ "@isPermaLink": "true", "#text": "https://x.test/1" });
    expect(item["tt:department"]).toBe("Engineering");
    expect(item["link"]).toEqual({ "@href": "https://x.test/self", "@rel": "self" });
  });

  it("keeps unknown entities literally and drops invalid character references", () => {
    const root = parseXml("<a>x&nbsp;y &#0; &#xD800; &#1114112; z</a>");
    expect(xmlToObject(root)).toBe("x&nbsp;y    z");
  });

  it("handles '>' inside attribute values", () => {
    const root = parseXml('<a><b title="1 > 0" other=\'x\'>t</b></a>');
    expect(xmlToObject(root)).toEqual({ b: { "@title": "1 > 0", "@other": "x", "#text": "t" } });
  });

  it("strips a byte-order mark", () => {
    expect(xmlToObject(parseXml("﻿<a>1</a>"))).toBe("1");
  });

  describe("refuses dangerous or broken input", () => {
    it.each([
      ["a DOCTYPE", '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><a>&xxe;</a>'],
      ["an ENTITY declaration", "<a><!ENTITY x 'y'></a>"],
      ["a billion-laughs payload", '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><lolz>&lol2;</lolz>'],
      ["mismatched tags", "<a><b></a></b>"],
      ["an unclosed element", "<a><b>text</b>"],
      ["an unterminated comment", "<a><!-- oops</a>"],
      ["an unterminated CDATA", "<a><![CDATA[oops</a>"],
      ["an unterminated tag", "<a"],
      ["text outside the root", "hello<a/>"],
      ["two roots", "<a/><b/>"],
      ["an empty document", "   "],
      ["a bad element name", "<1a/>"],
      ["a malformed attribute", "<a x=1/>"],
    ])("%s", (_label, xml) => {
      expect(() => parseXml(xml)).toThrow(XmlParseError);
    });

    it("never expands an entity, even without a DTD", () => {
      expect(xmlToObject(parseXml("<a>&lol; &xxe;</a>"))).toBe("&lol; &xxe;");
    });

    it("enforces depth and element limits", () => {
      const deep = "<a>".repeat(70) + "</a>".repeat(70);
      expect(() => parseXml(deep)).toThrow(/nested too deeply/);
      expect(() => parseXml("<a>" + "<b/>".repeat(20) + "</a>", { maxElements: 10 })).toThrow(/too many elements/);
    });

    it("does not let a __proto__ attribute or element pollute objects", () => {
      const object = xmlToObject(parseXml('<a __proto__="x"><__proto__>y</__proto__></a>')) as Record<string, unknown>;
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
      expect(Object.getPrototypeOf(object)).toBeNull();
    });
  });

  it("parses a large feed quickly", () => {
    const items = Array.from({ length: 5000 }, (_, i) => `<item><title>Job ${i}</title><description><![CDATA[<p>${"x".repeat(200)}</p>]]></description></item>`);
    const started = Date.now();
    const object = xmlToObject(parseXml(`<rss><channel>${items.join("")}</channel></rss>`)) as any;
    expect(object.channel.item).toHaveLength(5000);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
