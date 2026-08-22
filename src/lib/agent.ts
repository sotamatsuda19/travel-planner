import Anthropic from "@anthropic-ai/sdk";
import {
  ACCESS_REQUIREMENTS,
  getPlace,
  haversine,
  nearestStation,
  resolveArea,
  searchPlaces,
  toPlace,
} from "./poi";
import { buildRoute } from "./route";
import { buildPlan } from "./plan";
import { harvestRoute } from "./legcache";
import type { AccessRequirement } from "./poi";
import type { Accessibility, Itinerary, LatLng, Place, RouteResult, TravelMode } from "./types";

export const MODEL = "claude-opus-5";

// ------------------------------------------------------------------ ツール定義

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_places",
    description:
      "東京のスポット（飲食店・観光地・公園・神社仏閣・美術館・駅・ホテル・簡易宿所・公衆トイレなど）を" +
      "オープンデータから検索する。" +
      "結果は自動的に地図にピンとして表示されるので、返ってきた場所を文章で列挙し直す必要はない。" +
      "カテゴリ違いの候補が欲しいときは複数回まとめて呼んでよい（例: カフェ / レストラン / 夜景）。" +
      "車椅子・ベビーカー・食事制限などの条件があるときは require で絞る。",
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
        require: {
          type: ["array", "null"],
          items: { type: "string", enum: [...ACCESS_REQUIREMENTS] },
          description:
            "バリアフリー・受入対応の必須条件。指定を全部満たす場所だけが返る（AND）。" +
            "wheelchair=車椅子で入れる / step_free=入口に段差なし / elevator=エレベーター / " +
            "accessible_toilet=車椅子対応トイレ / ostomate=オストメイト対応 / changing_table=おむつ替え台 / " +
            "nursing_room=授乳室 / tactile_paving=点字ブロック / braille=点字案内 / " +
            "sign_language=手話対応スタッフ / writing_support=筆談対応 / " +
            "wheelchair_rental=車椅子貸出 / stroller_rental=ベビーカー貸出 / assistance_dog=補助犬受入 / " +
            "accessible_parking=車椅子用駐車場 / multilingual_menu=外国語メニュー / " +
            "allergy=アレルギー対応 / vegetarian=ベジタリアン対応 / halal=ハラール対応。" +
            "**調査済みの場所しか通らない**ので、条件を足すほど件数は大きく減る。" +
            "0件のときは条件を1つ外して呼び直すこと。不要なら null。",
        },
      },
      required: ["query", "near_area", "radius_m", "limit", "open_now", "require"],
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
      "プランを確定する。差分ではなく毎回**旅程全体を丸ごと**渡すこと。" +
      "並べ替え・削除・時刻変更もすべてこのツールを全置換で呼び直して表現する。" +
      "呼ぶと地図に番号つきピンと地点間をつないだ連続した経路が描かれ、" +
      "**返り値として、実際に経路を計算した所要時間と到着予定時刻の入った行程表が返る**。" +
      "所要時間と到着時刻を自分で見積もらないこと。返ってきた行程表を文章に起こしてユーザーに伝える。",
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
  **例外はプランを出すときだけ**（下の「プランの伝え方」）。
- プランが固まってきたら、回答の最後に「このプランを表示しますか？」と**一度だけ**聞く。
  了承されたら save_itinerary を呼ぶ。決めきれていない段階では呼ばない。
- 一度表示したあとの変更（順番の入れ替え・追加・削除・時刻変更）では**聞き直さない**。
  そのまま save_itinerary を全置換で呼び直して地図を更新する。

## ツールの使い分け
- search_places … 場所を探す。カテゴリが複数あるなら並列に複数回呼ぶ。
  車椅子・ベビーカー・食事制限などの条件が出たら require で絞る。
- get_route … 経路・所要時間・タクシー料金・坂道のきつさ（累積標高）を出す。移動手段の比較は mode を変えて複数回。
- save_itinerary … プランを確定する。**常に全体を丸ごと**渡す（差分更新はしない）。
  返り値の行程表を文章に起こして伝える（下の「プランの伝え方」）。

## やらないこと
- 地図のズームやカメラ操作を指示しない。検索結果・ルートの範囲に自動で合う。
- 現在地・時刻・天気を聞き返さない。毎ターン渡される。
- 緯度経度を自分で書かない。場所の参照は place_id のみ。

## 会話の作法
- 曖昧なときは、選択肢を2〜3個示して聞き返す。長い質問リストにしない。
- 予算・好み・帰る方面などは事前に分からない。必要になった時点で、会話の流れの中で1つずつ聞く。
- 提案には必ず理由を添える（近い／評判／今開いている／坂が少ない／説明文がある など）。
- データはオープンデータ（OpenStreetMap・Wikidata・Wikivoyage・国土地理院・気象庁・
  東京都および区市町村のオープンデータ）由来。
  営業時間や料金は概算であることを、断定を避けた言い方で示す。
- 終電・タクシー・帰り道の相談では、まず「今どうすれば帰れるか」を最初の1文で答える。

