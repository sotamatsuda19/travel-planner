import Anthropic from "@anthropic-ai/sdk";
import { getPlace, haversine, nearestStation, resolveArea, searchPlaces, toPlace } from "./poi";
import { buildRoute } from "./route";
import type { Itinerary, LatLng, Place, RouteResult, TravelMode } from "./types";

export const MODEL = "claude-opus-5";

// ------------------------------------------------------------------ ツール定義

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_places",
    description:
      "東京のスポット（飲食店・観光地・公園・神社仏閣・美術館・駅・公衆トイレなど）をオープンデータから検索する。" +
      "結果は自動的に地図にピンとして表示されるので、返ってきた場所を文章で列挙し直す必要はない。" +
      "カテゴリ違いの候補が欲しいときは複数回まとめて呼んでよい（例: カフェ / レストラン / 夜景）。",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "検索語。料理ジャンルや施設種別を日本語で。例: ラーメン、カフェ、夜景、美術館、公衆トイレ",
        },
        near_area: {
          type: ["string", "null"],
          description: "検索の中心にする地名・駅名（例: 渋谷、浅草、上野駅）。null ならユーザーの現在地を使う。",
        },
        radius_m: {
          type: ["integer", "null"],
          description: "検索半径（メートル）。null なら 2500m。エリア全体を見たいときは 3000〜5000。",
        },
        limit: { type: ["integer", "null"], description: "最大件数。null なら 8。" },
        open_now: {
          type: ["boolean", "null"],
          description: "true なら現在営業中と判定できる店に絞る（営業時間データが無い店は除外しない）。",
        },
      },
      required: ["query", "near_area", "radius_m", "limit", "open_now"],
      additionalProperties: false,
    },
  },
  {
    name: "get_route",
    description:
      "2地点以上を結ぶ経路を出す。結果（ルート線・所要時間・距離・タクシー料金・累積標高）は自動的に地図に描画される。" +
      "現在地は \"current\" という特別な ID で指定できる。" +
      "移動手段を比較したいときは mode を変えて複数回呼ぶ。",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        stop_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "経由順に並べた place_id の配列。search_places が返した place_id、または現在地を表す \"current\"。2つ以上必要。",
        },
        mode: {
          type: "string",
          enum: ["walk", "transit", "taxi", "car"],
          description: "移動手段。walk=徒歩, transit=電車中心, taxi=タクシー, car=車",
        },
      },
      required: ["stop_ids", "mode"],
      additionalProperties: false,
    },
  },
  {
    name: "save_itinerary",
    description:
      "旅程（旅のしおり）を保存する。差分ではなく毎回**旅程全体を丸ごと**渡すこと。" +
      "並べ替え・削除・時刻変更もすべてこのツールを全置換で呼び直して表現する。" +
      "保存した場所は地図上で番号つきの濃いピンとして強調表示される。",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "旅程のタイトル（例: 渋谷 夜デートプラン）" },
        days: {
          type: "array",
          description: "日ごとの予定。1日だけなら要素1つ。",
          items: {
            type: "object",
            properties: {
              date: { type: ["string", "null"], description: "YYYY-MM-DD。決まっていなければ null。" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    place_id: { type: "string", description: "search_places が返した place_id" },
                    start_time: { type: ["string", "null"], description: "HH:MM。未定なら null。" },
                    duration_min: { type: ["integer", "null"], description: "滞在時間（分）" },
                    note: { type: ["string", "null"], description: "ひとことメモ（何をする場所か）" },
                    travel_mode_from_previous: {
                      type: ["string", "null"],
                      description: "前の場所からの移動手段。walk / transit / taxi / car のいずれか、または null。",
                    },
                  },
                  required: ["place_id", "start_time", "duration_min", "note", "travel_mode_from_previous"],
                  additionalProperties: false,
                },
              },
            },
            required: ["date", "items"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "days"],
      additionalProperties: false,
    },
  },
];

// -------------------------------------------------------------- システムプロンプト

