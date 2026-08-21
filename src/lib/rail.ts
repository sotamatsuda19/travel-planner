import fs from "node:fs";
import path from "node:path";
import type { LatLng } from "./types";

/**
 * 鉄道経路探索（国土数値情報 N02 由来の駅グラフ）。
 *
 * これまで transit は「最寄り駅どうしを直線で結ぶ」近似だったので、
 * 地図上でも線が直線になっていた。ここでは実際の線路の上を通す。
 *
 * ■ グラフの作り
 *   ノード = 駅グループ（N02_005g。同じ駅の別路線ホームは1ノードに畳む）
 *   エッジ = 同一路線の隣接駅どうし。線路の実ジオメトリを持つ
 *   乗換   = 駅グループ内は無料、近接駅どうしは徒歩リンク
 *   （事前生成は scripts/build-rail-graph.mjs）
 *
 * ■ 精度について
 *   時刻表を持たないので、所要時間は「表定速度 + 停車時間 + 乗換ペナルティ」の
 *   モデル計算。快速・急行・直通運転も区別しない（全列車を各駅停車として扱う）。
 *   運賃も距離帯からの概算。UI では必ず「概算」と併記すること。
 */

const DATA = path.join(process.cwd(), "data", "rail.json");

/** 表定速度 m/s。N02_002 = 事業者種別（1=JR新幹線 2=JR在来線 3=公営 4=民営 5=三セク） */
const CRUISE: Record<string, number> = { "1": 69, "2": 19.5, "3": 16.5, "4": 17.5, "5": 15 };
/** 途中駅の停車 + 加減速ロス（秒/駅） */
const DWELL = 45;
/** 乗り換え1回あたり（ホーム移動 + 待ち、秒） */
const TRANSFER = 240;
/** 最初に乗るまでの待ち（秒） */
const BOARD_WAIT = 150;
/** 駅間の徒歩乗換に足す待ち（秒） */
const WALK_XFER_WAIT = 180;
/** 徒歩の速度 m/s */
const WALK_MPS = 1.2;
/** 出発地・目的地から乗降駅までの徒歩を許す上限（m） */
const ACCESS_MAX_M = 1600;
/** 乗降駅の候補数（多すぎると探索が重く、少なすぎると最適を逃す） */
const ACCESS_K = 8;
/** 新幹線は既定で使わない（近距離で選ばれると実用的でないため） */
const ALLOW_SHINKANSEN = false;

/**
 * 実測キロ → 営業キロ の補正。
 * N02 は線路の実形状なので、運賃計算の根拠である営業キロより 1 割前後短く出る。
 * 補正しないと距離帯の境界で運賃が1段安く出てしまう。
 */
const FARE_DISTANCE_FACTOR = 1.12;

// ------------------------------------------------------------------ 路線カラー

/** 路線名の部分一致で引く。上から順に最初にマッチしたものを使う。 */
const LINE_COLORS: [string, string][] = [
  // 東京メトロ
  ["銀座線", "#ff9500"],
  ["丸ノ内線", "#f62e36"],
  ["日比谷線", "#b5b5ac"],
  ["東西線", "#009bbf"],
  ["千代田線", "#00bb85"],
  ["有楽町線", "#c1a470"],
  ["半蔵門線", "#8f76d6"],
  ["南北線", "#00ac9b"],
  ["臨海副都心線", "#0079c2"], // りんかい線。「副都心線」より先に判定する
  ["副都心線", "#9c5e31"],
  // 都営
  ["浅草線", "#ec6e66"],
  ["三田線", "#0079c2"],
  ["新宿線", "#6cbb5a"],
  ["大江戸線", "#b6007a"],
  // JR東日本
  ["山手線", "#79c06e"],
  ["京浜東北線", "#00b2e5"],
  ["中央線", "#f15a22"],
  ["総武線", "#ffd400"],
  ["埼京線", "#00ac9a"],
  ["京葉線", "#c9252f"],
  ["横須賀線", "#0067c0"],
  ["南武線", "#ffd400"],
  ["武蔵野線", "#f15a22"],
  ["常磐新線", "#00a7db"], // つくばエクスプレス
  ["常磐線", "#00b48d"],
  ["東海道線", "#f68b1e"],
  ["東北線", "#f68b1e"], // 宇都宮線
  ["高崎線", "#f68b1e"],
  ["横浜線", "#7fc35c"],
  ["青梅線", "#f15a22"],
  // 私鉄・三セク
  ["井の頭線", "#e4007f"],
  ["京王線", "#dd0077"],
  ["小田原線", "#0071bc"],
  ["東横線", "#da0442"],
  ["田園都市線", "#20a288"],
  ["目黒線", "#009cd2"],
  ["大井町線", "#f39700"],
  ["池上線", "#ee86a8"],
  ["東京臨海新交通", "#0068b7"], // ゆりかもめ
  ["池袋線", "#ff6600"],
  ["新宿線", "#00a650"],
  ["伊勢崎線", "#0f70b7"],
  ["東上線", "#0f70b7"],
  ["日暮里・舎人", "#e95513"],
];

