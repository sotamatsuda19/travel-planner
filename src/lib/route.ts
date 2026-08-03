import { haversine, nearestStation } from "./poi";
import type { LatLng, RouteLeg, RouteResult, TravelMode } from "./types";

/**
 * 経路探索。
 *   - walk / car / taxi : OSRM（あれば）→ 失敗したら直線近似にフォールバック
 *   - transit           : 最寄り駅どうしを結ぶ近似（徒歩→電車→徒歩）
 *
 * roadmap §5 原則3「ツールを増やす代わりに返り値を厚くする」に従い、
 * 料金・累積標高・区間内訳をすべてこの返り値に載せる。
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

/** 鉄道運賃のざっくり見積り（距離帯別） */
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

// ------------------------------------------------------------- 標高（国土地理院）

/** polyline を等間隔にサンプリングして累積標高を出す（国土地理院 標高API / 政府オープンデータ） */
async function elevationGain(polyline: [number, number][]): Promise<number | null> {
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

// -------------------------------------------------------------------- 本体

export async function buildRoute(stops: Stop[], mode: TravelMode): Promise<RouteResult> {
  if (stops.length < 2) throw new Error("経路には2地点以上が必要です");

  if (mode === "transit") return transitRoute(stops);

  const osrm = await osrmRoute(stops, mode);
  const legs: RouteLeg[] = [];
  let polyline: [number, number][] = [];
  let distance = 0;
  let duration = 0;
  let engine = "straight-line-estimate";

  if (osrm) {
    engine = "OSRM";
    polyline = osrm.polyline;
    distance = osrm.distance_m;
    duration = osrm.duration_s;
    osrm.legs.forEach((l, i) => {
      legs.push({
        from: stops[i].name,
        to: stops[i + 1].name,
        mode,
        distance_m: Math.round(l.distance),
        duration_s: Math.round(l.duration),
        note: null,
      });
    });
  } else {
    for (let i = 0; i < stops.length - 1; i++) {
      const seg = straightSegment(stops[i], stops[i + 1], mode);
      distance += seg.distance;
      duration += seg.duration;
      polyline.push(...interpolate(stops[i], stops[i + 1]));
      legs.push({
        from: stops[i].name,
        to: stops[i + 1].name,
        mode,
        distance_m: seg.distance,
        duration_s: seg.duration,
        note: "直線距離からの概算",
      });
    }
  }

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

/** 徒歩 → 最寄り駅 → 電車 → 最寄り駅 → 徒歩 の近似 */
async function transitRoute(stops: Stop[]): Promise<RouteResult> {
  const legs: RouteLeg[] = [];
  const polyline: [number, number][] = [];
  let distance = 0;
  let duration = 0;
  let fare = 0;

  for (let i = 0; i < stops.length - 1; i++) {
    const from = stops[i];
    const to = stops[i + 1];
    const fromStation = nearestStation({ lat: from.lat, lng: from.lng });
    const toStation = nearestStation({ lat: to.lat, lng: to.lng });

    const direct = straightSegment(from, to, "walk");
    // 近すぎる（1.2km未満）なら歩いた方が早い
    if (!fromStation || !toStation || fromStation.display === toStation.display || direct.distance < 1200) {
      distance += direct.distance;
      duration += direct.duration;
      polyline.push(...interpolate(from, to));
      legs.push({
        from: from.name,
        to: to.name,
        mode: "walk",
        distance_m: direct.distance,
        duration_s: direct.duration,
        note: "近いので徒歩",
      });
      continue;
    }

    const sFrom: Stop = { name: fromStation.display, lat: fromStation.lat, lng: fromStation.lon };
    const sTo: Stop = { name: toStation.display, lat: toStation.lat, lng: toStation.lon };

    const walkA = straightSegment(from, sFrom, "walk");
    const train = straightSegment(sFrom, sTo, "transit");
    const walkB = straightSegment(sTo, to, "walk");
    const waitS = 240; // 待ち時間 + 乗り換え

    polyline.push(...interpolate(from, sFrom), ...interpolate(sFrom, sTo, 24), ...interpolate(sTo, to));
    distance += walkA.distance + train.distance + walkB.distance;
    duration += walkA.duration + train.duration + walkB.duration + waitS;
    fare += trainFare(train.distance);

    // 目的地が駅そのもの等で徒歩区間が無い場合は、その leg を出さない
    if (walkA.distance > 60) {
      legs.push({ from: from.name, to: sFrom.name, mode: "walk", distance_m: walkA.distance, duration_s: walkA.duration, note: null });
    }
    legs.push({
      from: sFrom.name,
      to: sTo.name,
      mode: "transit",
      distance_m: train.distance,
      duration_s: train.duration + waitS,
      note: `${fromStation.operator ?? "鉄道"} ほか（待ち時間込みの概算）`,
    });
    if (walkB.distance > 60) {
      legs.push({ from: sTo.name, to: to.name, mode: "walk", distance_m: walkB.distance, duration_s: walkB.duration, note: null });
    }
  }

  return {
    mode: "transit",
    polyline,
    distance_m: distance,
    duration_s: duration,
    legs,
    estimated_fare_jpy: fare || null,
    elevation_gain_m: null,
    waypoints: stops.map((s) => ({ name: s.name, lat: s.lat, lng: s.lng })),
    engine: "station-graph-estimate (OSM railway_station)",
  };
}