/** 安定した前置き（プロンプトキャッシュの対象。ここに変動する値を入れないこと） */
export const SYSTEM_PROMPT = `あなたは東京の旅行・おでかけプランを一緒に考えるアシスタントです。
画面は上下2ペインで、**上が地図・下がこの会話**です。ユーザーは会話しながら地図を見ています。

## 基本動作
- 場所を探すときは必ず search_places を呼ぶ。記憶から店名や座標を書かない。存在しない店を作らない。
- 検索結果・経路は**自動的に地図に反映される**。だから文章で全件を列挙し直さない。
  「地図に5軒出しました」と伝えたうえで、おすすめ2〜3件の“選ぶ理由”だけを書く。
- 返答は短く。3〜5文が基本。箇条書きは3項目まで。
- ユーザーが決めきれていない段階でしおりを保存しない。「これにする」と決まってから save_itinerary。

## ツールの使い分け
- search_places … 場所を探す。カテゴリが複数あるなら並列に複数回呼ぶ。
- get_route … 経路・所要時間・タクシー料金・坂道のきつさ（累積標高）を出す。移動手段の比較は mode を変えて複数回。
- save_itinerary … 旅程の保存。**常に全体を丸ごと**渡す（差分更新はしない）。

## やらないこと
- 地図のズームやカメラ操作を指示しない。検索結果・ルートの範囲に自動で合う。
- 現在地・時刻・天気を聞き返さない。毎ターン渡される。
- 緯度経度を自分で書かない。場所の参照は place_id のみ。

## 会話の作法
- 曖昧なときは、選択肢を2〜3個示して聞き返す。長い質問リストにしない。
- 予算・好み・帰る方面などは事前に分からない。必要になった時点で、会話の流れの中で1つずつ聞く。
- 提案には必ず理由を添える（近い／評判／今開いている／坂が少ない／説明文がある など）。
- データはオープンデータ（OpenStreetMap・Wikidata・Wikivoyage・国土地理院・気象庁）由来。
  営業時間や料金は概算であることを、断定を避けた言い方で示す。
- 終電・タクシー・帰り道の相談では、まず「今どうすれば帰れるか」を最初の1文で答える。`;

// -------------------------------------------------------------- 毎ターンの文脈

let weatherCache: { at: number; text: string | null } = { at: 0, text: null };

/** 気象庁の東京都予報（政府オープンデータ）。失敗しても黙って null。 */
export async function tokyoWeather(): Promise<string | null> {
  if (Date.now() - weatherCache.at < 10 * 60 * 1000) return weatherCache.text;
  try {
    const res = await fetch("https://www.jma.go.jp/bosai/forecast/data/forecast/130000.json", {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error("bad status");
    const json = (await res.json()) as {
      timeSeries: { areas: { area: { name: string }; weathers?: string[] }[] }[];
    }[];
    const area = json[0]?.timeSeries?.[0]?.areas?.find((a) => a.area.name.includes("東京")) ??
      json[0]?.timeSeries?.[0]?.areas?.[0];
    const text = area?.weathers?.[0]?.replace(/　/g, " ").trim() ?? null;
    weatherCache = { at: Date.now(), text };
    return text;
  } catch {
    weatherCache = { at: Date.now(), text: null };
    return null;
  }
}

export type TurnContext = {
  location: LatLng;
  now: Date;
  weather: string | null;
  areaName: string | null;
};

export function renderContext(ctx: TurnContext): string {
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "full",
    timeStyle: "short",
  });
  return [
    "<context>",
    `現在時刻: ${fmt.format(ctx.now)}`,
    `現在地: ${ctx.areaName ?? "東京都内"}（lat ${ctx.location.lat.toFixed(4)}, lng ${ctx.location.lng.toFixed(4)}）`,
    ctx.weather ? `今日の天気（気象庁）: ${ctx.weather}` : null,
    "</context>",
  ]
    .filter(Boolean)
    .join("\n");
}

// ------------------------------------------------------------------ ツール実行

export type ToolOutcome = {
  /** LLM に返す内容（テキスト） */
  content: string;
  /** 地図に流す副作用 */
  places?: { query: string; places: Place[] };
  route?: RouteResult;
  itinerary?: Itinerary;
};

/** place_id → 座標。"current" だけは文脈から解決する。 */
function resolveStop(id: string, ctx: TurnContext): { name: string; lat: number; lng: number } | null {
  if (id === "current") {
    return { name: "現在地", lat: ctx.location.lat, lng: ctx.location.lng };
  }
  const rec = getPlace(id);
  if (!rec) return null;
  return { name: rec.name, lat: rec.lat, lng: rec.lon };
}