/** 事業者種別ごとのフォールバック色 */
const KIND_COLORS: Record<string, string> = {
  "1": "#1f6fb2",
  "2": "#2e7d32",
  "3": "#109ed4",
  "4": "#188038",
  "5": "#7a5ea8",
};

function lineColor(name: string, kind: string): string {
  for (const [needle, color] of LINE_COLORS) if (name.includes(needle)) return color;
  return KIND_COLORS[kind] ?? "#188038";
}

// ---------------------------------------------------------------------- 運賃

/** 事業者別の運賃表（営業キロ上限, 円）。実運賃とはズレる概算。 */
const FARE_TABLE: Record<string, [number, number][]> = {
  東日本旅客鉄道: [
    [3, 150],
    [6, 170],
    [10, 200],
    [15, 240],
    [20, 340],
    [25, 420],
    [30, 510],
    [35, 590],
    [40, 680],
    [Infinity, 860],
  ],
  東京地下鉄: [
    [6, 180],
    [11, 210],
    [19, 260],
    [27, 300],
    [40, 330],
    [Infinity, 380],
  ],
  東京都: [
    [4, 180],
    [9, 220],
    [15, 280],
    [20, 320],
    [Infinity, 380],
  ],
  // 大手私鉄はおおむね JR より安い。専用の表を持たない事業者はここに落ちる。
  _default: [
    [3, 150],
    [6, 180],
    [10, 200],
    [15, 230],
    [20, 270],
    [25, 310],
    [30, 350],
    [40, 420],
    [Infinity, 520],
  ],
};

function fareFor(operator: string, km: number): number {
  const table = FARE_TABLE[operator] ?? FARE_TABLE._default;
  for (const [limit, yen] of table) if (km <= limit) return yen;
  return table[table.length - 1][1];
}

// ------------------------------------------------------------------ グラフ読込

type RawGraph = {
  source: string;
  stations: [string, number, number][];
  lines: [string, string, string][];
  edges: [number, number, number, number, [number, number][]][];
  walk: [number, number, number][];
};

type Line = { operator: string; name: string; kind: string; color: string; cruise: number };
type Edge = { to: number; line: number; distance_m: number; duration_s: number; poly: [number, number][] };
type Graph = {
  source: string;
  names: string[];
  lng: Float64Array;
  lat: Float64Array;
  lines: Line[];
  adj: Edge[][];
  /** 徒歩乗換: [相手ノード, 距離m, 所要秒] */
  walk: [number, number, number][][];
};

let cached: Graph | null = null;

export function railAvailable(): boolean {
  return fs.existsSync(DATA);
}

function loadGraph(): Graph {
  if (cached) return cached;

  const raw = JSON.parse(fs.readFileSync(DATA, "utf8")) as RawGraph;
  const n = raw.stations.length;
  const names: string[] = new Array(n);
  const lng = new Float64Array(n);
  const lat = new Float64Array(n);
  raw.stations.forEach(([name, x, y], i) => {
    names[i] = name;
    lng[i] = x;
    lat[i] = y;
  });

  const lines: Line[] = raw.lines.map(([operator, name, kind]) => ({
    operator,
    name,
    kind,
    color: lineColor(name, kind),
    cruise: CRUISE[kind] ?? 16,
  }));

  const adj: Edge[][] = Array.from({ length: n }, () => []);
  for (const [a, b, li, dist, poly] of raw.edges) {
    const duration = dist / lines[li].cruise + DWELL;
    adj[a].push({ to: b, line: li, distance_m: dist, duration_s: duration, poly });
    // 逆向きは線形を反転して持たせる（描画で始点→終点の向きを保つため）
    adj[b].push({
      to: a,
      line: li,
      distance_m: dist,
      duration_s: duration,
      poly: [...poly].reverse(),
    });
  }

  const walk: [number, number, number][][] = Array.from({ length: n }, () => []);
  for (const [a, b, d] of raw.walk) {
    const t = d / WALK_MPS + WALK_XFER_WAIT;
    walk[a].push([b, d, t]);
    walk[b].push([a, d, t]);
  }

  cached = { source: raw.source, names, lng, lat, lines, adj, walk };
  console.log(`[rail] loaded ${n} stations / ${lines.length} lines / ${raw.edges.length} edges`);
  return cached;
}

