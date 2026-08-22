import { buildRoute, elevationGain } from "./route";
import { getLeg, harvestRoute, legKey, putLeg, type LegBundle } from "./legcache";
import type { Itinerary, ItineraryDay, LatLng, RouteLeg, TravelMode } from "./types";

/**
 * 旅程 → 地図に敷ける「プラン」。
 *
 * 区間の経路・所要時間・到着予定時刻をここで埋める。save_itinerary は全置換なので
 * 編集のたびに全区間が来るが、実際に計算するのはキャッシュに無いものだけ（legcache.ts）。
 */

/** OSRM 公開デモにも国土地理院にも一度に殺到させない */
const CONCURRENCY = 4;

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export type PlanStop = { place_id: string; name: string; lat: number; lng: number };

/**
 * 1区間ぶんの移動を得る。キャッシュの当たり方で3通りに分岐する。
 *
 *   全部ある            … 何もしない
 *   標高だけ欠けている   … 国土地理院だけ叩く（OSRM を省く。get_route 由来のエントリがこれ）
 *   何も無い            … buildRoute で全部
 */
async function legBetween(
  sessionId: string,
  from: PlanStop,
  to: PlanStop,
  mode: TravelMode,
  at: LatLng | null,
): Promise<LegBundle> {
  const key = legKey(from.place_id, to.place_id, mode, at);
  const hit = getLeg(sessionId, key);

  if (hit) {
    // 距離・時間・線形はあるが標高だけ欠けている場合（get_route 由来のエントリ）は、
    // OSRM を省いて国土地理院だけ叩く。これが「部分的にヒットする」ケース。
    if (mode !== "walk" || hit.elevation_attempted) return hit;

    const line = hit.legs.flatMap((l) => l.polyline);
    const upgraded: LegBundle = {
      ...hit,
      elevation_gain_m: await elevationGain(line),
      elevation_attempted: true,
    };
    putLeg(sessionId, key, upgraded);
    return upgraded;
  }

  const route = await buildRoute(
    [
      { name: from.name, lat: from.lat, lng: from.lng },
      { name: to.name, lat: to.lat, lng: to.lng },
    ],
    mode,
  );
  harvestRoute(sessionId, [from.place_id, to.place_id], route, at);
  return (
    getLeg(sessionId, key) ?? {
      legs: route.legs,
      distance_m: route.distance_m,
      duration_s: route.duration_s,
      elevation_gain_m: route.elevation_gain_m,
      elevation_attempted: true,
      fare_jpy: route.estimated_fare_jpy,
      engine: route.engine,
    }
  );
}

// ------------------------------------------------------------------ 時刻

const pad = (n: number) => String(n).padStart(2, "0");

/** "09:30" → 570。読めなければ null。 */
function parseHHMM(s: string | null): number | null {
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 47 || mi > 59) return null;
  return h * 60 + mi;
}

/** 分（その日の0時起点）→ "HH:MM"。24時をまたいでも表示できるように 24 で折り返す。 */
function fmtMinutes(total: number): string {
  const m = Math.round(total);
  const wrapped = ((m % 1440) + 1440) % 1440;
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}

// ------------------------------------------------------------------ 本体

export type BuildPlanArgs = {
  sessionId: string;
  title: string;
  days: {
    date: string | null;
    items: {
      stop: PlanStop;
      start_time: string | null;
      duration_min: number | null;
      note: string | null;
      mode_from_previous: TravelMode | null;
    }[];
  }[];
  /** 現在地。"current" を含む区間のキャッシュキーに使う */
  at: LatLng | null;
  /** start_time がどこにも無いときの起点 */
  now: Date;
};

export async function buildPlan(args: BuildPlanArgs): Promise<Itinerary> {
  const { sessionId, at } = args;

  // 1) 移動区間をまとめて解決する。日をまたぐ移動は繋がないので、日ごとに閉じる。
  type Pending = { day: number; index: number; from: PlanStop; to: PlanStop; mode: TravelMode };
  const pending: Pending[] = [];
  args.days.forEach((day, di) => {
    for (let i = 1; i < day.items.length; i++) {
      pending.push({
        day: di,
        index: i,
        from: day.items[i - 1].stop,
        to: day.items[i].stop,
        mode: day.items[i].mode_from_previous ?? "walk",
      });
    }
  });

  const bundles = await mapLimit(pending, CONCURRENCY, (p) =>
    legBetween(sessionId, p.from, p.to, p.mode, at),
  );
  const byCell = new Map<string, LegBundle>();
  pending.forEach((p, i) => byCell.set(`${p.day}:${p.index}`, bundles[i]));

  // 2) 時刻を積み上げる。start_time が指定された項目が来たらそこで打ち直す
  //    （「17:00 には着きたい」と言われたときに、そこから先がずれないように）。
  const nowMin = args.now.getHours() * 60 + args.now.getMinutes();
  const legs: RouteLeg[] = [];
  let totalDistance = 0;
  let totalDuration = 0;
  let totalGain = 0;
  let sawGain = false;

  const days: ItineraryDay[] = args.days.map((day, di) => {
    let clock: number | null = null;

    const items = day.items.map((it, i) => {
      const bundle = i === 0 ? null : byCell.get(`${di}:${i}`) ?? null;

      if (bundle) {
        legs.push(...bundle.legs);
        totalDistance += bundle.distance_m;
        totalDuration += bundle.duration_s;
        if (bundle.elevation_gain_m !== null) {
          totalGain += bundle.elevation_gain_m;
          sawGain = true;
        }
        if (clock !== null) clock += bundle.duration_s / 60;
      }

      // 明示された時刻が最優先。無ければ積み上げた時刻。どちらも無ければ今の時刻。
      const explicit = parseHHMM(it.start_time);
      if (explicit !== null) clock = explicit;
      else if (clock === null) clock = i === 0 && di === 0 ? nowMin : null;

      const arrive = clock;
      const depart = clock !== null && it.duration_min ? clock + it.duration_min : clock;
      if (depart !== null) clock = depart;

      return {
        place_id: it.stop.place_id,
        name: it.stop.name,
        lat: it.stop.lat,
        lng: it.stop.lng,
        start_time: it.start_time,
        duration_min: it.duration_min,
        note: it.note,
        arrive_time: arrive === null ? null : fmtMinutes(arrive),
        depart_time: depart === null || depart === arrive ? null : fmtMinutes(depart),
        travel_from_previous: bundle
          ? {
              mode: it.mode_from_previous ?? "walk",
              duration_s: bundle.duration_s,
              distance_m: bundle.distance_m,
              elevation_gain_m: bundle.elevation_gain_m,
            }
          : null,
      };
    });

    return { date: day.date, items };
  });

  return {
    title: args.title,
    days,
    legs,
    total_distance_m: Math.round(totalDistance),
    total_duration_s: Math.round(totalDuration),
    total_elevation_gain_m: sawGain ? Math.round(totalGain) : null,
  };
}
