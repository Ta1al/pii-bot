import { serverUrl } from "./llamaServer.js";

export type RiskTier = "none" | "weak" | "medium" | "strong";

export interface ContextMessage {
  /** Stable identifier used only to distinguish speakers in this assessment. */
  authorId: string;
  content: string;
}

export interface RiskInput {
  current: string;
  /** Identifier of the author of the current message. */
  currentAuthorId: string;
  /** Earlier messages in the channel, oldest first. */
  history?: ContextMessage[];
  /** The message this one replies to, if any. */
  reply?: ContextMessage | null;
}

export interface RiskContextEntry {
  speaker: string;
  content: string;
}

export interface RiskResult {
  flagged: boolean;
  /** Tier the model chose. */
  tier: RiskTier;
  /** Probability the model assigned to that tier. */
  score: number;
  /** Kind of identifying detail, e.g. "location". */
  kind: string;
  kindScore: number;
  /** Probability of every tier, for logging and tuning. */
  scores: Record<string, number>;
}

export interface RiskTimings {
  /** Time spent waiting for the single inference slot. */
  queueMs: number;
  /** Queue size, including this assessment, when it was queued. */
  queueSize: number;
  /** Time spent sending the request and processing the model response. */
  processMs: number;
}

export interface RiskAssessment {
  result: RiskResult;
  timings: RiskTimings;
}

const MEDIUM_THRESHOLD = Number(process.env.RISK_MEDIUM_THRESHOLD ?? 0.65);
const KIND_RESCUE = Number(process.env.RISK_KIND_RESCUE ?? 0.9);
const KIND_RESCUE_MEDIUM_SUPPORT = Number(
  process.env.RISK_KIND_RESCUE_MEDIUM_SUPPORT ?? 0.2
);
const TIMEOUT_MS = Number(process.env.RISK_TIMEOUT_MS ?? 120_000);
const MAX_PENDING = Number(process.env.RISK_MAX_PENDING ?? 200);

