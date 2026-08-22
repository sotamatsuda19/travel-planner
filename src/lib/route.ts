import { haversine, nearestStation } from "./poi";
import { findRailRoute, railAvailable } from "./rail";
import type { LatLng, RouteLeg, RouteResult, TravelMode } from "./types";

/**
 * 経路探索。
 *   - walk / car / taxi : OSRM（あれば）→ 失敗したら直線近似にフォールバック
 *   - transit           : 国土数値情報 N02 の駅グラフで実際の線路の上を通す
 *                         （data/rail.json が無ければ従来の直線近似に落ちる）
 *
 * roadmap §5 原則3「ツールを増やす代わりに返り値を厚くする」に従い、
 * 料金・累積標高・区間内訳をすべてこの返り値に載せる。
 *
 * 区間（leg）は線形 polyline を持つ。地図はルート全体ではなく leg 単位で描くので、
 * 「徒歩は点線・鉄道は路線カラー」の描き分けがここで決まる。
 */

const OSRM_BASE = process.env.OSRM_URL ?? "https://router.project-osrm.org";
const OSRM_TIMEOUT_MS = Number(process.env.OSRM_TIMEOUT_MS ?? 2500);

type Stop = { name: string; lat: number; lng: number };

const SPEED_MPS: Record<TravelMode, number> = {
  walk: 1.25, // 約 4.5km/h
  car: 6.9, // 都内平均 25km/h
  taxi: 6.9,
  transit: 8.3, // 停車込み 30km/h
};

/** 直線距離 → 実際の道のりの補正係数（都市部） */
const DETOUR = 1.28;

/** これより近ければ電車を使わず歩く */
const TRANSIT_MIN_M = 1200;

// ------------------------------------------------------------------- 料金

/** 東京都の一般的なタクシー運賃（初乗り500円/1.096km、以降255mごと100円 + 時間距離併用の概算） */
export function taxiFare(distanceM: number, durationS: number): number {
  const base = 500;
  const baseDist = 1096;
  if (distanceM <= baseDist) return base;
  const extra = Math.ceil((distanceM - baseDist) / 255) * 100;
  // 渋滞時加算（時速10km以下の走行時間を概算で足す）
  const slowMinutes = Math.max(0, durationS / 60 - distanceM / 1000 / 25 * 60);
  const timeCharge = Math.ceil(slowMinutes / 1.5) * 100;
  return base + extra + timeCharge;
}

/** 鉄道運賃のざっくり見積り（距離帯別）。駅グラフが無いときのフォールバック用。 */
export function trainFare(distanceM: number): number {
  const km = distanceM / 1000;
  if (km <= 3) return 170;
  if (km <= 6) return 200;
  if (km <= 10) return 240;
  if (km <= 15) return 310;
  if (km <= 20) return 390;
  if (km <= 30) return 510;
  return 510 + Math.ceil((km - 30) / 10) * 180;
}

// ------------------------------------------------------------------ OSRM

const OSRM_PROFILE: Record<TravelMode, string> = {
  walk: "foot",
  car: "driving",
  taxi: "driving",
  transit: "driving",
};

