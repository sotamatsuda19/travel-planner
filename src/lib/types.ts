export type LatLng = { lat: number; lng: number };

/**
 * 「だれが実際にその場所を使えるか」。
 * 出所は OSM のタグ / 東京都「だれでも東京」/ 東京都 飲食店バリアフリー情報 の3つ。
 *
 * **キーが無いことと false は意味が違う**。無い＝調べられていない、false＝設備が無い。
 * 条件検索は「true のものだけ」を通す。調査されていない場所を「無い」扱いにすると、
 * データの薄い店ほど不利になって、結果が実態とずれる。
 */
export type Accessibility = {
  /** yes=車椅子で利用可 / limited=一部可・介助が要るかもしれない / no=不可 */
  wheelchair?: "yes" | "limited" | "no";
  /** 入口に段差が無い */
  step_free?: boolean;
  step_height_cm?: number;
  entrance_width_cm?: number;
  slope?: boolean;
  auto_door?: boolean;
  elevator?: boolean;
  /** 車椅子対応トイレ／だれでもトイレ */
  accessible_toilet?: boolean;
  accessible_toilet_count?: number;
  ostomate?: boolean;
  /** おむつ替え台 */
  changing_table?: boolean;
  nursing_room?: boolean;
  tactile_paving?: boolean;
  braille_map?: boolean;
  braille_menu?: boolean;
  sign_language?: boolean;
  writing_support?: boolean;
  flash_bell?: boolean;
  wheelchair_rental?: boolean;
  stroller_rental?: boolean;
  assistance_dog?: boolean;
  accessible_parking?: boolean;
  movable_chairs?: boolean;
  table_clearance?: boolean;
  photo_menu?: boolean;
  multilingual_menu?: boolean;
  allergy?: boolean;
  vegetarian?: boolean;
  halal?: boolean;
  free_toilet?: boolean;
  unisex_toilet?: boolean;
  /** この情報自体の出典 */
  src?: string;
};

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
  access: Accessibility | null;
  /** true なら座標は住所からの推定（街区〜町丁目の代表点）で、建物のピンポイントではない */
  approx?: boolean;
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
  accessibility: Accessibility | null;
  /** 座標が住所からの推定であることを地図・文章の両方で断るためのフラグ */
  approx_location: boolean;
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
