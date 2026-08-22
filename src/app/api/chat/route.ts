import Anthropic from "@anthropic-ai/sdk";
import {
  MODEL,
  SYSTEM_PROMPT,
  TOOLS,
  describeLocation,
  renderContext,
  runTool,
  tokyoWeather,
  type TurnContext,
} from "@/lib/agent";
import { deleteConversation, loadConversation, saveConversation } from "@/lib/db";
import { loadIndex } from "@/lib/poi";
import type { StreamEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * 会話状態は Supabase に置く（未設定ならプロセスメモリ / src/lib/db.ts）。
 * tool_use / tool_result ブロックをそのまま保持したいので、クライアントには履歴を持たせない。
 */
const MAX_TURNS_KEPT = 40;

const anthropic = new Anthropic();

/** 東京駅（現在地が取れなかった場合のフォールバック） */
const FALLBACK_LOCATION = { lat: 35.6812, lng: 139.7671 };

type ChatRequest = {
  session_id: string;
  message: string;
  location?: { lat: number; lng: number } | null;
};

export async function POST(req: Request) {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return sseError(
      "ANTHROPIC_API_KEY が設定されていません。travel-planner/.env.local に設定して開発サーバを再起動してください。",
    );
  }

  try {
    loadIndex(); // 初回のみ 66,000 件をメモリに載せる
  } catch (e) {
    return sseError(e instanceof Error ? e.message : String(e));
  }

  const sessionId = body.session_id || "default";
  const history = await loadConversation(sessionId);
  const location = body.location ?? FALLBACK_LOCATION;

  const ctx: TurnContext = {
    sessionId,
    location,
    now: new Date(),
    weather: await tokyoWeather(),
    areaName: describeLocation(location),
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (ev: StreamEvent) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));

      try {
        send({ type: "context", weather: ctx.weather, area: ctx.areaName });

        // 変動する文脈は「最後の user ターンの先頭」に置く。
        // 安定した前置き（system + tools + これまでの履歴）はキャッシュが効く。
        const messages: Anthropic.MessageParam[] = [
          ...history,
          {
            role: "user",
            content: `${renderContext(ctx)}\n\n${body.message}`,
          },
        ];

        let guard = 0;
        // ツール実行ループ：stop_reason が tool_use の間まわす
        for (;;) {
          if (guard++ > 8) {
            send({ type: "error", message: "ツール呼び出しが多すぎるため中断しました。" });
            break;
          }

          const finalMessage = await streamOnce(messages, send);

          messages.push({ role: "assistant", content: finalMessage.content });

          if (finalMessage.stop_reason === "refusal") {
            send({ type: "error", message: "この内容には回答できませんでした。" });
            break;
          }
          if (finalMessage.stop_reason !== "tool_use") break;

          const toolUses = finalMessage.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
          );

          // 並列ツール呼び出しは同時に実行し、結果は「1つの user メッセージ」にまとめて返す
          const results = await Promise.all(
            toolUses.map(async (tu) => {
              send({ type: "tool_start", name: tu.name, summary: summarize(tu) });
              try {
                const outcome = await runTool(tu.name, tu.input as Record<string, unknown>, ctx);
                if (outcome.places) {
                  send({ type: "places", query: outcome.places.query, places: outcome.places.places });
                }
                if (outcome.route) send({ type: "route", route: outcome.route });
                if (outcome.itinerary) send({ type: "itinerary", itinerary: outcome.itinerary });
                return {
                  type: "tool_result" as const,
                  tool_use_id: tu.id,
                  content: outcome.content,
                };
              } catch (e) {
                return {
                  type: "tool_result" as const,
                  tool_use_id: tu.id,
                  content: `ツール実行エラー: ${e instanceof Error ? e.message : String(e)}`,
                  is_error: true,
                };
              }
            }),
          );

          messages.push({ role: "user", content: results });
        }

        await saveConversation(sessionId, messages.slice(-MAX_TURNS_KEPT));
        send({ type: "done" });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("[chat] error:", e);
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/** 1回のモデル呼び出し（ストリーミング）。テキスト差分をそのまま SSE に流す。 */
async function streamOnce(
  messages: Anthropic.MessageParam[],
  send: (ev: StreamEvent) => void,
): Promise<Anthropic.Message> {
  const params = (strict: boolean): Anthropic.MessageStreamParams => ({
    model: MODEL,
    max_tokens: 8000,
    // 安定した前置き（system + tools）をキャッシュ。会話が伸びても入力コストが落ちる。
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    // 直近の履歴末尾にも自動でブレークポイントを置く（マルチターンのキャッシュ）
    cache_control: { type: "ephemeral" },
    // 思考は on のまま、effort を下げてチャットの応答速度を優先する
    output_config: { effort: "low" },
    tools: strict ? TOOLS : TOOLS.map(({ strict: _s, ...t }) => t),
    messages,
  });

  const run = async (strict: boolean) => {
    const stream = anthropic.messages.stream(params(strict));
    stream.on("text", (delta) => send({ type: "text", delta }));
    return stream.finalMessage();
  };

  try {
    return await run(true);
  } catch (e) {
    // strict tool use がスキーマ都合で弾かれた場合だけ、strict なしで1回だけ再試行する
    if (e instanceof Anthropic.BadRequestError && /strict|schema/i.test(e.message)) {
      console.warn("[chat] strict tool use rejected, retrying without strict:", e.message);
      return run(false);
    }
    throw e;
  }
}

function summarize(tu: Anthropic.ToolUseBlock): string {
  const input = tu.input as Record<string, unknown>;
  if (tu.name === "search_places") {
    const near = input.near_area ? `${input.near_area}周辺` : "現在地周辺";
    return `${near}で「${input.query}」を検索中…`;
  }
  if (tu.name === "get_route") {
    const label: Record<string, string> = {
      walk: "徒歩",
      transit: "電車",
      taxi: "タクシー",
      car: "車",
    };
    return `${label[String(input.mode)] ?? String(input.mode)}ルートを計算中…`;
  }
  if (tu.name === "save_itinerary") {
    // 保存ではなく、区間ごとの経路と所要時間を実際に計算している。
    // キャッシュに無い区間だけ OSRM と国土地理院を叩くので、待ち時間はプランの中身次第。
    const stops = Array.isArray(input.days)
      ? (input.days as { items?: unknown[] }[]).reduce((n, d) => n + (d.items?.length ?? 0), 0)
      : 0;
    return `プラン「${input.title}」の経路と到着時刻を計算中${stops ? `（${stops}か所）` : ""}…`;
  }
  return `${tu.name} を実行中…`;
}

function sseError(message: string) {
  const body = `data: ${JSON.stringify({ type: "error", message })}\n\ndata: ${JSON.stringify({ type: "done" })}\n\n`;
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

/** 会話のリセット */
export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  await deleteConversation(searchParams.get("session_id") ?? "default");
  return Response.json({ ok: true });
}
