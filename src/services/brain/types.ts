export interface BrainMemory {
  id: number;
  content: string;
  category: string;
  source: string;
  importance: number;
  activation: number;
  created_at?: string | null;
  tags?: string[];
}

export interface BrainContradiction {
  winner_id: number;
  winner_activation: number;
  loser_id: number;
  loser_activation: number;
  reason: string;
}

export interface BrainQueryResult {
  activated: BrainMemory[];
  contradictions: BrainContradiction[];
}

export interface BrainStats {
  [key: string]: unknown;
}

export interface BrainResponse {
  seq?: number;
  ok: boolean;
  error?: string;
  data?: unknown;
  [key: string]: unknown;
}

export type BrainCommand =
  | { cmd: "init"; db_path: string; data_dir: string }
  | { cmd: "query"; embedding: number[]; top_k?: number; beta?: number; spread_hops?: number }
  | {
      cmd: "absorb";
      id: number;
      content: string;
      category: string;
      source: string;
      importance: number;
      created_at: string;
      embedding: number[];
      tags?: string[];
    }
  | { cmd: "decay_tick"; ticks: number }
  | { cmd: "get_stats" }
  | { cmd: "shutdown" }
  | { cmd: "dream_cycle" }
  | { cmd: "feedback_signal"; memory_ids: number[]; edge_pairs: [number, number][]; useful: boolean }
  | { cmd: "evolution_train" };

export interface OracleResult {
  answer: string;
  sources: number[];
  confidence: number;
  contradictions: BrainContradiction[];
  hallucination_flags: string[];
  fallback: boolean;
}
