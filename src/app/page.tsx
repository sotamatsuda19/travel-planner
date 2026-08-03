"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import MapPane from "@/components/MapPane";
import type { Itinerary, LatLng, Place, RouteResult, StreamEvent } from "@/lib/types";

type Msg = {
  id: string;
  role: "user" | "assistant" | "tool" | "error";
  text: string;
};

const TOKYO: LatLng = { lat: 35.6812, lng: 139.7671 };

const SUGGESTIONS = [
  "ラーメン食べたいんだけど、どこに行ったらいいと思う？",
  "渋谷で夜デートするんだけど、いい感じのプラン考えて",
  "終電逃した…どうやって帰れる？",
  "東京初めてなんだけど、1日で回れる観光スポット教えて",
];

const newId = () => Math.random().toString(36).slice(2);

export default function Page() {
  // セッションIDはページを開くたびに新しく振る＝リロードで会話がリセットされる。
  // サーバ側の履歴は Supabase に残るので、後からログとして読める。
  const [sessionId] = useState(newId);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const [places, setPlaces] = useState<Place[]>([]);
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [itinerary, setItinerary] = useState<Itinerary | null>(null);
  const [location, setLocation] = useState<LatLng | null>(null);
  const [locLabel, setLocLabel] = useState("現在地を取得中…");
  const [weather, setWeather] = useState<string | null>(null);

  // 上下ペインの高さ配分（地図 62% を初期値に）
  const [mapRatio, setMapRatio] = useState(0.62);
  const shellRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);

  // --- 現在地 --------------------------------------------------------------
  useEffect(() => {
    if (!navigator.geolocation) {
      setLocation(TOKYO);
      setLocLabel("現在地なし（東京駅を仮の現在地に）");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocLabel("現在地: GPS");
      },
      () => {
        setLocation(TOKYO);
        setLocLabel("位置情報オフ（東京駅を仮の現在地に）");
      },
      { enableHighAccuracy: false, timeout: 6000, maximumAge: 300000 },
    );
  }, []);

  // --- 自動スクロール（ユーザーが遡っている最中は飛ばさない / roadmap §1.5-5） -----
  useEffect(() => {
    const el = logRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  // --- ペインのドラッグリサイズ ------------------------------------------------
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const shell = shellRef.current;
    if (!shell) return;
    const move = (ev: PointerEvent) => {
      const rect = shell.getBoundingClientRect();
      const r = (ev.clientY - rect.top) / rect.height;
      setMapRatio(Math.min(0.85, Math.max(0.2, r)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // --- 送信 ----------------------------------------------------------------
  const send = useCallback(
    async (text: string) => {
      const body = text.trim();
      if (!body || busy) return;
      setInput("");
      setBusy(true);
      stickBottom.current = true;
      setMessages((m) => [...m, { id: newId(), role: "user", text: body }]);

      let assistantId: string | null = null;
      const appendText = (delta: string) => {
        setMessages((m) => {
          if (assistantId && m.length && m[m.length - 1].id === assistantId) {
            const copy = [...m];
            copy[copy.length - 1] = { ...copy[copy.length - 1], text: copy[copy.length - 1].text + delta };
            return copy;
          }
          assistantId = newId();
          return [...m, { id: assistantId, role: "assistant", text: delta }];
        });
      };

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, message: body, location: location ?? TOKYO }),
        });
        if (!res.body) throw new Error("ストリームを取得できませんでした");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";

          for (const chunk of chunks) {
            const line = chunk.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const ev = JSON.parse(line.slice(6)) as StreamEvent;

            switch (ev.type) {
              case "text":
                appendText(ev.delta);
                break;
              case "tool_start":
                assistantId = null; // ツールを挟んだら次のテキストは新しい吹き出しに
                setMessages((m) => [...m, { id: newId(), role: "tool", text: ev.summary }]);
                break;
              case "places":
                setPlaces(ev.places);
                break;
              case "route":
                setRoute(ev.route);
                break;
              case "itinerary":
                setItinerary(ev.itinerary);
                break;
              case "context":
                setWeather(ev.weather);
                break;
              case "error":
                setMessages((m) => [...m, { id: newId(), role: "error", text: ev.message }]);
                break;
              case "done":
                break;
            }
          }
        }
      } catch (e) {
        setMessages((m) => [
          ...m,
          { id: newId(), role: "error", text: e instanceof Error ? e.message : String(e) },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [busy, location, sessionId],
  );

  const reset = async () => {
    await fetch(`/api/chat?session_id=${sessionId}`, { method: "DELETE" });
    setMessages([]);
    setPlaces([]);
    setRoute(null);
    setItinerary(null);
  };

  const itinItems = itinerary?.days.flatMap((d) => d.items) ?? [];

  return (
    <div className="shell" ref={shellRef}>
      {/* ───── 上：地図 ───── */}
      <div className="map-pane" style={{ flexBasis: `${mapRatio * 100}%` }}>
        <MapPane
          places={places}
          route={route}
          itinerary={itinerary}
          location={location}
          onPickPlace={(p) => setInput(`「${p.name}」について教えて`)}
        />
        <div className="map-overlay">
          <span className="chip">{locLabel}</span>
          {weather && <span className="chip">天気: {weather}</span>}
          {places.length > 0 && <span className="chip accent">検索結果 {places.length}件</span>}
          {route && (
            <span className="chip accent">
              {{ walk: "徒歩", transit: "電車", taxi: "タクシー", car: "車" }[route.mode]}{" "}
              {(route.distance_m / 1000).toFixed(1)}km / 約{Math.round(route.duration_s / 60)}分
              {route.estimated_fare_jpy !== null && ` / 約${route.estimated_fare_jpy.toLocaleString()}円`}
            </span>
          )}
          {route?.elevation_gain_m != null && (
            <span className="chip warn">累積標高 +{route.elevation_gain_m}m</span>
          )}
        </div>
      </div>

      {/* ───── 仕切り（ドラッグで高さ配分を変更） ───── */}
      <div className="resizer" onPointerDown={startDrag} title="ドラッグで地図とチャットの比率を変える" />

      {/* ───── 下：会話 ───── */}
      <div className="chat-pane">
        <div className="chat-head">
          <strong>旅のプランナー</strong>
          <span>Claude Opus 5 × オープンデータ</span>
          <button onClick={reset} disabled={busy}>
            会話をリセット
          </button>
        </div>

        <div className="chat-log" ref={logRef} onScroll={onLogScroll}>
          {messages.length === 0 && (
            <div className="bubble assistant">
              東京のおでかけプランを一緒に考えます。行きたいものや今の状況を話しかけてください。
              検索結果とルートは上の地図に出ます。
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`bubble ${m.role}`}>
              {m.text}
            </div>
          ))}
          {busy && <div className="bubble tool dots">考え中</div>}
        </div>

        {itinItems.length > 0 && (
          <div className="itin-strip">
            {itinItems.map((it, i) => (
              <div className="itin-card" key={`${it.place_id}-${i}`}>
                <div>
                  <span className="n">{i + 1}</span>
                  {it.name}
                </div>
                <div className="t">
                  {[it.start_time, it.duration_min ? `${it.duration_min}分` : null, it.note]
                    .filter(Boolean)
                    .join(" / ")}
                </div>
              </div>
            ))}
          </div>
        )}

        {messages.length === 0 && (
          <div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(input);
              }
            }}
            placeholder="例: この辺で夜まで open のカフェある？（Enterで送信 / Shift+Enterで改行）"
            rows={1}
          />
          <button type="submit" disabled={busy || !input.trim()}>
            送信
          </button>
        </form>
      </div>
    </div>
  );
}