async function osrmRoute(
  stops: Stop[],
  mode: TravelMode,
): Promise<{ polyline: [number, number][]; distance_m: number; duration_s: number; legs: { distance: number; duration: number }[] } | null> {
  if (process.env.DISABLE_OSRM === "1") return null;
  const coords = stops.map((s) => `${s.lng},${s.lat}`).join(";");
  const url = `${OSRM_BASE}/route/v1/${OSRM_PROFILE[mode]}/${coords}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(OSRM_TIMEOUT_MS) });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      code: string;
      routes?: {
        geometry: { coordinates: [number, number][] };
        distance: number;
        duration: number;
        legs: { distance: number; duration: number }[];
      }[];
    };
    const r = json.routes?.[0];
    if (json.code !== "Ok" || !r) return null;
    return {
      polyline: r.geometry.coordinates,
      distance_m: Math.round(r.distance),
      duration_s: Math.round(r.duration),
      legs: r.legs.map((l) => ({ distance: l.distance, duration: l.duration })),
    };
  } catch {
    return null; // ネットワーク不通・タイムアウト時は近似にフォールバック
  }
}

/**
 * OSRM は経路全体の線形しか返さないので、経由地に一番近い頂点で切り分ける。
 * 厳密な leg 境界ではないが、描き分けの用途には十分。
 */
function splitAtWaypoints(polyline: [number, number][], stops: Stop[]): [number, number][][] {
  if (stops.length <= 2 || polyline.length < 2) return [polyline];
  const cuts = [0];
  let from = 0;
  for (let i = 1; i < stops.length - 1; i++) {
    let best = from;
    let bestD = Infinity;
    for (let j = from; j < polyline.length; j++) {
      const d = haversine({ lat: polyline[j][1], lng: polyline[j][0] }, stops[i]);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    cuts.push(Math.max(best, from + 1));
    from = cuts[cuts.length - 1];
  }
  cuts.push(polyline.length - 1);
  const out: [number, number][][] = [];
  for (let i = 0; i < cuts.length - 1; i++) out.push(polyline.slice(cuts[i], cuts[i + 1] + 1));
  return out;
}

// ------------------------------------------------------------- 標高（国土地理院）

/** polyline を等間隔にサンプリングして累積標高を出す（国土地理院 標高API / 政府オープンデータ） */
export async function elevationGain(polyline: [number, number][]): Promise<number | null> {
  if (process.env.DISABLE_ELEVATION === "1") return null;
  if (polyline.length < 2) return null;
  const samples = 10;
  const step = Math.max(1, Math.floor(polyline.length / samples));
  const points = polyline.filter((_, i) => i % step === 0).slice(0, samples);

  try {
    const results = await Promise.all(
      points.map(async ([lng, lat]) => {
        const url = `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${lng}&lat=${lat}&outtype=JSON`;
        const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
        if (!res.ok) return null;
        const j = (await res.json()) as { elevation: number | string };
        const e = typeof j.elevation === "number" ? j.elevation : Number(j.elevation);
        return Number.isFinite(e) ? e : null;
      }),
    );
    const elevs = results.filter((e): e is number => e !== null);
    if (elevs.length < 3) return null;
    let gain = 0;
    for (let i = 1; i < elevs.length; i++) {
      const d = elevs[i] - elevs[i - 1];
      if (d > 0) gain += d;
    }
    return Math.round(gain);
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- 直線近似

function straightSegment(a: Stop, b: Stop, mode: TravelMode) {
  const straight = haversine({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng });
  const distance = Math.round(straight * DETOUR);
  const duration = Math.round(distance / SPEED_MPS[mode]);
  return { distance, duration };
}

function interpolate(a: Stop, b: Stop, n = 12): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([a.lng + (b.lng - a.lng) * t, a.lat + (b.lat - a.lat) * t]);
  }
  return out;
}

/** 徒歩区間。OSRM が使えれば道なりに、駄目なら直線に落とす。 */
async function walkLeg(a: Stop, b: Stop, note: string | null): Promise<RouteLeg> {
  const osrm = await osrmRoute([a, b], "walk");
  if (osrm) {
    return {
      from: a.name,
      to: b.name,
      mode: "walk",
      distance_m: osrm.distance_m,
      duration_s: osrm.duration_s,
      note,
      polyline: osrm.polyline,
      operator: null,
      line: null,
      color: null,
    };
  }
  const seg = straightSegment(a, b, "walk");
  return {
    from: a.name,
    to: b.name,
    mode: "walk",
    distance_m: seg.distance,
    duration_s: seg.duration,
    note: note ? `${note}（直線距離からの概算）` : "直線距離からの概算",
    polyline: interpolate(a, b),
    operator: null,
    line: null,
    color: null,
  };
}

/** leg の線形を繋いで1本にする（カメラの fit と標高サンプリングに使う） */
function joinLegs(legs: RouteLeg[]): [number, number][] {
  const out: [number, number][] = [];
  for (const l of legs) {
    if (l.polyline.length === 0) continue;
    if (out.length === 0) out.push(...l.polyline);
    else out.push(...l.polyline.slice(1));
  }
  return out;
}

// -------------------------------------------------------------------- 本体

export async function buildRoute(stops: Stop[], mode: TravelMode): Promise<RouteResult> {
  if (stops.length < 2) throw new Error("経路には2地点以上が必要です");

  if (mode === "transit") return transitRoute(stops);

  const osrm = await osrmRoute(stops, mode);
  const legs: RouteLeg[] = [];
  let distance = 0;
  let duration = 0;
  let engine = "straight-line-estimate";

  if (osrm) {
    engine = "OSRM";
    distance = osrm.distance_m;
    duration = osrm.duration_s;
    const parts = splitAtWaypoints(osrm.polyline, stops);
    osrm.legs.forEach((l, i) => {
      legs.push({
        from: stops[i].name,
        to: stops[i + 1].name,
        mode,
        distance_m: Math.round(l.distance),
        duration_s: Math.round(l.duration),
        note: null,
        polyline: parts[i] ?? [],
        operator: null,
        line: null,
        color: null,
      });
    });
  } else {
    for (let i = 0; i < stops.length - 1; i++) {
      const seg = straightSegment(stops[i], stops[i + 1], mode);
      distance += seg.distance;
      duration += seg.duration;
      legs.push({
        from: stops[i].name,
        to: stops[i + 1].name,
        mode,
        distance_m: seg.distance,
        duration_s: seg.duration,
        note: "直線距離からの概算",
        polyline: interpolate(stops[i], stops[i + 1]),
        operator: null,
        line: null,
        color: null,
      });
    }
  }

  const polyline = osrm ? osrm.polyline : joinLegs(legs);
  const elevation = mode === "walk" ? await elevationGain(polyline) : null;

  return {
    mode,
    polyline,
    distance_m: distance,
    duration_s: duration,
    legs,
    estimated_fare_jpy: mode === "taxi" ? taxiFare(distance, duration) : null,
    elevation_gain_m: elevation,
    waypoints: stops.map((s) => ({ name: s.name, lat: s.lat, lng: s.lng })),
    engine,
  };
}

/**
 * 徒歩 → 電車（実際の線路の上）→ 徒歩。
 * 駅グラフが使えないときだけ、従来どおり最寄り駅を直線で結ぶ近似に落ちる。
 */
async function transitRoute(stops: Stop[]): Promise<RouteResult> {
  const legs: RouteLeg[] = [];
  let fare = 0;
  let engine = "station-graph-estimate (OSM railway_station)";
  let usedRail = false;

  for (let i = 0; i < stops.length - 1; i++) {
    const from = stops[i];
    const to = stops[i + 1];
    const straight = haversine({ lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng });

    // 近すぎるなら歩いた方が早い
    if (straight * DETOUR < TRANSIT_MIN_M) {
      legs.push(await walkLeg(from, to, "近いので徒歩"));
      continue;
    }

    const plan = railAvailable()
      ? findRailRoute({ lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng })
      : null;

    if (plan && plan.legs.some((l) => !l.walk)) {
      usedRail = true;
      engine = plan.source;
      fare += plan.fare_jpy;

      // 出発地 → 乗車駅
      if (plan.board.access_m > 60) {
        legs.push(
          await walkLeg(from, { name: `${plan.board.name}駅`, lat: plan.board.lat, lng: plan.board.lng }, null),
        );
      }

      for (const rl of plan.legs) {
        legs.push({
          from: `${rl.fromStation}駅`,
          to: `${rl.toStation}駅`,
          mode: rl.walk ? "walk" : "transit",
          distance_m: Math.round(rl.distance_m),
          duration_s: Math.round(rl.duration_s),
          note: rl.walk
            ? "駅間の徒歩乗換"
            : `${rl.operator} ${rl.line} / ${rl.stops}駅`,
          polyline: rl.polyline,
          operator: rl.walk ? null : rl.operator,
          line: rl.walk ? null : rl.line,
          color: rl.walk ? null : rl.color,
        });
      }

      // 降車駅 → 目的地
      if (plan.alight.access_m > 60) {
        legs.push(
          await walkLeg({ name: `${plan.alight.name}駅`, lat: plan.alight.lat, lng: plan.alight.lng }, to, null),
        );
      }
      continue;
    }

    // ---- フォールバック: 最寄り駅どうしを直線で結ぶ（従来の近似）----
    const fromStation = nearestStation({ lat: from.lat, lng: from.lng });
    const toStation = nearestStation({ lat: to.lat, lng: to.lng });
    if (!fromStation || !toStation || fromStation.display === toStation.display) {
      legs.push(await walkLeg(from, to, "近いので徒歩"));
      continue;
    }

    const sFrom: Stop = { name: fromStation.display, lat: fromStation.lat, lng: fromStation.lon };
    const sTo: Stop = { name: toStation.display, lat: toStation.lat, lng: toStation.lon };
    const walkA = straightSegment(from, sFrom, "walk");
    const train = straightSegment(sFrom, sTo, "transit");
    const walkB = straightSegment(sTo, to, "walk");
    const waitS = 240;
    fare += trainFare(train.distance);

    if (walkA.distance > 60) {
      legs.push({
        from: from.name,
        to: sFrom.name,
        mode: "walk",
        distance_m: walkA.distance,
        duration_s: walkA.duration,
        note: null,
        polyline: interpolate(from, sFrom),
        operator: null,
        line: null,
        color: null,
      });
    }
    legs.push({
      from: sFrom.name,
      to: sTo.name,
      mode: "transit",
      distance_m: train.distance,
      duration_s: train.duration + waitS,
      note: `${fromStation.operator ?? "鉄道"} ほか（直線距離からの概算）`,
      polyline: interpolate(sFrom, sTo, 24),
      operator: fromStation.operator,
      line: null,
      color: null,
    });
    if (walkB.distance > 60) {
      legs.push({
        from: sTo.name,
        to: to.name,
        mode: "walk",
        distance_m: walkB.distance,
        duration_s: walkB.duration,
        note: null,
        polyline: interpolate(sTo, to),
        operator: null,
        line: null,
        color: null,
      });
    }
  }

  // 乗換の待ち時間は leg の外側に乗るので、ここで足す
  const railLegCount = legs.filter((l) => l.mode === "transit").length;
  const overhead = usedRail ? 150 + Math.max(0, railLegCount - 1) * 240 : 0;

  return {
    mode: "transit",
    polyline: joinLegs(legs),
    distance_m: legs.reduce((s, l) => s + l.distance_m, 0),
    duration_s: legs.reduce((s, l) => s + l.duration_s, 0) + overhead,
    legs,
    estimated_fare_jpy: fare || null,
    elevation_gain_m: null,
    waypoints: stops.map((s) => ({ name: s.name, lat: s.lat, lng: s.lng })),
    engine,
  };
}
