import { serverUrl } from "./llamaServer.js";

export type RiskTier = "none" | "weak" | "medium" | "strong";

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

const MEDIUM_THRESHOLD = Number(process.env.RISK_MEDIUM_THRESHOLD ?? 0.6);
const KIND_RESCUE = Number(process.env.RISK_KIND_RESCUE ?? 0.8);
const MAX_PENDING = Number(process.env.RISK_MAX_PENDING ?? 200);

const QUESTIONS = {
  tier: {
    type: "choice",
    instructions:
      "How much does this message narrow down who its author is, or where they are?",
    criteria: {
      none: "Nothing about the author. Ordinary chat, opinions, or technical talk.",
      weak:
        "A generic personal detail shared by very many people, such as being " +
        "tired, busy, or a gamer.",
      medium:
        "A quasi-identifier: a detail that narrows the author to a smaller " +
        "group, such as an age, job, employer, school, city, neighbourhood, " +
        "schedule, or a rare personal circumstance.",
      strong:
        "A direct identifier: a name together with contact details, a street " +
        "address, an ID or account number, a password or token, or an email " +
        "address or phone number.",
    },
  },
  kind: {
    type: "choice",
    instructions: "What kind of identifying detail does this message contain?",
    criteria: {
      none: "no identifying detail",
      contact: "an email address, phone number, or social handle",
      location: "a street, neighbourhood, city, or place someone frequents",
      demographic: "an age, gender, nationality, or language",
      affiliation: "an employer, school, team, or organisation",
      routine: "a schedule, shift pattern, or recurring habit",
      appearance: "a vehicle, clothing, or physical description",
      credential: "a password, token, badge, or account number",
      relationship: "a named family member, partner, or friend",
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

// The server evaluates one request at a time, so queue work rather than
// letting a busy channel spawn hundreds of sockets.
let active = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<boolean> {
  if (active === 0) {
    active++;
    return true;
  }
  if (waiting.length >= MAX_PENDING) return false;
  await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  return true;
}

function release(): void {
  active--;
  waiting.shift()?.();
}

/**
 * Estimates how much a single message narrows down its author. The message is
 * judged in isolation: this is about re-identification risk from one post, not
 * a traditional PII regex.
 */
export async function assessRisk(text: string): Promise<RiskResult> {
  if (!(await acquire())) {
    throw new Error("risk queue is full; skipping message");
  }

  try {
    const res = await fetch(`${serverUrl}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ state: text, questions: QUESTIONS }),
    });

    if (!res.ok) {
      throw new Error(`systemone request failed: ${res.status} ${await res.text()}`);
    }

    const body = (await res.json()) as SystemOneResponse;
    return decide(body);
  } finally {
    release();
  }
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
  // The tier question sometimes undersells a detail that the kind question
  // recognises confidently, e.g. a distinctive vehicle.
  const rescued = !strong && !medium && kind !== "none" && kindScore >= KIND_RESCUE;

  return {
    flagged: strong || medium || rescued,
    tier: strong ? "strong" : medium || rescued ? "medium" : tier,
    score,
    kind,
    kindScore,
    scores,
  };
}
