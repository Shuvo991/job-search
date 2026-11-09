/**
 * PDF export with @react-pdf/renderer (a real PDF layout engine; HTML is never converted to PDF).
 *
 * Built for machine readability (applicant tracking systems read the text layer, in order):
 *  - ONE column, top to bottom. No tables, columns, text boxes, icons, images, headers or footers.
 *  - Standard section headings (PROFESSIONAL SUMMARY, SKILLS, WORK EXPERIENCE, EDUCATION).
 *  - Built-in Helvetica only (real text, no embedded font surprises); black text on white.
 *  - Automatic hyphenation is switched OFF. Otherwise a long word is split at a line end
 *    ("Develop-" / "ment") and the extracted text no longer contains the word.
 *  - Bullets are a plain "•" character inside the same text run as the sentence.
 *  - Document title and author are set in the PDF metadata.
 *
 * Server-side only (used by POST /api/documents/pdf). Every string passes through toPdfText first.
 */
import {
  Document,
  Font,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
  type DocumentProps,
} from "@react-pdf/renderer";
import type { ReactElement } from "react";
import { toPdfText } from "@/lib/pdf/safe-text";
import {
  CV_SECTION_TITLES,
  contactLine,
  educationLine,
  experienceDetailLine,
} from "@/lib/tailoring/documents";
import type { CoverLetterDocument, CvDocument } from "@/schemas/tailoring";

// Never split a word across lines (see the note above).
Font.registerHyphenationCallback((word) => [word]);

const BLACK = "#000000";

const styles = StyleSheet.create({
  page: {
    paddingTop: 42,
    paddingBottom: 42,
    paddingHorizontal: 48,
    fontFamily: "Helvetica",
    fontSize: 10,
    lineHeight: 1.35,
    color: BLACK,
  },
  name: { fontFamily: "Helvetica-Bold", fontSize: 20, marginBottom: 3 },
  contact: { fontSize: 9.5, marginBottom: 4 },
  headingBox: {
    marginTop: 12,
    marginBottom: 5,
    paddingBottom: 2,
    borderBottomWidth: 0.75,
    borderBottomColor: BLACK,
    borderBottomStyle: "solid",
  },
  heading: { fontFamily: "Helvetica-Bold", fontSize: 11 },
  paragraph: { marginBottom: 4 },
  entry: { marginBottom: 7 },
  entryTitle: { fontFamily: "Helvetica-Bold" },
  entryDetail: { marginBottom: 2 },
  bullet: { marginBottom: 1.5 },
  letterBlock: { marginBottom: 12 },
  letterParagraph: { marginBottom: 9, lineHeight: 1.45 },
});

const p = toPdfText;

function Heading({ title }: { title: string }) {
  return (
    <View style={styles.headingBox} minPresenceAhead={50}>
      <Text style={styles.heading}>{p(title)}</Text>
    </View>
  );
}

export function buildCvPdf(doc: CvDocument): ReactElement<DocumentProps> {
  const contact = contactLine(doc);
  return (
    <Document title={p(`${doc.fullName} - CV`)} author={p(doc.fullName)} subject="CV" creator="Tech Job Board" producer="Tech Job Board">
      <Page size="A4" style={styles.page}>
        <Text style={styles.name}>{p(doc.fullName)}</Text>
        {contact !== "" ? <Text style={styles.contact}>{p(contact)}</Text> : null}

        {doc.summary !== "" ? (
          <View>
            <Heading title={CV_SECTION_TITLES.summary} />
            <Text style={styles.paragraph}>{p(doc.summary)}</Text>
          </View>
        ) : null}

        {doc.skills.length > 0 ? (
          <View>
            <Heading title={CV_SECTION_TITLES.skills} />
            <Text style={styles.paragraph}>{p(doc.skills.join(", "))}</Text>
          </View>
        ) : null}

        {doc.experience.length > 0 ? (
          <View>
            <Heading title={CV_SECTION_TITLES.experience} />
            {doc.experience.map((entry, index) => {
              const detail = experienceDetailLine(entry);
              return (
                <View key={`exp-${index}`} style={styles.entry}>
                  <View wrap={false}>
                    {entry.title !== "" ? <Text style={styles.entryTitle}>{p(entry.title)}</Text> : null}
                    {detail !== "" ? <Text style={styles.entryDetail}>{p(detail)}</Text> : null}
                  </View>
                  {entry.bullets.map((bullet, bulletIndex) => (
                    <Text key={`exp-${index}-${bulletIndex}`} style={styles.bullet}>
                      {p(`• ${bullet}`)}
                    </Text>
                  ))}
                </View>
              );
            })}
          </View>
        ) : null}

        {doc.education.length > 0 ? (
          <View>
            <Heading title={CV_SECTION_TITLES.education} />
            {doc.education.map((entry, index) => (
              <Text key={`edu-${index}`} style={styles.paragraph}>
                {p(educationLine(entry))}
              </Text>
            ))}
          </View>
        ) : null}

        {doc.additional.map((section, index) => (
          <View key={`add-${index}`}>
            <Heading title={section.heading.toUpperCase()} />
            {section.items.map((item, itemIndex) => (
              <Text key={`add-${index}-${itemIndex}`} style={styles.bullet}>
                {p(item)}
              </Text>
            ))}
          </View>
        ))}
      </Page>
    </Document>
  );
}

export function buildCoverLetterPdf(doc: CoverLetterDocument): ReactElement<DocumentProps> {
  const senderContact = [doc.location, doc.phone, doc.email].filter((part) => part !== "").join(" | ");
  return (
    <Document
      title={p(`${doc.senderName} - Cover letter`)}
      author={p(doc.senderName)}
      subject="Cover letter"
      creator="Tech Job Board"
      producer="Tech Job Board"
    >
      <Page size="A4" style={{ ...styles.page, fontSize: 10.5 }}>
        <View style={styles.letterBlock}>
          <Text style={styles.name}>{p(doc.senderName)}</Text>
          {senderContact !== "" ? <Text style={styles.contact}>{p(senderContact)}</Text> : null}
        </View>

        <View style={styles.letterBlock}>
          {doc.date !== "" ? <Text>{p(doc.date)}</Text> : null}
          {doc.company !== "" ? <Text>{p(doc.company)}</Text> : null}
          {doc.jobTitle !== "" ? <Text>{p(`Re: ${doc.jobTitle}`)}</Text> : null}
        </View>

        <Text style={styles.letterParagraph}>{p(doc.greeting)}</Text>
        {doc.paragraphs.map((paragraph, index) => (
          <Text key={`para-${index}`} style={styles.letterParagraph}>
            {p(paragraph)}
          </Text>
        ))}
        {doc.closing !== "" ? <Text style={styles.letterParagraph}>{p(doc.closing)}</Text> : null}

        <View wrap={false}>
          <Text>{p(doc.signOff)}</Text>
          <Text style={styles.entryTitle}>{p(doc.senderName)}</Text>
        </View>
      </Page>
    </Document>
  );
}

export async function renderCvPdf(doc: CvDocument): Promise<Buffer> {
  return renderToBuffer(buildCvPdf(doc));
}

export async function renderCoverLetterPdf(doc: CoverLetterDocument): Promise<Buffer> {
  return renderToBuffer(buildCoverLetterPdf(doc));
}
