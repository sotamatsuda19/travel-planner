export type LatLng = { lat: number; lng: number };

/** 検索インデックスの1レコード（data/poi.jsonl） */
export type PoiRecord = {
  id: string;
  name: string;
  name_en: string | null;
  cats: string[];
  label: string;
  lat: number;
  lon: number;
  city: string | null;
  hood: string | null;
  hours: string | null;
  website: string | null;
  phone: string | null;
  desc: string | null;
  source: string;
  /** 正規化済み検索テキスト */
  s: string;
};

/** フロント（地図）とチャットの両方に流れる検索結果 */
export type Place = {
  place_id: string;
  name: string;
  category: string;
  lat: number;
  lng: number;
  address: string | null;
  description: string | null;
  opening_hours: string | null;
  is_open_now: boolean | null;
  website: string | null;
  distance_m: number | null;
  source: string;
};

export type RouteLeg = {
  from: string;
  to: string;
  mode: TravelMode;
  distance_m: number;
  duration_s: number;
  note: string | null;
  /**
   * この区間だけの線形 [lng, lat][]。
   * 地図は route.polyline ではなく leg 単位で描くので、
   * 「徒歩は点線・鉄道は路線カラー」の描き分けがここで決まる。
   */
  polyline: [number, number][];
  /** 鉄道区間のみ: 事業者名（運賃の按分キー） */
  operator: string | null;
  /** 鉄道区間のみ: 路線名 */
  line: string | null;
  /** 描画色。null ならモード既定色にフォールバック */
  color: string | null;
};

export type TravelMode = "walk" | "transit" | "taxi" | "car";

export type RouteResult = {
  mode: TravelMode;
  /** [lng, lat][] — 地図にそのまま流す */
  polyline: [number, number][];
  distance_m: number;
  duration_s: number;
  legs: RouteLeg[];
  estimated_fare_jpy: number | null;
  elevation_gain_m: number | null;
  waypoints: { name: string; lat: number; lng: number }[];
  engine: string;
};

export type ItineraryItem = {
  place_id: string;
  name: string;
  lat: number;
  lng: number;
  start_time: string | null;
  duration_min: number | null;
  note: string | null;
  travel_from_previous: { mode: TravelMode; duration_s: number } | null;
};

export type ItineraryDay = {
  date: string | null;
  items: ItineraryItem[];
};

export type Itinerary = {
  title: string;
  days: ItineraryDay[];
};

/** SSE で流すイベント */
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_start"; name: string; summary: string }
  | { type: "places"; query: string; places: Place[] }
  | { type: "route"; route: RouteResult }
  | { type: "itinerary"; itinerary: Itinerary }
  | { type: "context"; weather: string | null; area: string | null }
  | { type: "done" }
  | { type: "error"; message: string };
