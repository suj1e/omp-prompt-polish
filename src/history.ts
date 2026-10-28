import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AssistantMessage, UserMessage } from "@oh-my-pi/pi-ai";

type HistoryReader = Pick<ExtensionContext["sessionManager"], "getLeafEntry" | "getEntry">;
type ChatMessage = UserMessage | AssistantMessage;

export interface ConversationText {
  role: "user" | "assistant";
  text: string;
}

const MESSAGE_LIMIT = 6;
const TOTAL_CHAR_LIMIT = 12_000;
const MESSAGE_CHAR_LIMIT = 4_000;
const TRUNCATED = "[前文已截断]\n";

function tail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let start = text.length - (limit - TRUNCATED.length);
  // Keep UTF-16 surrogate pairs intact at the truncation boundary.
  const first = text.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start++;
  return TRUNCATED + text.slice(start);
}

/** Read only visible text, keeping the end of long messages within the budget. */
function messageText(message: ChatMessage, limit: number): string {
  if (typeof message.content === "string") return tail(message.content, limit).trim();
  const parts: string[] = [];
  let remaining = limit;
  for (let index = message.content.length - 1; index >= 0 && remaining >= TRUNCATED.length + 2; index--) {
    const block = message.content[index];
    if (block.type !== "text" || !block.text.trim()) continue;
    const text = tail(block.text, remaining);
    parts.push(text);
    remaining -= text.length + 1;
  }
  return parts.reverse().join("\n").trim();
}

/** Follow the active leaf's parents so sibling branches never become reference material. */
export function recentConversation(history: HistoryReader): ConversationText[] {
  const recent: ConversationText[] = [];
  let remaining = TOTAL_CHAR_LIMIT;
  let entry = history.getLeafEntry();
  while (entry && recent.length < MESSAGE_LIMIT && remaining >= TRUNCATED.length + 2) {
    if (entry.type === "reset_boundary") break;
    if (entry.type === "message") {
      const message = entry.message;
      const eligible = message.role === "user"
        ? !message.synthetic && message.attribution !== "agent"
        : message.role === "assistant" && message.stopReason === "stop";
      if (eligible && (message.role === "user" || message.role === "assistant")) {
        const text = messageText(message, Math.min(MESSAGE_CHAR_LIMIT, remaining));
        if (text) {
          recent.push({ role: message.role, text });
          remaining -= text.length;
        }
      }
    }
    entry = entry.parentId === null ? undefined : history.getEntry(entry.parentId);
  }
  return recent.reverse();
}
