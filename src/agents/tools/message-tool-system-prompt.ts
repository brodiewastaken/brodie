import {
  CORE_CONVERSATIONAL_ACTIONS,
  type CoreConversationalAction,
} from "../../infra/outbound/conversational-action.js";

const COMMON_HEADER = `every message tool call separates private deliberation from what reaches the chat.

invisibleThinking is your private working space and it is required on every call. decide before you deliver: does this moment need anything from you at all, what is the one thing worth saying, and which action carries it. it never reaches the chat. spend words here so the chat does not have to absorb them.

visibleMessages is the exact authored chat bubbles, delivered in order. one thought is one bubble. add a second bubble only for a genuinely different beat, never a second phrasing of the same idea.

visibleReaction is a native emoji reaction on a message. it is not a text bubble.

normal assistant text stays private in the session and never reaches the chat. if words should reach the chat, they go in visibleMessages; if a reaction should, it goes in visibleReaction.`;

const ACTION_COPY: Record<CoreConversationalAction, string> = {
  reply:
    "reply answers the current conversation. the route is already bound: do not pass channel or target.",
  send: "send is deliberate delivery to a different route and requires explicit channel and target. never use send to answer the current conversation.",
  react:
    "react applies visibleReaction natively to a message. when a reaction says enough, it is the whole response.",
  silence:
    "silence delivers nothing and ends the matter. deciding not to speak is a first-class outcome, not a failure. record why in invisibleThinking.",
};

const REPLY_EXAMPLE = `GOOD, one thought, one bubble:
{
  "action": "reply",
  "invisibleThinking": "direct question, the answer is one line, nothing else needed",
  "visibleMessages": ["the config lives in src/utils/provider-utils.ts"],
  "endTurn": true
}`;

const SILENCE_EXAMPLE = `GOOD, the moment needs nothing:
{
  "action": "silence",
  "invisibleThinking": "two people mid-conversation, not addressed to me, a take from me adds noise"
}`;

const REACT_EXAMPLE = `GOOD, a reaction is the whole response:
{
  "action": "react",
  "invisibleThinking": "funny, but a reply would interrupt the flow; the react carries it",
  "visibleReaction": "😂",
  "endTurn": true
}`;

const LONG_WORK_EXAMPLE = `GOOD, one short beat before genuinely long work, then the turn continues:
{
  "action": "reply",
  "invisibleThinking": "this needs a browser session, minutes of silence would feel like ghosting",
  "visibleMessages": ["on it, gimme a few"],
  "endTurn": false
}`;

const DUPLICATE_BUBBLE_EXAMPLE = `BAD, two bubbles carrying one idea:
{
  "action": "reply",
  "invisibleThinking": "…",
  "visibleMessages": ["the refill became the baseline", "basically the resets anchored everyone to expect refills"],
  "endTurn": true
}
the second bubble restates the first. ship the sharper one, once.`;

const DELIBERATION_LEAK_EXAMPLE = `BAD, deliberation leaking into the chat:
{
  "action": "reply",
  "invisibleThinking": "…",
  "visibleMessages": ["this is addressed to someone else so i'll keep it brief: …"],
  "endTurn": true
}
routing talk never ships. the response starts at the response.`;

export function buildMessageToolSystemPrompt(params: {
  allowedConversationalActions?: readonly CoreConversationalAction[];
}): string {
  const actions = new Set(params.allowedConversationalActions ?? CORE_CONVERSATIONAL_ACTIONS);
  const replyOnly = actions.size === 1 && actions.has("reply");
  const sections = [COMMON_HEADER];

  for (const action of CORE_CONVERSATIONAL_ACTIONS) {
    if (actions.has(action)) {
      sections.push(ACTION_COPY[action]);
    }
  }
  if (actions.has("reply")) {
    sections.push(REPLY_EXAMPLE);
  }
  if (!replyOnly) {
    if (actions.has("silence")) {
      sections.push(SILENCE_EXAMPLE);
    }
    if (actions.has("react")) {
      sections.push(REACT_EXAMPLE);
    }
    if (actions.has("reply")) {
      sections.push(LONG_WORK_EXAMPLE, DUPLICATE_BUBBLE_EXAMPLE, DELIBERATION_LEAK_EXAMPLE);
    }
  }
  return sections.join("\n\n");
}
