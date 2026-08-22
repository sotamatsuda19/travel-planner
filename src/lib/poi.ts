import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { Accessibility, LatLng, Place, PoiRecord } from "./types";

/**
 * POI インデックス（オープンデータ由来）のロードと検索。
 *
 * 設計方針（roadmap §5「実装上の注意点：place_id の管理」）:
 *   LLM が触っていいのは place_id だけ。座標・名前・メタ情報はここが持つ。
 */

const DATA_DIR = path.join(process.cwd(), "data");

type Area = { name: string; lat: number; lon: number };
type Station = {
  name: string;
  display: string;
  lat: number;
  lon: number;
  operator: string | null;
  subway: boolean;
};

type Index = {
  pois: PoiRecord[];
  byId: Map<string, PoiRecord>;
  areas: Map<string, Area>;
  stations: Station[];
};

let cached: Index | null = null;

/**
 * POI 本体を読む。手元は poi.jsonl、デプロイ先は poi.jsonl.gz（24MB → 3MB）。
 * 非圧縮を先に見るのは、build:index の再生成が即座に反映されるようにするため。
 */
function readPoiText(): string {
  const plain = path.join(DATA_DIR, "poi.jsonl");
  if (fs.existsSync(plain)) return fs.readFileSync(plain, "utf8");

  const gz = path.join(DATA_DIR, "poi.jsonl.gz");
  if (fs.existsSync(gz)) return zlib.gunzipSync(fs.readFileSync(gz)).toString("utf8");

  throw new Error(
    `POI インデックスがありません: ${plain}\n先に \`npm run build:index\` を実行してください。`,
  );
}

export function normalize(s: string): string {
  if (!s) return "";
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[・･\s]+/g, " ")
    .trim();
}

export function loadIndex(): Index {
  if (cached) return cached;

  const pois: PoiRecord[] = [];
  const byId = new Map<string, PoiRecord>();
  for (const line of readPoiText().split("\n")) {
    if (!line) continue;
    const rec = JSON.parse(line) as PoiRecord;
    pois.push(rec);
    byId.set(rec.id, rec);
  }

  const areasRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "areas.json"), "utf8")) as Record<
    string,
    Area
  >;
  const areas = new Map<string, Area>(Object.entries(areasRaw));
  const stations = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, "stations.json"), "utf8"),
  ) as Station[];

  cached = { pois, byId, areas, stations };
  console.log(`[poi] loaded ${pois.length} spots / ${areas.size} areas / ${stations.length} stations`);
  return cached;
}

// ------------------------------------------------------------------ 距離計算