export async function runTool(
  name: string,
  input: Record<string, unknown>,
  ctx: TurnContext,
): Promise<ToolOutcome> {
  if (name === "search_places") {
    const query = String(input.query ?? "");
    const nearArea = (input.near_area as string | null) ?? null;
    const area = nearArea ? resolveArea(nearArea) : null;
    const center: LatLng = area ? { lat: area.lat, lng: area.lon } : ctx.location;

    const { places } = searchPlaces({
      query,
      near: center,
      radiusM: (input.radius_m as number | null) ?? undefined,
      limit: (input.limit as number | null) ?? undefined,
      openNow: (input.open_now as boolean | null) ?? false,
      now: ctx.now,
    });

    if (places.length === 0) {
      return {
        content: `「${query}」${nearArea ? `（${nearArea}周辺）` : "（現在地周辺）"}では該当する場所が見つかりませんでした。別の言い方か、範囲を広げて再検索してください。`,
        places: { query, places: [] },
      };
    }

    const lines = places.map((p, i) => {
      const bits = [
        `${i + 1}. ${p.name}【${p.place_id}】`,
        `カテゴリ: ${p.category}`,
        p.address ? `住所: ${p.address}` : null,
        p.distance_m !== null ? `検索中心から ${Math.round(p.distance_m)}m` : null,
        p.opening_hours ? `営業時間: ${p.opening_hours}` : null,
        p.is_open_now === true ? "現在営業中" : p.is_open_now === false ? "現在は営業時間外" : null,
        p.description ? `説明: ${p.description}` : null,
        p.website ? `web: ${p.website}` : null,
        `出典: ${p.source}`,
      ].filter(Boolean);
      return bits.join(" / ");
    });

    return {
      content:
        `検索: "${query}" ${nearArea ? `near=${area?.matched ?? nearArea}` : "near=現在地"}\n` +
        `${places.length}件ヒット（地図に表示済み）\n` +
        lines.join("\n"),
      places: { query, places },
    };
  }

  if (name === "get_route") {
    const ids = (input.stop_ids as string[]) ?? [];
    const mode = (input.mode as TravelMode) ?? "walk";
    const stops = ids.map((id) => resolveStop(id, ctx)).filter((s): s is NonNullable<typeof s> => !!s);
    if (stops.length < 2) {
      return {
        content:
          "経路を出すには有効な place_id が2つ以上必要です。search_places で場所を取得してから、その place_id を使ってください（現在地は \"current\"）。",
      };
    }

    const route = await buildRoute(stops, mode);
    const modeLabel = { walk: "徒歩", transit: "電車中心", taxi: "タクシー", car: "車" }[mode];
    const legText = route.legs
      .map(
        (l) =>
          `- ${l.from} → ${l.to}（${l.mode}）: ${Math.round(l.distance_m)}m / 約${Math.round(l.duration_s / 60)}分${l.note ? ` ※${l.note}` : ""}`,
      )
      .join("\n");

    return {
      content: [
        `経路（${modeLabel}）を地図に描画しました。`,
        `合計: ${(route.distance_m / 1000).toFixed(1)}km / 約${Math.round(route.duration_s / 60)}分`,
        route.estimated_fare_jpy !== null ? `推定料金: 約${route.estimated_fare_jpy.toLocaleString()}円` : null,
        route.elevation_gain_m !== null
          ? `累積標高（国土地理院データ）: +${route.elevation_gain_m}m ${route.elevation_gain_m > 40 ? "（坂が多め）" : "（ほぼ平坦）"}`
          : null,
        `算出方法: ${route.engine}`,
        legText,
      ]
        .filter(Boolean)
        .join("\n"),
      route,
    };
  }

  if (name === "save_itinerary") {
    const title = String(input.title ?? "旅のしおり");
    const rawDays = (input.days as
      | {
          date: string | null;
          items: {
            place_id: string;
            start_time: string | null;
            duration_min: number | null;
            note: string | null;
            travel_mode_from_previous: TravelMode | null;
          }[];
        }[]
      | undefined) ?? [];

    const missing: string[] = [];
    const days = rawDays.map((d) => ({
      date: d.date ?? null,
      items: (d.items ?? []).flatMap((it) => {
        const rec = getPlace(it.place_id);
        if (!rec) {
          missing.push(it.place_id);
          return [];
        }
        return [
          {
            place_id: it.place_id,
            name: rec.name,
            lat: rec.lat,
            lng: rec.lon,
            start_time: it.start_time ?? null,
            duration_min: it.duration_min ?? null,
            note: it.note ?? null,
            travel_from_previous: it.travel_mode_from_previous
              ? { mode: it.travel_mode_from_previous, duration_s: 0 }
              : null,
          },
        ];
      }),
    }));

    const itinerary: Itinerary = { title, days };
    const total = days.reduce((n, d) => n + d.items.length, 0);
    if (total === 0) {
      return {
        content: `旅程を保存できませんでした。place_id が解決できません: ${missing.join(", ") || "(空)"}。search_places の結果に含まれる place_id を使ってください。`,
      };
    }

    return {
      content:
        `旅程「${title}」を保存しました（${days.length}日 / 全${total}件）。地図では番号つきの濃いピンで強調表示されています。` +
        (missing.length ? `\n※ 次の place_id は見つからず除外しました: ${missing.join(", ")}` : ""),
      itinerary,
    };
  }

  return { content: `未知のツール: ${name}` };
}

/** 現在地の“地名らしい表示” */
export function describeLocation(loc: LatLng): string | null {
  const st = nearestStation(loc);
  if (!st) return null;
  const d = Math.round(haversine(loc, { lat: st.lat, lng: st.lon }));
  return `${st.display}から約${d}m`;
}

export { toPlace };