// ---------------------------------------------------------------------- 探索

function haversine(ax: number, ay: number, bx: number, by: number): number {
  const R = 6371000;
  const p = Math.PI / 180;
  const dLat = (by - ay) * p;
  const dLng = (bx - ax) * p;
  const la = ((ay + by) / 2) * p;
  return R * Math.hypot(dLng * Math.cos(la), dLat);
}

/** 出発地・目的地の周りの駅候補（徒歩時間つき） */
function accessStations(g: Graph, at: LatLng): { idx: number; distance_m: number; seconds: number }[] {
  const out: { idx: number; distance_m: number; seconds: number }[] = [];
  for (let i = 0; i < g.names.length; i++) {
    const d = haversine(at.lng, at.lat, g.lng[i], g.lat[i]);
    if (d <= ACCESS_MAX_M) out.push({ idx: i, distance_m: d, seconds: (d * 1.25) / WALK_MPS });
  }
  out.sort((a, b) => a.distance_m - b.distance_m);
  // 同名でも別の駅グループなら別物として残す。
  // 「浅草」はつくばエクスプレスと銀座線で 500m 離れた別の駅で、
  // 名前で1つに畳むと銀座線側が候補から消えて経路が大回りになる。
  return out.slice(0, ACCESS_K);
}

/** 素朴なバイナリヒープ（[cost, stateId]） */
class Heap {
  private a: [number, number][] = [];
  push(item: [number, number]) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number] | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
}

export type RailLeg = {
  fromStation: string;
  toStation: string;
  operator: string;
  line: string;
  color: string;
  distance_m: number;
  duration_s: number;
  stops: number;
  polyline: [number, number][];
  /** 徒歩乗換区間なら true（駅間の連絡通路・地上乗換） */
  walk: boolean;
};

export type RailPlan = {
  legs: RailLeg[];
  board: { name: string; lat: number; lng: number; access_m: number };
  alight: { name: string; lat: number; lng: number; access_m: number };
  /** 鉄道区間のみの合計 */
  distance_m: number;
  duration_s: number;
  transfers: number;
  fare_jpy: number;
  source: string;
};

/**
 * 状態は「駅 × 乗っている路線」で持つ。
 * 駅だけで持つと乗換ペナルティを課せず、「1駅だけ乗って乗り換える」経路が
 * 勝ってしまう（実際にプロトタイプで踏んだ）。
 */
