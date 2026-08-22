import type { LatLng, RouteLeg, TravelMode } from "./types";

/**
 * 会話中に計算した「2地点間の移動」を使い回すためのキャッシュ。
 *
 * ここが効くのは2つの場面:
 *   1. save_itinerary は全置換なので、順番を1つ入れ替えるだけで全区間が再計算される
 *   2. 会話の途中の get_route（「渋谷から表参道まで歩くと?」）で計算済みの区間が、
 *      あとでプランに現れる
 *
 * **キャッシュは正しさに一切関与しない。** place_id → 座標はバックエンドが持っていて
 * 不変なので（roadmap §5「LLM が触っていいのは place_id だけ」）、無効化ロジックが要らない。
 * 空でも冷たいだけで、結果は同じものが出る。だから会話履歴のように Supabase に載せる必要も無い
 * （polyline は重い）。プロセスが死んだら消えてよい。
 */

export type LegBundle = {
  /** transit だと1区間が「徒歩→電車→徒歩」に割れるので配列で持つ */
  legs: RouteLeg[];
  distance_m: number;
  duration_s: number;
  /** 徒歩区間のみ。get_route 由来のエントリでは null になる（下記 harvest のコメント参照） */
  elevation_gain_m: number | null;
  /**
   * 標高を「取りに行ったか」。null は取りに行っていない場合と、
   * 取りに行ったが国土地理院が返さなかった場合の両方がありうる。
   * これを区別しないと、API が落ちているときに毎回10リクエストを投げ直すことになる。
   */
  elevation_attempted: boolean;
  fare_jpy: number | null;
  engine: string;
};

/** セッションあたりの保持数。1プランが10区間程度なので、これで数十回の編集に耐える。 */
const MAX_PER_SESSION = 400;
/** 抱えるセッション数。超えたら古いものから捨てる。 */
const MAX_SESSIONS = 200;

const store = new Map<string, Map<string, LegBundle>>();

/**
 * 区間のキー。
 * 現在地だけは place_id が無く座標も毎ターン動くので、丸めた座標をキーに畳み込む
 * （4桁 ≒ 11m。その場に留まっていればヒットする）。
 */
export function legKey(fromId: string, toId: string, mode: TravelMode, at: LatLng | null): string {
  const side = (id: string) =>
    id === "current" && at ? `current@${at.lat.toFixed(4)},${at.lng.toFixed(4)}` : id;
  return `${side(fromId)}→${side(toId)}#${mode}`;
}

function bucket(sessionId: string): Map<string, LegBundle> {
  let m = store.get(sessionId);
  if (!m) {
    if (store.size >= MAX_SESSIONS) store.delete(store.keys().next().value as string);
    m = new Map();
    store.set(sessionId, m);
  }
  return m;
}

export function getLeg(sessionId: string, key: string): LegBundle | null {
  const m = store.get(sessionId);
  if (!m) return null;
  const hit = m.get(key);
  if (!hit) return null;
  // 触ったものを末尾に回して、捨てる順番を「使っていない順」にする
  m.delete(key);
  m.set(key, hit);
  return hit;
}

export function putLeg(sessionId: string, key: string, value: LegBundle): void {
  const m = bucket(sessionId);
  m.delete(key);
  m.set(key, value);
  while (m.size > MAX_PER_SESSION) m.delete(m.keys().next().value as string);
}

export function dropSession(sessionId: string): void {
  store.delete(sessionId);
}

/**
 * get_route の結果から使えるものを拾ってキャッシュに入れる。
 *
 * **累積標高は入らない。** buildRoute は polyline 全体に対して1回だけ標高を出していて
 * （route.ts の elevationGain）、区間ごとには持っていないため。
 * これが「部分的にヒットする」ケースの正体で、プラン側は OSRM を省いて標高だけ払うことになる。
 *
 * transit は1つの区間が可変個の leg に割れて境界が記録されていないので、
 * 2地点ちょうどの呼び出し（＝leg 全部がその1区間ぶん）のときだけ拾う。
 */
export function harvestRoute(
  sessionId: string,
  stopIds: string[],
  route: {
    mode: TravelMode;
    legs: RouteLeg[];
    distance_m: number;
    duration_s: number;
    elevation_gain_m: number | null;
    estimated_fare_jpy: number | null;
    engine: string;
  },
  at: LatLng | null,
): void {
  if (stopIds.length < 2) return;

  if (route.mode === "transit") {
    if (stopIds.length !== 2) return;
    putLeg(sessionId, legKey(stopIds[0], stopIds[1], "transit", at), {
      legs: route.legs,
      distance_m: route.distance_m,
      duration_s: route.duration_s,
      // 電車区間に累積標高は出さない（坂の話ではないので）
      elevation_gain_m: null,
      elevation_attempted: true,
      fare_jpy: route.estimated_fare_jpy,
      engine: route.engine,
    });
    return;
  }

  // transit 以外は leg が stop ペアと1対1で並ぶ（route.ts の buildRoute）。
  // OSRM は区間ごとの距離・時間をそのまま返すので、ここの値は近似ではない。
  if (route.legs.length !== stopIds.length - 1) return;
  route.legs.forEach((leg, i) => {
    const wholeRoute = stopIds.length === 2; // このとき route 全体 = この1区間
    putLeg(sessionId, legKey(stopIds[i], stopIds[i + 1], route.mode, at), {
      legs: [leg],
      distance_m: leg.distance_m,
      duration_s: leg.duration_s,
      elevation_gain_m: wholeRoute ? route.elevation_gain_m : null,
      elevation_attempted: wholeRoute || route.mode !== "walk",
      fare_jpy: wholeRoute ? route.estimated_fare_jpy : null,
      engine: route.engine,
    });
  });
}