export function haversine(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ------------------------------------------------------------- 地名 → 座標

export function resolveArea(name: string | null | undefined): (Area & { matched: string }) | null {
  if (!name) return null;
  const { areas } = loadIndex();
  const q = normalize(name);
  const direct = areas.get(q) ?? areas.get(q.replace(/駅$/, "")) ?? areas.get(`${q}駅`);
  if (direct) return { ...direct, matched: direct.name };

  // 部分一致（短い名前を優先＝より一般的な地名）
  let best: Area | null = null;
  for (const [key, area] of areas) {
    if (key.includes(q) || q.includes(key)) {
      if (key.length < 2) continue;
      if (!best || key.length < normalize(best.name).length) best = area;
    }
  }
  return best ? { ...best, matched: best.name } : null;
}

export function nearestStation(at: LatLng): (Station & { distance_m: number }) | null {
  const { stations } = loadIndex();
  let best: (Station & { distance_m: number }) | null = null;
  for (const s of stations) {
    const d = haversine(at, { lat: s.lat, lng: s.lon });
    if (!best || d < best.distance_m) best = { ...s, distance_m: d };
  }
  return best;
}

// --------------------------------------------------------------- 営業時間判定

/** OSM opening_hours の“ざっくり”判定。厳密なパースはしない（判定不能なら null）。 */
export function isOpenNow(spec: string | null, now: Date): boolean | null {
  if (!spec) return null;
  const s = spec.trim();
  if (/24\/7/.test(s)) return true;
  const days = ["su", "mo", "tu", "we", "th", "fr", "sa"];
  const today = days[now.getDay()];
  const minutes = now.getHours() * 60 + now.getMinutes();

  let sawRule = false;
  for (const rule of s.split(";")) {
    const m = rule.trim().match(/^([A-Za-z,\-]*)\s*([0-9:,\- ]+)$/);
    if (!m) continue;
    const [, dayPart, timePart] = m;
    if (dayPart) {
      const dl = dayPart.toLowerCase();
      const listed = dl
        .split(",")
        .flatMap((token) => {
          const range = token.split("-");
          if (range.length === 2) {
            const a = days.indexOf(range[0].slice(0, 2));
            const b = days.indexOf(range[1].slice(0, 2));
            if (a < 0 || b < 0) return [];
            const out: string[] = [];
            for (let i = a; ; i = (i + 1) % 7) {
              out.push(days[i]);
              if (i === b) break;
            }
            return out;
          }
          return [token.slice(0, 2)];
        })
        .filter(Boolean);
      if (listed.length && !listed.includes(today)) continue;
    }
    for (const span of timePart.split(",")) {
      const t = span.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
      if (!t) continue;
      sawRule = true;
      const from = +t[1] * 60 + +t[2];
      let to = +t[3] * 60 + +t[4];
      if (to <= from) to += 24 * 60; // 深夜営業
      if (minutes >= from && minutes <= to) return true;
      if (minutes + 24 * 60 >= from && minutes + 24 * 60 <= to) return true;
    }
  }
  return sawRule ? false : null;
}

// -------------------------------------------------------------------- 検索

/**
 * search_places の `require` で指定できる条件。
 * Accessibility のキーそのままではなく、「利用者が言う言葉」の単位でまとめてある
 * （例: wheelchair は wheelchair タグと step_free のどちらでも満たされる）。
 */
export const ACCESS_REQUIREMENTS = [
  "wheelchair",
  "step_free",
  "elevator",
  "accessible_toilet",
  "ostomate",
  "changing_table",
  "nursing_room",
  "tactile_paving",
  "braille",
  "sign_language",
  "writing_support",
  "wheelchair_rental",
  "stroller_rental",
  "assistance_dog",
  "accessible_parking",
  "multilingual_menu",
  "allergy",
  "vegetarian",
  "halal",
] as const;

export type AccessRequirement = (typeof ACCESS_REQUIREMENTS)[number];

/** 1つの要件を満たすか。**分かっていない項目は満たさない扱い**（false ではなく未調査でも落とす）。 */
function satisfies(a: Accessibility | null, req: AccessRequirement): boolean {
  if (!a) return false;
  switch (req) {
    case "wheelchair":
      // 「段差が無い」だけでも実用上は通れる。ただし wheelchair=no は明確な否定なので優先する。
      if (a.wheelchair === "no") return false;
      return a.wheelchair === "yes" || a.step_free === true;
    case "step_free":
      return a.step_free === true || a.slope === true;
    case "braille":
      return a.braille_map === true || a.braille_menu === true || a.tactile_paving === true;
    default:
      return a[req] === true;
  }
}

export type SearchArgs = {
  query: string;
  near?: LatLng | null;
  nearLabel?: string | null;
  radiusM?: number;
  limit?: number;
  openNow?: boolean;
  /** 全部満たすものだけを返す（AND 条件） */
  require?: AccessRequirement[];
  now?: Date;
};

export function toPlace(rec: PoiRecord, origin: LatLng | null, now: Date): Place {
  const distance = origin ? Math.round(haversine(origin, { lat: rec.lat, lng: rec.lon })) : null;
  return {
    place_id: rec.id,
    name: rec.name,
    category: rec.label,
    lat: rec.lat,
    lng: rec.lon,
    address: [rec.city, rec.hood].filter(Boolean).join(" ") || null,
    description: rec.desc,
    opening_hours: rec.hours,
    is_open_now: isOpenNow(rec.hours, now),
    website: rec.website,
    distance_m: distance,
    source: rec.source,
    accessibility: rec.access ?? null,
    approx_location: rec.approx === true,
  };
}

export function searchPlaces(args: SearchArgs): { places: Place[]; center: LatLng | null } {
  const { pois } = loadIndex();
  const now = args.now ?? new Date();
  const limit = Math.min(args.limit ?? 8, 20);
  const radius = args.radiusM ?? 2500;
  const origin = args.near ?? null;

  const req = args.require ?? [];

  const q = normalize(args.query);
  const tokens = q.split(" ").filter((t) => t.length > 0);

  type Scored = { rec: PoiRecord; score: number; dist: number };
  const hits: Scored[] = [];

  for (const rec of pois) {
    const dist = origin ? haversine(origin, { lat: rec.lat, lng: rec.lon }) : 0;
    if (origin && dist > radius) continue;

    let score = 0;
    if (tokens.length === 0) {
      score = 1;
    } else {
      for (const t of tokens) {
        const nameHit = normalize(rec.name).includes(t);
        const textHit = rec.s.includes(t);
        if (nameHit) score += 4;
        else if (textHit) score += 2;
      }
      // クエリ全体が入っていればボーナス
      if (q.length > 1 && rec.s.includes(q)) score += 2;
    }
    if (score <= 0) continue;

    if (args.openNow) {
      const open = isOpenNow(rec.hours, now);
      if (open === false) continue;
      if (open === true) score += 1;
    }
    if (req.length) {
      if (!req.every((r) => satisfies(rec.access, r))) continue;
      // 調査が新しく詳しいもの（都のバリアフリー調査）を上に出す
      score += Object.keys(rec.access ?? {}).length * 0.2;
    }
    if (rec.desc) score += 1.5; // 説明文（Wikidata/Wikivoyage）があるものを優先
    if (rec.website) score += 0.3;
    if (rec.cats[0] === "toilets" || rec.cats[0] === "facility") score -= 2; // 明示的に探した時だけ上位に

    hits.push({ rec, score, dist });
  }

  hits.sort((a, b) => {
    const d = b.score - a.score;
    if (Math.abs(d) > 0.5) return d;
    return a.dist - b.dist;
  });

  // 半径内で全然見つからなければ、範囲を広げて再検索（1回だけ）
  if (hits.length === 0 && origin && radius < 12000) {
    return searchPlaces({ ...args, radiusM: radius * 4 });
  }

  const places = hits.slice(0, limit).map((h) => toPlace(h.rec, origin, now));
  return { places, center: origin };
}

export function getPlace(placeId: string): PoiRecord | null {
  return loadIndex().byId.get(placeId) ?? null;
}