## プランの伝え方
save_itinerary の返り値には、実際に経路を計算した**到着予定時刻・移動手段・所要時間**が入っている。
地図に出るのは線とピンだけで、**時刻や所要時間の文字は地図に出ない**。
だからここは省略せず、返ってきた行程を順番どおりに書き出す。

- 番号（[1][2][3]…）は地図のピンと一致している。**必ず同じ番号を使う**。
- 1地点1行。「時刻 → 場所 → 滞在時間 → ひとこと」の順で、間に移動手段と所要時間を挟む。
- 時刻・分数・距離は返り値の数字をそのまま使う。**丸めたり自分で計算し直したりしない。**
- 最後に、移動の合計と累積標高を1行で添える。坂がきついなら注意として言う。
- 行程を書いたあとに、**表からは読み取れないこと**を1〜2文だけ足す。
  「3番目は17時閉館なので押したら順番を入れ替えます」のような、次の判断に効くことだけ。
  データに無いことを補って書かない。

例（この粒度で書く）:
> 1. 13:00 浅草文化観光センター（30分）— 展望テラスから浅草寺を見下ろせます
>    ↓ 徒歩7分
> 2. 13:37 隅田公園（40分）— 川沿いで休憩
>    ↓ 電車18分
> 3. 14:35 上野恩賜公園（60分）
>
> 移動は合計3.2km・25分、累積標高+38mでほぼ平坦です。

## バリアフリー・子連れ・食事制限の相談
このアプリの強みはここにある。東京都「だれでも東京」と都の飲食店バリアフリー調査、
区の旅館業許可台帳、OpenStreetMap のタグを突き合わせて持っている。地図アプリには無い情報。

- 「車椅子で」「ベビーカーで」「母を連れて」「祖父と」のような話が出たら、
  **聞き返す前にまず require つきで検索する**。何が実際にあるか見てから確認する方が早い。
- 検索結果に含まれるバリアフリー情報は**そのまま数字で伝える**。
  「段差なし」「入口幅90cm」「多目的トイレ2か所」は、言い換えるより具体的な方が役に立つ。
- **調査済みの場所しか require を通らない**。0件は「無い」ではなく「確認できていない」。
  そのときは条件を減らして呼び直し、「データで確認できた範囲では」と断って出す。
- 徒歩ルートの累積標高（get_route）は、車椅子・ベビーカー・高齢者の相談では
  疲労度ではなく**通れるかどうか**の話になる。この文脈では必ず添える。
- 情報には調査時点がある。「都の調査では〜となっています。心配なら電話で確認を」まで言う。
  設備の有無を断定して、行った先で入れなかった、が一番まずい。

