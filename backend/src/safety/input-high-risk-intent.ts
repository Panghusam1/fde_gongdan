export interface InputHighRiskIntentConfig {
  actionTerms: string[];
  safetyTargetTerms: string[];
  negatingPrefixes: string[];
  safetyInquiryTerms: string[];
  maximumGapCharacters: number;
  prefixWindowCharacters: number;
}

function requireStringArray(
  record: Record<string, unknown>,
  field: string,
): string[] {
  const value = record[field];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    throw new Error(`input high-risk intent config has invalid ${field}`);
  }
  return value.map((item) => item.trim().toLowerCase());
}

export function parseInputHighRiskIntentConfig(
  value: unknown,
): InputHighRiskIntentConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("input high-risk intent config must be an object");
  }
  const record = value as Record<string, unknown>;
  const maximumGapCharacters = record.maximumGapCharacters;
  const prefixWindowCharacters = record.prefixWindowCharacters;
  if (
    !Number.isInteger(maximumGapCharacters) ||
    (maximumGapCharacters as number) < 0 ||
    (maximumGapCharacters as number) > 30
  ) {
    throw new Error(
      "input high-risk intent config has invalid maximumGapCharacters",
    );
  }
  if (
    !Number.isInteger(prefixWindowCharacters) ||
    (prefixWindowCharacters as number) < 1 ||
    (prefixWindowCharacters as number) > 30
  ) {
    throw new Error(
      "input high-risk intent config has invalid prefixWindowCharacters",
    );
  }
  return {
    actionTerms: requireStringArray(record, "actionTerms"),
    safetyTargetTerms: requireStringArray(record, "safetyTargetTerms"),
    negatingPrefixes: requireStringArray(record, "negatingPrefixes"),
    safetyInquiryTerms: requireStringArray(record, "safetyInquiryTerms"),
    maximumGapCharacters: maximumGapCharacters as number,
    prefixWindowCharacters: prefixWindowCharacters as number,
  };
}

function allIndexes(text: string, term: string): number[] {
  const indexes: number[] = [];
  let fromIndex = 0;
  while (fromIndex <= text.length - term.length) {
    const index = text.indexOf(term, fromIndex);
    if (index === -1) break;
    indexes.push(index);
    fromIndex = index + 1;
  }
  return indexes;
}

export function hasDirectHighRiskIntent(
  input: string,
  config: InputHighRiskIntentConfig,
): boolean {
  const text = input.trim().toLowerCase().replaceAll(/\s+/g, "");
  if (text === "") return false;

  for (const action of config.actionTerms) {
    for (const actionIndex of allIndexes(text, action)) {
      const prefix = text.slice(
        Math.max(0, actionIndex - config.prefixWindowCharacters),
        actionIndex,
      );
      if (config.negatingPrefixes.some((term) => prefix.endsWith(term))) {
        continue;
      }

      for (const target of config.safetyTargetTerms) {
        for (const targetIndex of allIndexes(text, target)) {
          const actionEnd = actionIndex + action.length;
          const targetEnd = targetIndex + target.length;
          const gap =
            actionIndex <= targetIndex
              ? targetIndex - actionEnd
              : actionIndex - targetEnd;
          if (gap < 0 || gap > config.maximumGapCharacters) continue;

          const matchedEnd = Math.max(actionEnd, targetEnd);
          const suffix = text.slice(matchedEnd);
          if (
            config.safetyInquiryTerms.some((term) => suffix.includes(term))
          ) {
            continue;
          }
          return true;
        }
      }
    }
  }
  return false;
}
