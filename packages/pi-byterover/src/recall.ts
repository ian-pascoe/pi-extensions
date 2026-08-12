const escapeRegExp = (value: string) => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

export const stripEchoedRecallQuery = (content: string, query: string) => {
  const trimmedContent = content.trim();
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) return trimmedContent;

  return trimmedContent
    .replace(
      new RegExp(
        `(\\*\\*Summary\\*\\*:[^\\n]*?)\\s+for\\s+"${escapeRegExp(trimmedQuery)}"(?=:)`,
        "u",
      ),
      "$1",
    )
    .trim();
};
