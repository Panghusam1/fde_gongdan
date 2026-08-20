function extractAtvFamilies(text: string): string[] {
  return [...text.toUpperCase().matchAll(/ATV[\s_-]?(\d{2,4})/g)].map(
    (match) => `ATV${match[1]}`,
  );
}

export function hasConflictingAtvProductFamily(
  queryText: string,
  allowedFamilyCode: string,
): boolean {
  const allowedFamilies = new Set(extractAtvFamilies(allowedFamilyCode));
  if (allowedFamilies.size === 0) return false;
  return extractAtvFamilies(queryText).some(
    (mentionedFamily) => !allowedFamilies.has(mentionedFamily),
  );
}

