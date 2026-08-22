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

/**
 * 最初に押されるボタン＝実質このアプリの説明。
 * 「地図アプリでも答えられる質問」を並べても意味がないので、
 * 都・区のオープンデータが無いと答えられない質問だけを置いている。
 */
const SUGGESTIONS = [
  "車椅子の母と浅草を回りたい。段差の少ないルートで",
  "ベビーカーで上野。おむつ替えできるトイレの場所も教えて",
  "坂がきつくない散歩コースある？",
  "終電逃した…どうやって帰れる？",
];

const newId = () => Math.random().toString(36).slice(2);

const fmtDistance = (m: number) => (m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`);

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

  // 地図のピンと候補パネルで共有する選択状態
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 候補パネルは地図の上に浮かせる。閉じるとタブだけが残る。
  const [listOpen, setListOpen] = useState(true);

  // 上下ペインの高さ配分（地図 62% を初期値に）
  const [mapRatio, setMapRatio] = useState(0.62);
  const shellRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const stickBottom = useRef(true);

  const panelShown = listOpen && places.length > 0;

  // パネルは地図に被さるので、その幅ぶんだけ fitBounds の右余白を広げて
  // ピンがパネルの裏に隠れないようにする（実寸を測るので CSS 側と二重管理しない）。
  const [padRight, setPadRight] = useState(40);
  useEffect(() => {
    const el = panelRef.current;
    if (!el) {
      setPadRight(40);
      return;
    }
    const ro = new ResizeObserver(() => setPadRight(Math.round(el.getBoundingClientRect().width) + 24));
    ro.observe(el);
    return () => ro.disconnect();
  }, [panelShown]);

  // ピンをクリックしたらリスト側もその場所までスクロールする
  useEffect(() => {
    if (!selectedId || !listRef.current) return;
    listRef.current
      .querySelector(`[data-pid="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId]);

  // MapPane 側の初期化 effect が握る参照なので、識別子を安定させる
  const onSelect = useCallback((id: string | null) => setSelectedId(id), []);

  // --- 現在地 --------------------------------------------------------------
  // 取れなければ黙って東京駅にフォールバックする（画面には出さず、必要なら会話で触れる）
  useEffect(() => {
    if (!navigator.geolocation) {
      setLocation(TOKYO);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setLocation(TOKYO),
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
                setSelectedId(null);
                setListOpen(true); // 新しい検索結果が来たらパネルを開き直す
                break;
              case "route":
                setRoute(ev.route);
                break;
              case "itinerary":
                setItinerary(ev.itinerary);
                break;
              case "context":
                // 天気・現在地はモデル側の文脈にだけ効かせる（画面には出さない）
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
    setSelectedId(null);
  };

  const itinItems = itinerary?.days.flatMap((d) => d.items) ?? [];

  return (
    <div className="shell" ref={shellRef}>
      {/* ───── 上：地図（全面）＋ 上に浮く候補パネル ───── */}
      <div className="map-pane" style={{ flexBasis: `${mapRatio * 100}%` }}>
        <MapPane
          places={places}
          route={route}
          itinerary={itinerary}
          location={location}
          selectedId={selectedId}
          onSelect={onSelect}
          padRight={panelShown ? padRight : 40}
        />

        {/* 残すのはルート要約だけ。天気・現在地・件数・累積標高は会話側に任せる。 */}
        {route && (
          <div className="map-overlay">
            <span className="chip accent">
              {{ walk: "徒歩", transit: "電車", taxi: "タクシー", car: "車" }[route.mode]}{" "}
              {(route.distance_m / 1000).toFixed(1)}km / 約{Math.round(route.duration_s / 60)}分
              {route.estimated_fare_jpy !== null && ` / 約${route.estimated_fare_jpy.toLocaleString()}円`}
            </span>
          </div>
        )}

        {places.length > 0 &&
          (listOpen ? (
            <aside className="place-panel" ref={panelRef} aria-label="検索結果">
              <div className="pp-head">
                <span>おすすめ {places.length}件</span>
                <button
                  type="button"
                  className="pp-close"
                  onClick={() => setListOpen(false)}
                  aria-label="候補リストを閉じる"
                  title="閉じる"
                >
                  ×
                </button>
              </div>
              <div className="pp-body" ref={listRef}>
                {places.map((p, i) => (
                  <div
                    key={p.place_id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={p.place_id === selectedId}
                    data-pid={p.place_id}
                    className={`place-card${p.place_id === selectedId ? " selected" : ""}`}
                    onClick={() => setSelectedId(p.place_id === selectedId ? null : p.place_id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedId(p.place_id === selectedId ? null : p.place_id);
                      }
                    }}
                  >
                    <div className="pc-top">
                      <span className="pc-rank">{i + 1}</span>
                      <span className="pc-name">{p.name}</span>
                    </div>
                    <div className="pc-meta">
                      {p.category}
                      {p.distance_m !== null && ` ・ ${fmtDistance(p.distance_m)}`}
                      {p.is_open_now === true && <span className="pc-open">営業中</span>}
                      {p.is_open_now === false && <span className="pc-closed">営業時間外</span>}
                    </div>
                    {p.address && <div className="pc-meta">{p.address}</div>}
                    {p.description && <div className="pc-desc">{p.description}</div>}
                    <button
                      type="button"
                      className="pc-ask"
                      onClick={(e) => {
                        e.stopPropagation();
                        setInput(`「${p.name}」について教えて`);
                      }}
                    >
                      詳しく聞く
                    </button>
                  </div>
                ))}
              </div>
            </aside>
          ) : (
            <button type="button" className="place-tab" onClick={() => setListOpen(true)}>
              候補 {places.length}件
            </button>
          ))}
      </div>

      {/* ───── 仕切り（ドラッグで高さ配分を変更） ───── */}
      <div className="resizer" onPointerDown={startDrag} title="ドラッグで地図とチャットの比率を変える" />

      {/* ───── 下：会話 ───── */}
      <div className="chat-pane">
        <div className="chat-log" ref={logRef} onScroll={onLogScroll}>
          {messages.length === 0 && (
            <div className="bubble assistant">
              東京のおでかけプランを一緒に考えます。行きたいものや今の状況を話しかけてください。
              検索結果とルートは上の地図に出ます。
              <br />
              東京都・区市町村のオープンデータと OpenStreetMap
              から、段差・多目的トイレ・授乳室・坂の勾配まで含めて調べられます。
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
          {/* ヘッダーを畳んだので、リセットはここに small button として残す */}
          <button
            type="button"
            className="reset-btn"
            onClick={reset}
            disabled={busy}
            title="会話をリセット"
            aria-label="会話をリセット"
          >
            ↺
          </button>
        </form>
      </div>
    </div>
  );
}