export function findRailRoute(from: LatLng, to: LatLng): RailPlan | null {
  if (!railAvailable()) return null;
  const g = loadGraph();

  const starts = accessStations(g, from);
  const goals = accessStations(g, to);
  if (starts.length === 0 || goals.length === 0) return null;

  const goalCost = new Map<number, number>();
  for (const c of goals) goalCost.set(c.idx, c.seconds);

  const L = g.lines.length;
  // stateId = station * (L + 1) + (line + 1)。line = -1 は「乗っていない」
  const S = L + 1;
  const stateId = (station: number, line: number) => station * S + (line + 1);

  const dist = new Map<number, number>();
  const prev = new Map<number, { state: number; edge: Edge | null; walk: [number, number, number] | null }>();
  const heap = new Heap();

  for (const c of starts) {
    const id = stateId(c.idx, -1);
    if (c.seconds < (dist.get(id) ?? Infinity)) {
      dist.set(id, c.seconds);
      heap.push([c.seconds, id]);
    }
  }

  let bestGoalState = -1;
  let bestTotal = Infinity;

  for (;;) {
    const top = heap.pop();
    if (!top) break;
    const [d, id] = top;
    if (d > (dist.get(id) ?? Infinity) + 1e-9) continue;
    if (d >= bestTotal) break; // これ以上探しても更新されない

    const station = Math.floor(id / S);
    const line = (id % S) - 1;

    const gc = goalCost.get(station);
    if (gc !== undefined && line >= 0) {
      const total = d + gc;
      if (total < bestTotal) {
        bestTotal = total;
        bestGoalState = id;
      }
    }

    for (const e of g.adj[station]) {
      if (!ALLOW_SHINKANSEN && g.lines[e.line].kind === "1") continue;
      const change = line < 0 ? BOARD_WAIT : e.line !== line ? TRANSFER : 0;
      const nd = d + e.duration_s + change;
      const nid = stateId(e.to, e.line);
      if (nd < (dist.get(nid) ?? Infinity)) {
        dist.set(nid, nd);
        prev.set(nid, { state: id, edge: e, walk: null });
        heap.push([nd, nid]);
      }
    }

    // 駅間の徒歩乗換。乗っていない状態（line = -1）に戻す。
    if (line >= 0) {
      for (const w of g.walk[station]) {
        const nd = d + w[2];
        const nid = stateId(w[0], -1);
        if (nd < (dist.get(nid) ?? Infinity)) {
          dist.set(nid, nd);
          prev.set(nid, { state: id, edge: null, walk: w });
          heap.push([nd, nid]);
        }
      }
    }
  }

  if (bestGoalState < 0) return null;

  // 経路復元
  type Step = { edge: Edge | null; walk: [number, number, number] | null; fromStation: number; toStation: number };
  const steps: Step[] = [];
  let cur = bestGoalState;
  while (prev.has(cur)) {
    const p = prev.get(cur)!;
    steps.push({
      edge: p.edge,
      walk: p.walk,
      fromStation: Math.floor(p.state / S),
      toStation: Math.floor(cur / S),
    });
    cur = p.state;
  }
  steps.reverse();
  if (steps.length === 0) return null;

  // 同一路線の連続区間をまとめて leg にする
  const legs: RailLeg[] = [];
  for (const s of steps) {
    if (s.walk) {
      legs.push({
        fromStation: g.names[s.fromStation],
        toStation: g.names[s.toStation],
        operator: "",
        line: "乗換",
        color: "#1a73e8",
        distance_m: s.walk[1],
        duration_s: s.walk[2],
        stops: 0,
        polyline: [
          [g.lng[s.fromStation], g.lat[s.fromStation]],
          [g.lng[s.toStation], g.lat[s.toStation]],
        ],
        walk: true,
      });
      continue;
    }
    const e = s.edge!;
    const meta = g.lines[e.line];
    const last = legs[legs.length - 1];
    if (last && !last.walk && last.line === meta.name && last.operator === meta.operator) {
      last.toStation = g.names[s.toStation];
      last.distance_m += e.distance_m;
      last.duration_s += e.duration_s;
      last.stops += 1;
      // 隣接エッジの端点は重複するので1点落として繋ぐ
      last.polyline.push(...e.poly.slice(1));
    } else {
      legs.push({
        fromStation: g.names[s.fromStation],
        toStation: g.names[s.toStation],
        operator: meta.operator,
        line: meta.name,
        color: meta.color,
        distance_m: e.distance_m,
        duration_s: e.duration_s,
        stops: 1,
        polyline: [...e.poly],
        walk: false,
      });
    }
  }

  const first = steps[0].fromStation;
  const lastStation = steps[steps.length - 1].toStation;
  const boardAccess = starts.find((c) => c.idx === first);
  const alightAccess = goals.find((c) => c.idx === lastStation);

  // 運賃は「事業者ごとの営業キロ → その事業者の運賃表 → 合算」
  const perOperator = new Map<string, number>();
  for (const l of legs) {
    if (l.walk || !l.operator) continue;
    perOperator.set(l.operator, (perOperator.get(l.operator) ?? 0) + l.distance_m);
  }
  let fare = 0;
  for (const [op, m] of perOperator) {
    fare += fareFor(op, (m / 1000) * FARE_DISTANCE_FACTOR);
  }
  // 東京メトロ ⇄ 都営地下鉄の乗継割引
  if (perOperator.has("東京地下鉄") && perOperator.has("東京都")) fare = Math.max(0, fare - 70);

  const railLegs = legs.filter((l) => !l.walk);
  return {
    legs,
    board: {
      name: g.names[first],
      lat: g.lat[first],
      lng: g.lng[first],
      access_m: Math.round(boardAccess?.distance_m ?? 0),
    },
    alight: {
      name: g.names[lastStation],
      lat: g.lat[lastStation],
      lng: g.lng[lastStation],
      access_m: Math.round(alightAccess?.distance_m ?? 0),
    },
    distance_m: Math.round(legs.reduce((s, l) => s + l.distance_m, 0)),
    duration_s: Math.round(legs.reduce((s, l) => s + l.duration_s, 0) + BOARD_WAIT + TRANSFER * Math.max(0, railLegs.length - 1)),
    transfers: Math.max(0, railLegs.length - 1),
    fare_jpy: fare,
    source: g.source,
  };
}