## 宿泊
区の旅館業許可台帳（旅館・ホテル営業／簡易宿所営業）と OSM を持っている。
- 台帳は許可情報であって、営業中とも予約可能とも限らない。空室・料金は分からない。
- 台帳の一部は住所から座標を推定している（結果に「位置は住所からの推定」と出る）。
  その場合は地図のピンが建物とずれることを一言添える。`;

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
  /** 区間キャッシュ（legcache）の引き当て単位。会話が変われば別のキャッシュになる。 */
  sessionId: string;
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

/**
 * バリアフリー情報を1行にたたむ。
 * 「調べた上で無かった」項目まで並べると読めなくなるので、true と数値だけを出し、
 * 明確な否定（wheelchair=no）だけ例外的に書く。
 */
const ACCESS_LABELS: [keyof Accessibility, string][] = [
  ["step_free", "入口に段差なし"],
  ["slope", "スロープあり"],
  ["auto_door", "自動ドア"],
  ["elevator", "エレベーターあり"],
  ["accessible_toilet", "車椅子対応トイレあり"],
  ["ostomate", "オストメイト対応"],
  ["changing_table", "おむつ替え台あり"],
  ["nursing_room", "授乳室あり"],
  ["tactile_paving", "点字ブロックあり"],
  ["braille_map", "点字案内あり"],
  ["braille_menu", "点字メニューあり"],
  ["sign_language", "手話対応スタッフ"],
  ["writing_support", "筆談対応"],
  ["flash_bell", "フラッシュベル貸出"],
  ["wheelchair_rental", "車椅子貸出"],
  ["stroller_rental", "ベビーカー貸出"],
  ["assistance_dog", "補助犬受入設備"],
  ["accessible_parking", "車椅子用駐車場"],
  ["movable_chairs", "椅子が可動"],
  ["table_clearance", "テーブル下にスペース"],
  ["photo_menu", "写真メニュー"],
  ["multilingual_menu", "外国語メニュー"],
  ["allergy", "アレルギー対応（要事前申請）"],
  ["vegetarian", "ベジタリアン/ヴィーガン対応（要事前申請）"],
  ["halal", "ハラール対応（要事前申請）"],
  ["free_toilet", "無料"],
];

function describeAccess(a: Accessibility | null): string | null {
  if (!a) return null;
  const bits: string[] = [];
  if (a.wheelchair === "yes") bits.push("車椅子で利用可");
  else if (a.wheelchair === "limited") bits.push("車椅子は一部のみ可");
  else if (a.wheelchair === "no") bits.push("車椅子では利用不可");

  for (const [key, label] of ACCESS_LABELS) {
    if (a[key] === true) bits.push(label);
  }
  if (a.step_height_cm) bits.push(`段差${a.step_height_cm}cm`);
  if (a.entrance_width_cm) bits.push(`入口幅${a.entrance_width_cm}cm`);
  if (a.accessible_toilet_count) bits.push(`対応トイレ${a.accessible_toilet_count}か所`);
  if (!bits.length) return null;
  return `${bits.join("・")}${a.src ? `（${a.src}）` : ""}`;
}

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
      require: (input.require as AccessRequirement[] | null) ?? undefined,
      now: ctx.now,
    });

    if (places.length === 0) {
      return {
        content:
          `「${query}」${nearArea ? `（${nearArea}周辺）` : "（現在地周辺）"}では該当する場所が見つかりませんでした。` +
          (Array.isArray(input.require) && input.require.length
            ? `条件（${(input.require as string[]).join(", ")}）を満たすと確認できたスポットが範囲内に無い、` +
              "というだけで、実際には条件を満たす場所がある可能性が高い。" +
              "条件を1つ減らすか範囲を広げて呼び直し、ユーザーには「データで確認できた範囲では」と断ること。"
            : "別の言い方か、範囲を広げて再検索してください。"),
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
        describeAccess(p.accessibility) ? `バリアフリー: ${describeAccess(p.accessibility)}` : null,
        p.approx_location ? "※位置は住所からの推定（街区の代表点）で建物ピンポイントではない" : null,
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
    // ここで計算した区間は、あとでプランに現れたときに使い回す（legcache.ts）
    harvestRoute(ctx.sessionId, ids, route, ctx.location);
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
            stop: { place_id: it.place_id, name: rec.name, lat: rec.lat, lng: rec.lon },
            start_time: it.start_time ?? null,
            duration_min: it.duration_min ?? null,
            note: it.note ?? null,
            mode_from_previous: it.travel_mode_from_previous ?? null,
          },
        ];
      }),
    }));

    const total = days.reduce((n, d) => n + d.items.length, 0);
    if (total === 0) {
      return {
        content: `旅程を保存できませんでした。place_id が解決できません: ${missing.join(", ") || "(空)"}。search_places の結果に含まれる place_id を使ってください。`,
      };
    }

    // 区間の経路・所要時間・到着予定時刻をここで埋める。
    // 全置換で毎回全区間が来るが、実際に計算するのはキャッシュに無いものだけ。
    const itinerary: Itinerary = await buildPlan({
      sessionId: ctx.sessionId,
      title,
      days,
      at: ctx.location,
      now: ctx.now,
    });

    // モデルがこのまま段階的な文章に起こせる形で返す。
    // 番号は地図のピンと一致する（日をまたいでも通し番号）。
    const MODE_JA: Record<TravelMode, string> = {
      walk: "徒歩",
      transit: "電車",
      taxi: "タクシー",
      car: "車",
    };
    const lines: string[] = [];
    let n = 0;
    itinerary.days.forEach((d, di) => {
      if (itinerary.days.length > 1) {
        lines.push(`--- ${di + 1}日目${d.date ? `（${d.date}）` : ""} ---`);
      }
      for (const it of d.items) {
        n += 1;
        const move = it.travel_from_previous;
        if (move) {
          lines.push(
            `   ↓ ${MODE_JA[move.mode]} ${Math.round(move.duration_s / 60)}分・` +
              `${move.distance_m < 1000 ? `${move.distance_m}m` : `${(move.distance_m / 1000).toFixed(1)}km`}` +
              (move.elevation_gain_m ? `・登り+${move.elevation_gain_m}m` : ""),
          );
        }
        lines.push(
          `[${n}] ${it.arrive_time ? `${it.arrive_time}着 ` : ""}${it.name}` +
            (it.duration_min ? ` / 滞在${it.duration_min}分` : "") +
            (it.depart_time ? ` / ${it.depart_time}発` : "") +
            (it.note ? ` / ${it.note}` : ""),
        );
      }
    });

    return {
      content: [
        `プラン「${title}」を確定しました（${itinerary.days.length}日 / 全${total}件）。`,
        "地図には経路と番号つきピンが出ているが、**時刻や所要時間の文字は地図に出ない**。" +
          "下の内容を、この順番のまま**段階的な文章としてユーザーに書き出すこと**。" +
          "番号は地図のピンの番号と一致しているので、そのまま使うこと。",
        `移動の合計: ${(itinerary.total_distance_m / 1000).toFixed(1)}km / 約${Math.round(itinerary.total_duration_s / 60)}分` +
          (itinerary.total_elevation_gain_m !== null
            ? ` / 累積標高 +${itinerary.total_elevation_gain_m}m${itinerary.total_elevation_gain_m > 60 ? "（坂が多め）" : "（ほぼ平坦）"}`
            : ""),
        lines.join("\n"),
        missing.length ? `※ 次の place_id は見つからず除外しました: ${missing.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
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
