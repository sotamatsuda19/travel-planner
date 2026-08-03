import { createClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * 会話履歴の永続化（Supabase / Postgres）。
 *
 * 保存するのは Anthropic SDK の MessageParam[] をそのまま JSONB にしたもの。
 * tool_use / tool_result ブロックを含めて丸ごと往復させたいので、独自形式に変換しない。
 *
 * 環境変数が無ければプロセスメモリにフォールバックする。
 * 外部サービスが落ちてもアプリは落ちない、という route.ts / agent.ts と同じ方針。
 */

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** service_role キーは RLS をバイパスする全権キー。サーバ専用コードからしか触らないこと。 */
const db =
  url && key
    ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;

/** Supabase 未設定時のフォールバック（ローカル開発・オフラインデモ）。プロセスが死ぬと消える。 */
const memory = new Map<string, Anthropic.MessageParam[]>();

export const isPersistent = db !== null;

export async function loadConversation(id: string): Promise<Anthropic.MessageParam[]> {
  if (!db) return memory.get(id) ?? [];
  const { data, error } = await db
    .from("conversations")
    .select("messages")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("[db] load failed:", error.message);
    return []; // 履歴を失うだけ。会話は続行させる。
  }
  return (data?.messages as Anthropic.MessageParam[] | undefined) ?? [];
}

export async function saveConversation(id: string, messages: Anthropic.MessageParam[]): Promise<void> {
  if (!db) {
    memory.set(id, messages);
    return;
  }
  const { error } = await db
    .from("conversations")
    .upsert({ id, messages, updated_at: new Date().toISOString() });
  if (error) console.error("[db] save failed:", error.message);
}

export async function deleteConversation(id: string): Promise<void> {
  if (!db) {
    memory.delete(id);
    return;
  }
  const { error } = await db.from("conversations").delete().eq("id", id);
  if (error) console.error("[db] delete failed:", error.message);
}
