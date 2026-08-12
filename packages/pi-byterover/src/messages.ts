export type PiSessionMessage = { id: string; role: "user" | "assistant"; text: string };
export type SessionMessage = PiSessionMessage;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const isPiSessionMessageRole = (role: unknown): role is PiSessionMessage["role"] => {
  return role === "user" || role === "assistant";
};

const extractTextContent = (content: unknown) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  return content
    .flatMap((block) => {
      if (!isRecord(block)) return [];
      if (block.type !== "text") return [];
      if (typeof block.text !== "string") return [];

      const text = block.text.trim();
      return text ? [text] : [];
    })
    .join("\n");
};

export const extractPiSessionMessages = (entries: Array<unknown>): Array<PiSessionMessage> => {
  return entries.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    if (entry.type !== "message") return [];
    if (typeof entry.id !== "string") return [];
    if (!isRecord(entry.message)) return [];
    if (!isPiSessionMessageRole(entry.message.role)) return [];

    const text = extractTextContent(entry.message.content);
    if (text === undefined) return [];

    return [{ id: entry.id, role: entry.message.role, text }];
  });
};

export const formatMessage = (message: PiSessionMessage) => {
  const text = message.text.trim();
  if (!text) return "";
  return `[${message.role}]: ${text}`;
};

export const formatMessages = (messages: Array<PiSessionMessage>) => {
  return messages.map(formatMessage).filter(Boolean).join("\n\n");
};

export const turnKey = (messages: Array<PiSessionMessage>) => {
  return messages.map((message) => message.id).join(":");
};

export const selectMessagesInTurn = (messages: Array<PiSessionMessage>) => {
  const selected: Array<PiSessionMessage> = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    selected.unshift(message);
    if (message.role === "user") break;
  }
  return selected;
};

export const selectMessagesForRecall = (
  messages: Array<PiSessionMessage>,
  options: { maxRecallTurns: number; maxRecallChars: number },
) => {
  const selected: Array<PiSessionMessage> = [];
  let userTurns = 0;
  let charCount = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    const formatted = formatMessage(message);
    if (!formatted) continue;

    const separatorLength = selected.length === 0 ? 0 : 2;
    const nextCharCount = charCount + separatorLength + formatted.length;
    if (selected.length > 0 && nextCharCount > options.maxRecallChars) break;

    selected.unshift(message);
    charCount = nextCharCount;

    if (message.role === "user") {
      userTurns++;
      if (userTurns >= options.maxRecallTurns) break;
    }
  }

  return selected;
};
