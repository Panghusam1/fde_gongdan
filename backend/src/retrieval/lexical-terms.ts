export const SEARCH_ANALYZER_NAME = "fde-cjk-bigram";
export const SEARCH_ANALYZER_VERSION = "1.0.0";

export type SearchTermKind = "fault_code" | "ascii_token" | "cjk_bigram";

export interface SearchTerm {
  kind: SearchTermKind;
  term: string;
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

export function buildSearchTerms(input: {
  text: string;
  sectionTitle?: string | null;
  faultCode?: string | null;
}): SearchTerm[] {
  const terms = new Map<string, SearchTerm>();
  const add = (kind: SearchTermKind, term: string): void => {
    const normalized = normalizedText(term).trim();
    if (normalized !== "") {
      terms.set(`${kind}:${normalized}`, { kind, term: normalized });
    }
  };

  if (input.faultCode?.trim()) {
    add("fault_code", input.faultCode);
  }

  const searchable = normalizedText(
    [input.faultCode, input.sectionTitle, input.text]
      .filter((value): value is string => Boolean(value))
      .join(" "),
  );
  for (const match of searchable.matchAll(/[a-z0-9]+(?:[-_.][a-z0-9]+)*/g)) {
    if (match[0].length >= 2) {
      add("ascii_token", match[0]);
    }
  }
  for (const match of searchable.matchAll(/[\p{Script=Han}]+/gu)) {
    const characters = Array.from(match[0]);
    for (let index = 0; index + 1 < characters.length; index += 1) {
      add("cjk_bigram", characters[index] + characters[index + 1]);
    }
  }

  return [...terms.values()].sort((left, right) =>
    `${left.kind}:${left.term}`.localeCompare(`${right.kind}:${right.term}`),
  );
}