const QUESTIONS = {
  tier: {
    type: "choice",
    instructions:
      "Read the whole conversation. The current message is the last line and " +
      "was written by me. Judge only information about me, not information " +
      "about somebody else or a hypothetical person. Combine compatible clues " +
      "from the current message, earlier messages, and the replied-to message. " +
      "A clue may be indirect or identifying only in combination, but do not " +
      "treat generic personal conversation as risky merely because it is true " +
      "about me. Rate whether a stranger could use the resulting information " +
      "to identify, locate, contact, profile, manipulate, impersonate, access, " +
      "or target me. Resolve ordinary conversational ellipsis and fragments: " +
      "a short current message can complete or specify a first-person fact " +
      "introduced earlier by the same speaker. The current message must add, " +
      "confirm, or complete the risky fact; do not flag it only because an " +
      "unrelated earlier message contained personal information.",
    criteria: {
      none:
      "No actionable identifying or targeting information about me. This " +
      "includes general conversation, technical discussion, opinions, " +
      "questions, trivia, ordinary family or relationship references, " +
      "generic preferences, and facts that are not connected to me.",
      weak:
      "A broad, low-uniqueness fact about me that is shared by many people " +
      "and is not useful for identifying, locating, contacting, profiling, " +
      "or targeting me. A single vague feeling, preference, activity, time, " +
      "or quantity usually belongs here when it is not linked to another " +
      "identifying clue.",
      medium:
      "Information that could materially help identify, locate, contact, " +
      "profile, manipulate, impersonate, access, or target me, even if it " +
      "is not unique alone. This includes a specific area or venue, an " +
      "employer or school tied to me, a schedule or imminent plan, a " +
      "distinctive possession, a vulnerability, health or financial detail, " +
      "a secret, a rare circumstance, or compatible clues assembled across " +
      "messages. Do not use this tier for an ordinary fact unless the " +
      "conversation makes it meaningfully useful against me.",
      strong:
      "A direct identifier or highly sensitive secret belonging to me that " +
      "can identify, reach, impersonate, or access me directly: a precise " +
      "address, email, phone number, official identifier, account or payment " +
      "information, password, token, or equivalent credential. Do not use " +
      "this tier merely because a fact is unusual or sensitive.",
    },
  },
  kind: {
    type: "choice",
    instructions:
      "Identify the main kind of identifying information about me revealed by " +
      "the conversation. Consider the current message together with compatible " +
      "earlier clues. Ignore details about other people, examples, and topics " +
      "that are not connected to me. Resolve short replies and fragments using " +
      "the same-speaker context. Choose none when the message only mentions " +
      "a normal personal topic without creating a useful way to identify, " +
      "locate, contact, profile, manipulate, or target me.",
    criteria: {
      none: "No identifying detail about me",
      contact:
        "A way to contact or locate my communications account, including an " +
        "email address, phone number, username, or social handle",
      location:
        "Where I live, am, work, study, regularly go, or plan to go, including " +
        "a geographic area, venue, event, route, or other place inferred from " +
        "indirect clues",
      demographic:
        "A characteristic used to describe or classify me, such as age, " +
        "gender, nationality, language, or similar background",
      affiliation:
        "An organisation, employer, school, team, community, service, or other " +
        "group I belong to or am associated with",
      routine:
        "A recurring behaviour, schedule, shift, appointment, travel pattern, " +
        "or plan that reveals when or how to find me",
      appearance:
        "A distinctive physical characteristic, vehicle, clothing, equipment, " +
        "possession, or other observable attribute associated with me",
      credential:
        "A secret or access-related identifier, such as a password, token, " +
        "badge, account number, or payment detail",
      relationship:
        "A person or relationship connected to me, such as a family member, " +
        "partner, friend, colleague, or dependent",
      sensitive:
        "Personal information that could be used to manipulate, shame, exploit, " +
        "or pressure me, including health, emotional, financial, legal, or " +
        "other vulnerabilities not better described by another kind",
    },
  },
} as const;

interface ChoiceAnswer {
  type: "choice";
  choice: string | null;
  probabilities: Record<string, number>;
  confidence: number;
}

interface SystemOneResponse {
  answers: {
    tier: ChoiceAnswer;
    kind: ChoiceAnswer;
  };
}

/** Assigns stable speaker labels for one assessment. */
function labelContext(input: RiskInput): RiskContextEntry[] {
  const { current, currentAuthorId, history, reply } = input;
  const entries: RiskContextEntry[] = [];
  const participants = new Map<string, string>();
  let nextParticipant = 1;

  const labelFor = (authorId: string): string => {
    const existing = participants.get(authorId);
    if (existing) return existing;

    const label = `person${nextParticipant++}`;
    participants.set(authorId, label);
    return label;
  };

  participants.set(currentAuthorId, "me");
  history?.forEach((message) => {
    entries.push({ speaker: labelFor(message.authorId), content: message.content });
  });
  if (reply) {
    entries.push({ speaker: labelFor(reply.authorId), content: reply.content });
  }
  entries.push({ speaker: "me", content: current });
  return entries;
}

/** Returns the complete context in a compact form suitable for logs. */
export function formatContext(input: RiskInput): RiskContextEntry[] {
  return labelContext(input).map(({ speaker, content }) => ({
    speaker,
    content: content.slice(0, 10),
  }));
}

/** Renders the conversation into the single state string the model reads. */
export function buildState(input: RiskInput): string {
  const { history, reply } = input;
  const context = labelContext(input);
  const parts: string[] = [];

  if (history && history.length > 0) {
    const lines = context
      .slice(0, history.length)
      .map((entry) => `${entry.speaker}: ${entry.content}`);
    parts.push(`Earlier in this channel:\n${lines.join("\n")}`);
  }

  if (reply) {
    const replyEntry = context[history?.length ?? 0];
    parts.push(
      `The current message replies to:\n${replyEntry.speaker}: ${replyEntry.content}`
    );
  }

  const currentEntry = context[context.length - 1];
  parts.push(`Current message from me:\n${currentEntry.content}`);

  return parts.join("\n");
}

