"use client";

import maplibregl, { type LngLatBoundsLike, type Map as MLMap } from "maplibre-gl";
import { useEffect, useRef } from "react";
import type { Itinerary, LatLng, Place, RouteResult } from "@/lib/types";

/**
 * 上ペインの地図。
 *
 * 地図は「共有状態の投影」でしかない（roadmap §1）。LLM は地図を操作せず、
 * search_places / get_route / save_itinerary の結果がそのままここに流れてくる。
 *
 * タイル: OpenFreeMap（OpenMapTiles スキーマのベクタタイル / OSM 由来・APIキー不要・無料）
 * ラスタではなくベクタなので、ズームしてもラベルが潰れず、ダークテーマとして設計された配色が使える。
 */

const MAP_STYLE = "https://tiles.openfreemap.org/styles/dark";

const MODE_COLOR: Record<string, string> = {
  walk: "#4cc2ff",
  transit: "#7ee787",
  taxi: "#ffb454",
  car: "#ff8f6b",
};

type Props = {
  places: Place[];
  route: RouteResult | null;
  itinerary: Itinerary | null;
  location: LatLng | null;
  onPickPlace: (place: Place) => void;
};

export default function MapPane({ places, route, itinerary, location, onPickPlace }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const markers = useRef<maplibregl.Marker[]>([]);
  const meMarker = useRef<maplibregl.Marker | null>(null);

  // --- 初期化 ---------------------------------------------------------------
  useEffect(() => {
    if (!holder.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: holder.current,
      style: MAP_STYLE,
      center: [139.7671, 35.6812], // 東京駅
      zoom: 12.2,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;

    map.on("load", () => {
      map.addSource("route", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      // ルートは「地名ラベルの下」に敷く。ベクタなので、上に載せるとラベルを潰してしまう。
      const firstLabel = map.getStyle().layers?.find((l) => l.type === "symbol")?.id;
      map.addLayer(
        {
          id: "route-casing",
          type: "line",
          source: "route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#05090d", "line-width": 10, "line-opacity": 0.85 },
        },
        firstLabel,
      );
      map.addLayer(
        {
          id: "route-line",
          type: "line",
          source: "route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ["coalesce", ["get", "color"], "#4cc2ff"],
            "line-width": 4.5,
          },
        },
        firstLabel,
      );
      ready.current = true;
    });

    // ペイン高さが変わったら resize（上下分割なので必須 / roadmap §1.5-2）
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(holder.current);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      ready.current = false;
    };
  }, []);

  // --- 現在地 ---------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !location) return;
    if (!meMarker.current) {
      const el = document.createElement("div");
      el.className = "pin-me";
      meMarker.current = new maplibregl.Marker({ element: el }).setLngLat([location.lng, location.lat]).addTo(map);
    } else {
      meMarker.current.setLngLat([location.lng, location.lat]);
    }
  }, [location]);

  // --- ピン（検索結果 + 旅程） ------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const m of markers.current) m.remove();
    markers.current = [];

    const itinItems = itinerary?.days.flatMap((d) => d.items) ?? [];
    const itinIds = new Set(itinItems.map((i) => i.place_id));

    // 検索結果：薄いピン（旅程に入っているものは番号ピン側で描くので除外）
    for (const p of places) {
      if (itinIds.has(p.place_id)) continue;
      const el = document.createElement("div");
      el.style.cssText =
        "width:12px;height:12px;border-radius:50%;background:#4cc2ff;border:2px solid #0f151b;box-shadow:0 0 0 1px #4cc2ff;cursor:pointer";
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([p.lng, p.lat])
        .setPopup(
          new maplibregl.Popup({ offset: 14, closeButton: false }).setHTML(
            popupHtml(p.name, [
              p.category,
              p.address ?? "",
              p.is_open_now === true ? "営業中" : p.is_open_now === false ? "営業時間外" : "",
              p.opening_hours ?? "",
              p.description ?? "",
            ]),
          ),
        )
        .addTo(map);
      el.addEventListener("click", () => onPickPlace(p));
      markers.current.push(marker);
    }

    // 旅程：番号つきの濃いピン（roadmap §5 原則2「旅程に入っているかで描き分ける」）
    itinItems.forEach((item, i) => {
      const el = document.createElement("div");
      el.className = "pin-num";
      el.textContent = String(i + 1);
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([item.lng, item.lat])
        .setPopup(
          new maplibregl.Popup({ offset: 18, closeButton: false }).setHTML(
            popupHtml(`${i + 1}. ${item.name}`, [
              item.start_time ? `${item.start_time}〜` : "",
              item.duration_min ? `滞在 ${item.duration_min}分` : "",
              item.note ?? "",
            ]),
          ),
        )
        .addTo(map);
      markers.current.push(marker);
    });
  }, [places, itinerary, onPickPlace]);

  // --- ルート ---------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("route") as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      src.setData({
        type: "FeatureCollection",
        features: route
          ? [
              {
                type: "Feature",
                properties: { color: MODE_COLOR[route.mode] ?? "#4cc2ff" },
                geometry: { type: "LineString", coordinates: route.polyline },
              },
            ]
          : [],
      });
    };
    if (ready.current) apply();
    else map.once("load", apply);
  }, [route]);

  // --- カメラ：結果の bounds に fit（カメラ操作はツールにしない / §5 原則2） ------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const pts: [number, number][] = [];
    if (route) pts.push(...route.polyline);
    for (const it of itinerary?.days.flatMap((d) => d.items) ?? []) pts.push([it.lng, it.lat]);
    for (const p of places) pts.push([p.lng, p.lat]);
    if (pts.length === 0) return;

    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of pts) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    const bounds: LngLatBoundsLike = [
      [minX, minY],
      [maxX, maxY],
    ];

    if (pts.length === 1) {
      map.easeTo({ center: pts[0], zoom: 15.5, duration: 700 });
      return;
    }
    // 上下分割なのでチャットに隠れる心配はない。ラベル分だけ上に余白を取る。
    map.fitBounds(bounds, { padding: { top: 60, bottom: 40, left: 40, right: 40 }, maxZoom: 16.5, duration: 800 });
  }, [places, route, itinerary]);

  return (
    <>
      <div ref={holder} className="map" />
      <div className="map-attr">
        地図: <a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a>
        {" © "}
        <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a>
        {" / "}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>
        {" / "}スポット: OSM, Wikidata, Wikivoyage
      </div>
    </>
  );
}

function popupHtml(title: string, lines: string[]): string {
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const body = lines
    .filter((l) => l && l.trim())
    .map((l) => `<div class="popup-meta">${esc(l.length > 140 ? `${l.slice(0, 140)}…` : l)}</div>`)
    .join("");
  return `<div class="popup-title">${esc(title)}</div>${body}`;
}
