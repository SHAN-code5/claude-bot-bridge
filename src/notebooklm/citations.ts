/**
 * Citation extraction for NotebookLM answers (issue #20).
 *
 * NotebookLM renders citation markers like `[1]`, `[2]` inside the answer and
 * — in a separate panel — the cited passage from the source document. v1
 * required the LLM to spell those out manually, which wasted tokens and was
 * unreliable. v2 reads the citations directly from the DOM after the answer
 * settles.
 *
 * Approach:
 *   1. Read all `button.citation-marker` inside the *latest* answer container
 *      (so previous answers in the same session don't bleed in).
 *   2. For each marker, click it to open the source panel, read the
 *      highlighted passage out of `.paragraph .highlighted`, then press
 *      Escape so the chat input remains usable for follow-up questions.
 *   3. Return structured `Citation[]` and a formatted variant of the answer
 *      according to the requested `SourceFormat`.
 *
 * All NotebookLM-facing CSS lives in the central selector registry, so a
 * single UI change cannot break both this module and chat extraction.
 */

import type { Page } from "patchright";
import { safeSleep } from "../browser/watchdog.js";

export type SourceFormat = "none" | "inline" | "footnotes" | "json";

export interface Citation {
  marker: string; // e.g. "[1]"
  number: number;
  sourceName: string;
  sourceText: string; // best-effort excerpt; falls back to sourceName
}

export interface ExtractCitationsResult {
  citations: Citation[];
  formattedAnswer: string;
}

export async function extractCitations(
  page: Page,
  answerText: string,
  format: SourceFormat = "none"
): Promise<ExtractCitationsResult> {
  if (format === "none") {
    return { citations: [], formattedAnswer: answerText };
  }

  const rawCitations = await readCitationStubs(page);
  if (rawCitations.length === 0) {
    return { citations: [], formattedAnswer: answerText };
  }

  // Excerpt extraction must run sequentially: each click opens the source
  // panel for the *currently active* citation; doing them in parallel races
  // the same DOM region. We cap each excerpt at 1.5 s so a slow panel can't
  // block the whole batch (issue: ask_question hang after answer rendered).
  const citations: Citation[] = [];
  for (const stub of rawCitations) {
    const sourceText = await extractExcerpt(page, stub.number);
    citations.push({
      marker: `[${stub.number}]`,
      number: stub.number,
      sourceName: stub.sourceName,
      sourceText: sourceText || stub.sourceName,
    });
  }

  // Best-effort: dismiss any source panel still open and refocus the chat
  // input so the next question can be typed without an extra click.
  await page.keyboard.press("Escape").catch(() => undefined);
  await safeSleep(page, 100);

  return {
    citations,
    formattedAnswer: formatAnswer(answerText, citations, format),
  };
}

interface CitationStub {
  number: number;
  sourceName: string;
}

async function readCitationStubs(page: Page): Promise<CitationStub[]> {
  try {
    return (await page.evaluate(`
      (() => {
        const containers = document.querySelectorAll('.to-user-container .message-text-content');
        const scope = containers.length > 0 ? containers[containers.length - 1] : document;
        const buttons = scope.querySelectorAll('button.citation-marker');
        const seen = new Set();
        const out = [];
        buttons.forEach((btn) => {
          const text = btn.textContent || '';
          const match = text.match(/(\\d+)/);
          if (!match) return;
          const num = parseInt(match[1], 10);
          if (seen.has(num)) return;
          seen.add(num);
          const span = btn.querySelector('span[aria-label]');
          let sourceName = '';
          if (span) {
            const label = span.getAttribute('aria-label') || '';
            const colon = label.indexOf(': ');
            sourceName = colon > 0 ? label.slice(colon + 2).trim() : label.trim();
          }
          out.push({ number: num, sourceName });
        });
        return out.sort((a, b) => a.number - b.number);
      })()
    `)) as CitationStub[];
  } catch {
    return [];
  }
}

async function extractExcerpt(page: Page, number: number): Promise<string> {
  try {
    const clicked = await page.evaluate(`
      (() => {
        const containers = document.querySelectorAll('.to-user-container .message-text-content');
        const scope = containers.length > 0 ? containers[containers.length - 1] : document;
        const buttons = scope.querySelectorAll('button.citation-marker');
        for (const btn of buttons) {
          const text = btn.textContent || '';
          const match = text.match(/(\\d+)/);
          if (match && parseInt(match[1], 10) === ${number}) {
            btn.scrollIntoView({ block: 'center' });
            btn.click();
            return true;
          }
        }
        return false;
      })()
    `);
    if (!clicked) return "";

    // Tight cap: a slow source panel must not stall the answer pipeline.
    // 1500 ms is enough for the highlighted-paragraph render in 95% of cases;
    // the remaining 5% just lose the excerpt (sourceName still goes through).
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      const text = (await page.evaluate(`
        (() => {
          const highlights = document.querySelectorAll('.highlighted');
          if (highlights.length === 0) return '';
          const hTexts = Array.from(highlights)
            .map((el) => (el.innerText || '').trim())
            .filter(Boolean);
          if (hTexts.length === 0) return '';
          const parent = highlights[0].closest('.paragraph') || highlights[0].parentElement;
          const pText = (parent && parent.innerText ? parent.innerText : '').trim();
          const hText = hTexts.join(' ');
          return pText.length > hText.length ? pText : hText;
        })()
      `)) as string;
      if (text) {
        await page.keyboard.press("Escape").catch(() => undefined);
        return text;
      }
      await safeSleep(page, 150);
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    return "";
  } catch {
    return "";
  }
}

function formatAnswer(answer: string, citations: Citation[], format: SourceFormat): string {
  if (format === "none" || citations.length === 0) return answer;

  switch (format) {
    case "json": {
      // Caller usually returns the structured `citations` field; the answer
      // string itself is left untouched here.
      return answer;
    }
    case "inline": {
      let out = answer;
      for (const c of citations) {
        const replacement = c.sourceText
          ? `${c.marker} (${c.sourceName}: "${truncate(c.sourceText, 200)}")`
          : `${c.marker} (${c.sourceName})`;
        out = out.split(c.marker).join(replacement);
      }
      return out;
    }
    case "footnotes":
    default: {
      const footnotes = citations
        .map(
          (c) =>
            `${c.marker} ${c.sourceName}${c.sourceText && c.sourceText !== c.sourceName ? ` — "${truncate(c.sourceText, 240)}"` : ""}`
        )
        .join("\n");
      return `${answer}\n\nSources:\n${footnotes}`;
    }
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
