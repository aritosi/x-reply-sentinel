// Shared domain types. No runtime dependencies; erasable-only TypeScript.

export type LangTag = "en" | "zh" | "mixed" | "other";

export type Tier = "observe" | "review" | "deep_scan";

export type RunMode = "dry-run" | "review" | "auto";

export interface AuthorRef {
  /** Stable X user id (rest_id). Never keyed on handle — handles are mutable. */
  id: string;
  handle: string;
  displayName?: string;
}

export interface Tweet {
  id: string;
  text: string;
  /** ISO-8601 */
  createdAt: string;
  author: AuthorRef;
  inReplyToId?: string | null;
  conversationId?: string | null;
  url?: string;
  lang?: string;
  /** Reply count reported by the source, when it reports one. */
  conversationCount?: number;
  /** Set when the item came from an import file rather than a live fetch. */
  source?: string;
}

export interface ProviderCapabilities {
  rootTweet: boolean;
  replies: boolean;
  profile: boolean;
  timeline: boolean;
  block: boolean;
}

export interface ReplyPage {
  items: Tweet[];
  nextCursor: string | null;
  /** True when the provider believes there are no further pages. */
  complete: boolean;
  /** Provider-reported rate limit / degradation signal; drives backoff. */
  rateLimited: boolean;
}

export interface FetchOptions {
  maxItems?: number;
  startCursor?: string | null;
  signal?: AbortSignal;
}

export interface CollectionProvider {
  name: string;
  capabilities(): ProviderCapabilities;
  fetchTweet(id: string): Promise<Tweet | null>;
  fetchReplies(id: string, opts?: FetchOptions): AsyncGenerator<ReplyPage>;
  fetchProfile?(handle: string): Promise<ProfileSnapshot | null>;
  fetchRecentTweets?(handle: string, count: number): Promise<Tweet[]>;
  block?(userId: string, handle: string): Promise<ActionResult>;
  unblock?(userId: string, handle: string): Promise<ActionResult>;
}

export interface ProfileSnapshot {
  userId: string;
  handle: string;
  displayName?: string;
  bio: string;
  createdAt?: string;
  followers?: number;
  following?: number;
  statusesCount?: number;
  link?: string;
  location?: string;
  /** Raw evidence captured for the audit trail. */
  capturedAt: string;
}

export interface ActionResult {
  ok: boolean;
  /** "blocked" | "unblocked" | "already" | "simulated" | "skipped" | "failed" */
  status: string;
  detail?: string;
  httpStatus?: number;
}

export type EvidenceSource = "local" | "llm" | "deepscan" | "human" | "import";

export type EvidenceKind =
  // comment-level style signals
  | "lexicon_slop"
  | "template_structure"
  | "praise_opener"
  | "engagement_question"
  | "restatement"
  | "formatting_tells"
  | "low_specificity"
  | "flat_rhythm"
  | "chat_leak"
  | "llm_semantic"
  // account-level verifiable spam signals (these are the only ones that can justify a block)
  | "marketing_link"
  | "duplicate_content"
  | "spam_ring"
  | "scam_link"
  | "repeat_marketing"
  | "profile_signal"
  | "llm_spam_verdict"
  // bookkeeping
  | "human_correction"
  | "human_confirm";

export interface Evidence {
  kind: EvidenceKind;
  /** Added to the risk ledger, 0-100 scale contribution before decay. */
  weight: number;
  /** Dedup key: identical keys never accumulate twice (spec §六 rule 7). */
  key: string;
  detail: string;
  source: EvidenceSource;
  confidence: number;
}

export interface StyleSignals {
  lexiconDensity: number;
  templateStructure: number;
  praiseOpener: number;
  engagementQuestion: number;
  restatement: number;
  formattingTells: number;
  specificity: number;
  rhythm: number;
  marketingLink: number;
  duplicate: number;
}

export interface DetectionOutcome {
  commentId: string;
  userId: string;
  handle: string;
  postId: string;
  text: string;
  createdAt: string;
  lang: LangTag;
  aiStyleScore: number;
  spamRiskScore: number;
  localStyleScore: number;
  llmStyleScore: number | null;
  llmSpamScore: number | null;
  confidence: number;
  tier: Tier;
  signals: StyleSignals;
  evidence: Evidence[];
  llmUsed: boolean;
  llmReason?: string;
  engineVersion: string;
  rulesVersion: string;
}

export interface UserRisk {
  userId: string;
  handle: string;
  /** Accumulated account spam-risk score, 0-100. */
  riskScore: number;
  previousRiskScore: number | null;
  delta: number;
  components: RiskComponent[];
  tier: Tier;
  whitelisted: boolean;
  banState: "none" | "blocked" | "unblocked" | "pending_review";
  firstSeen: string;
  lastSeen: string;
  evidenceKinds: EvidenceKind[];
  independentSpamKinds: EvidenceKind[];
}

export interface RiskComponent {
  kind: EvidenceKind;
  key: string;
  baseWeight: number;
  repeatBonus: number;
  decayFactor: number;
  /**
   * The confidence actually used in the product, i.e. already clamped to
   * [0.2, 1]. `xrs explain` prints the whole formula, and without this the operator
   * cannot reproduce the number from the ledger. Rows written before the field
   * existed simply omit it.
   */
  confidence?: number;
  contribution: number;
  detail: string;
}

export interface ScanAccountRow {
  userId: string;
  handle: string;
  commentId: string;
  commentUrl?: string;
  text: string;
  aiStyleScore: number;
  localStyleScore: number;
  llmStyleScore: number | null;
  spamRiskScore: number;
  accountRisk: number;
  confidence: number;
  tier: Tier;
  evidenceKinds: EvidenceKind[];
  evidenceDetail: string[];
  /** What the run actually did: recorded | queued_review | deep_scanned | deep_skipped | blocked | simulated | already | skipped | failed */
  action: string;
  reasons: string[];
  deepScanFindings: string[];
}

export interface ScanSummary {
  runId: number;
  postId: string;
  postUrl: string;
  rootText: string;
  provider: string;
  rootFound: boolean;
  repliesAccessible: boolean;
  notes: string[];
  repliesFetched: number;
  repliesNew: number;
  repliesSeenAgain: number;
  localOnly: number;
  llmCalls: number;
  llmItems: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  tierCounts: Record<Tier, number>;
  blocked: number;
  blockSimulated: number;
  blockSkipped: number;
  errors: string[];
  budgetHalted: string | null;
  accounts: ScanAccountRow[];
  startedAt: string;
  durationMs: number;
  reportPath?: string;
}

export interface DailyReportData {
  date: string;
  stats: {
    postsScanned: number;
    repliesNew: number;
    localFiltered: number;
    llmCalls: number;
    llmItems: number;
    highRiskAccounts: number;
    reviewQueue: number;
    deepScans: number;
    autoBlocked: number;
    simulatedBlocks: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  };
  ranked: UserRisk[];
  anomalies: string[];
  mode: RunMode;
}

export interface BudgetState {
  day: string;
  llmCalls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  fetchRequests: number;
  actions: number;
}