// The server evaluates one request at a time, so queue work rather than
// letting a busy channel spawn hundreds of sockets.
let active = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<number | null> {
  if (active === 0) {
    active++;
    return 0;
  }
  if (waiting.length >= MAX_PENDING) return null;
  const queueSize = waiting.length + 1;
  await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  return queueSize;
}

function release(): void {
  active--;
  waiting.shift()?.();
}

/**
 * Estimates how much the current message, read together with the surrounding
 * conversation, narrows down its author. This is re-identification risk, not a
 * traditional PII regex.
 */
export async function assessRisk(input: RiskInput): Promise<RiskAssessment> {
  const queueStart = Date.now();
  const queueSize = await acquire();
  if (queueSize === null) {
    throw new Error("risk queue is full; skipping message");
  }
  const processStart = Date.now();

  try {
    const res = await fetch(`${serverUrl}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({ state: buildState(input), questions: QUESTIONS }),
    });

    if (!res.ok) {
      throw new Error(`systemone request failed: ${res.status} ${await res.text()}`);
    }

    const body = (await res.json()) as SystemOneResponse;
    return {
      result: decide(body),
      timings: {
        queueMs: processStart - queueStart,
        queueSize,
        processMs: Date.now() - processStart,
      },
    };
  } finally {
    release();
  }
}

const TIER_ORDER: RiskTier[] = ["none", "weak", "medium", "strong"];

/** One-line summary of a result, used for the chat reply and the log. */
export function describeRisk(result: RiskResult): string {
  const scores = TIER_ORDER.filter((tier) => tier in result.scores)
    .map((tier) => `${tier} ${(result.scores[tier] ?? 0).toFixed(2)}`)
    .join(" · ");

  return (
    `risk: **${result.tier}** (${result.score.toFixed(2)}) · ` +
    `kind: ${result.kind} (${result.kindScore.toFixed(2)})\n` +
    scores
  );
}

/** Converts the model's tier distribution into a 0-10 expected risk score. */
export function getRiskNumber(result: RiskResult): number {
  const severity: Record<RiskTier, number> = {
    none: 0,
    weak: 3,
    medium: 7,
    strong: 10,
  };
  const weighted = TIER_ORDER.reduce(
    (total, tier) => total + (result.scores[tier] ?? 0) * severity[tier],
    0
  );
  return Math.max(0, Math.min(10, Math.round(weighted)));
}

function decide(body: SystemOneResponse): RiskResult {
  const tierAnswer = body.answers.tier;
  const kindAnswer = body.answers.kind;

  const scores = tierAnswer.probabilities ?? {};
  const tier = (tierAnswer.choice ?? "none") as RiskTier;
  const score = scores[tier] ?? 0;

  const kind = kindAnswer.choice ?? "none";
  const kindScore = kindAnswer.probabilities?.[kind] ?? 0;

  const strong = tier === "strong";
  const medium = tier === "medium" && score >= MEDIUM_THRESHOLD;
  // Rescue only when both questions agree that there is meaningful risk. A
  // confident kind alone is not enough: benign messages often mention a
  // relationship, demographic, or possession without exposing the author.
  const rescued =
    !strong &&
    !medium &&
    kind !== "none" &&
    kindScore >= KIND_RESCUE &&
    (scores.medium ?? 0) >= KIND_RESCUE_MEDIUM_SUPPORT;
  const flagged = strong || medium || rescued;
  const effectiveTier: RiskTier = strong ? "strong" : flagged ? "medium" : tier;

  return {
    flagged,
    tier: effectiveTier,
    score,
    kind,
    kindScore,
    scores,
  };
}
