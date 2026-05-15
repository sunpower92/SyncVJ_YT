// ----------------------------------------------------------------------
// VJ AutoSync Controller (React VJ App)
// 現場の音声をマイクで取得し、YouTube動画の再生位置を自動同期するシステム。
// 横幅のレスポンシブ（Flexbox/Grid）に対応し、縦方向は自然にスクロールします。
// ----------------------------------------------------------------------

import React, { useEffect, useRef, useState } from "react";

export default function VJSyncApp() {
  // =========================================================
  // 1. 各種リファレンス (DOM操作や外部API制御用)
  // =========================================================
  const playerRef = useRef(null);         // メインプレイヤーをマウントするDOMの参照
  const ytPlayer = useRef(null);          // YouTube IFrame APIのインスタンス保持
  const syncIntervalRef = useRef(null);   // OBSウィンドウとの強制同期用インターバル(監視ループ)
  const popWinRef = useRef(null);         // 開いたOBS用ポップアウトウィンドウの参照

  // =========================================================
  // 2. 設定関連のステート (localStorageと連動)
  // =========================================================
  // 音声認識エンジンの切り替え（デフォルトはアニメ/日本曲に強いACRCloud）
  const [engine, setEngine] = useState(() => localStorage.getItem("vjsync_engine") || "acrcloud");
  
  // 検索クエリに「official video」を付与するかどうか（VJでは公式MVを出したいため）
  const [appendOfficial, setAppendOfficial] = useState(() => {
    const val = localStorage.getItem("vjsync_append_official");
    return val !== null ? val === "true" : true;
  });
  
  // OBS用の再生画質（VJ用途のため基本は1080p）
  const [quality, setQuality] = useState(() => localStorage.getItem("vjsync_quality") || "hd1080");
  const qualityRef = useRef(quality); // YouTube APIのイベント内で最新の画質を参照するためのRef

  // 各APIキー
  const [acrHost, setAcrHost] = useState(() => localStorage.getItem("vjsync_acr_host") || "");
  const [acrAccessKey, setAcrAccessKey] = useState(() => localStorage.getItem("vjsync_acr_key") || "");
  const [acrAccessSecret, setAcrAccessSecret] = useState(() => localStorage.getItem("vjsync_acr_secret") || "");
  const [auddToken, setAuddToken] = useState(() => localStorage.getItem("vjsync_audd") || "");
  const [youtubeKey, setYoutubeKey] = useState(() => localStorage.getItem("vjsync_yt") || "");
  
  // 設定画面の表示切り替えフラグ
  const [showSettings, setShowSettings] = useState(false);

  // =========================================================
  // 3. プレイヤー状態とUIのステート
  // =========================================================
  const [status, setStatus] = useState("Ready"); // 画面右上に表示するシステムステータス
  const [rate, setRate] = useState(1.0);         // 再生速度 (PITCH制御用)
  const [videoId, setVideoId] = useState("");    // 現在再生中のYouTube動画ID
  
  const [isListening, setIsListening] = useState(false); // マイク録音中かどうかのフラグ
  const [candidates, setCandidates] = useState([]);      // YouTube検索結果のリスト
  const [searchQuery, setSearchQuery] = useState("");    // 手動検索用のキーワード
  
  // 認識した楽曲の「基準位置」と「録音開始時刻」を保持する重要なオブジェクト
  // これにより「経過時間で即座にSYNC」が可能になります。
  const [syncData, setSyncData] = useState(null);

  // 録音のタイミングやAPIの仕様による「ズレ」を補正する値（デフォルト 0.0秒）
  // 認識した秒数にこの値を足してジャンプします（動画が早い場合はマイナスを指定）
  const [syncOffset, setSyncOffset] = useState(() => {
    const val = localStorage.getItem("vjsync_offset");
    return val !== null ? parseFloat(val) : 0.0;
  });

  // ログとステータスを同時に更新するヘルパー関数
  const addLog = (msg) => {
    console.log(msg);
    setStatus(msg);
  };

  // 画質設定が変更されたらRefを更新 (PlayerのStateChangeイベント内で確実に最新値を読ませるため)
  useEffect(() => {
    qualityRef.current = quality;
  }, [quality]);

  // 設定パネルの入力値をまとめてlocalStorageに保存
  const saveSettings = () => {
    localStorage.setItem("vjsync_engine", engine);
    localStorage.setItem("vjsync_append_official", appendOfficial.toString());
    localStorage.setItem("vjsync_acr_host", acrHost.trim());
    localStorage.setItem("vjsync_acr_key", acrAccessKey.trim());
    localStorage.setItem("vjsync_acr_secret", acrAccessSecret.trim());
    localStorage.setItem("vjsync_audd", auddToken.trim());
    localStorage.setItem("vjsync_yt", youtubeKey.trim());
    addLog("✅ 設定を保存しました。");
    setShowSettings(false);
  };

  // オフセット値（同期ズレ補正）を変更・保存する処理
  const handleOffsetChange = (val) => {
    setSyncOffset(val);
    localStorage.setItem("vjsync_offset", val.toString());
  };

  // 画質設定を即座に適用する関数 (ロード中の動画にも再適用)
  const applyQuality = (q) => {
    setQuality(q);
    localStorage.setItem("vjsync_quality", q);
    if (videoId) {
      if (ytPlayer.current) {
        const t = ytPlayer.current.getCurrentTime?.() || 0;
        ytPlayer.current.loadVideoById({ videoId: videoId, startSeconds: t, suggestedQuality: q });
      }
      if (popWinRef.current && !popWinRef.current.closed && popWinRef.current.popYT) {
        const t = popWinRef.current.popYT.getCurrentTime?.() || 0;
        popWinRef.current.popYT.loadVideoById({ videoId: videoId, startSeconds: t, suggestedQuality: q });
      }
    }
    addLog(`画質設定を ${q} に変更しました`);
  };

  // =========================================================
  // 4. YouTube Playerの初期化処理
  // =========================================================
  useEffect(() => {
    // 既にAPIがロードされているか確認、なければscriptタグを追加してロード
    if (window.YT && window.YT.Player) {
      initPlayer();
    } else {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.body.appendChild(tag);
      const prevCallback = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (prevCallback) prevCallback();
        initPlayer();
      };
    }

    function initPlayer() {
      if (ytPlayer.current) return;
      // VJ操作用のメインプレイヤーをマウント (UI表示あり・PCローカル操作用)
      ytPlayer.current = new window.YT.Player(playerRef.current, {
        height: "100%", width: "100%", videoId: "",
        playerVars: { 
          autoplay: 0, 
          controls: 1,         // 標準UIを表示 (シークなど直感操作のため)
          disablekb: 1,        // キーボード操作を無効化（誤爆防止）
          rel: 0,              // 関連動画を非表示
          iv_load_policy: 3,   // アノテーション非表示
          modestbranding: 1    // YouTubeロゴを最小化
        },
        events: { 
          onReady: () => addLog("System Ready. 設定からAPIキーを入力してください。"),
          onStateChange: (e) => {
            // 再生開始時(PLAYING)に、常に指定した画質を強制適用する
            if (e.data === window.YT.PlayerState.PLAYING) {
              e.target.setPlaybackQuality(qualityRef.current);
            }
          }
        }
      });
    }

    // クリーンアップ処理 (コンポーネントのアンマウント時にOBSウィンドウや監視ループを閉じる)
    return () => {
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
      if (ytPlayer.current) { ytPlayer.current.destroy(); ytPlayer.current = null; }
      if (popWinRef.current && !popWinRef.current.closed) popWinRef.current.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // =========================================================
  // 5. ACRCloud / AudD 共通ユーティリティ関数
  // =========================================================
  
  // ACRCloud認証用の署名(Signature)生成処理 (HMAC-SHA1を利用)
  const generateAcrSignature = async (stringToSign, secret) => {
    const enc = new TextEncoder();
    const key = await window.crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: { name: "SHA-1" } }, false, ["sign"]);
    const signatureBuffer = await window.crypto.subtle.sign("HMAC", key, enc.encode(stringToSign));
    return btoa(String.fromCharCode(...new Uint8Array(signatureBuffer))); // Base64エンコードして返す
  };

  // ACRCloudへ送信するFormDataの構築 (署名生成やタイムスタンプの付与)
  const getAcrFormData = async (audioBlob, mimeType) => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const stringToSign = ["POST", "/v1/identify", acrAccessKey.trim(), "audio", "1", timestamp].join("\n");
    const signature = await generateAcrSignature(stringToSign, acrAccessSecret.trim());
    
    // WebM, MP4, OGGなどブラウザが録音した形式に合わせる
    let extension = "webm";
    if (mimeType.includes("mp4")) extension = "m4a";
    if (mimeType.includes("ogg")) extension = "ogg";
    
    const formData = new FormData();
    formData.append("sample", audioBlob, `record.${extension}`);
    formData.append("access_key", acrAccessKey.trim());
    formData.append("data_type", "audio");
    formData.append("signature_version", "1");
    formData.append("signature", signature);
    formData.append("sample_bytes", audioBlob.size.toString());
    formData.append("timestamp", timestamp);
    return formData;
  };

  // AudDから返ってくるタイムコード（例: "01:23" または "01:02:03"）を秒数に変換
  const parseAudDTimecode = (tc) => {
    if (!tc) return 0;
    const parts = tc.split(":");
    if (parts.length === 2) return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    if (parts.length === 3) return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
    return 0;
  };

  // =========================================================
  // 6. 録音 ＆ 曲名特定処理 (最初の「認識」ボタン)
  // =========================================================
  const startListening = async () => {
    if (isListening) return;
    
    // 設定不備のチェック
    if (engine === "acrcloud" && (!acrHost || !acrAccessKey || !acrAccessSecret || !youtubeKey)) {
      addLog("⚠️ 右上の「⚙️設定」から ACRCloud と YouTube の情報を入力してください！");
      setShowSettings(true); return;
    } else if (engine === "audd" && (!auddToken || !youtubeKey)) {
      addLog("⚠️ 右上の「⚙️設定」から AudD トークン と YouTube キー を入力してください！");
      setShowSettings(true); return;
    }

    setIsListening(true);
    addLog(`🎙️ マイクへのアクセスを準備中... (${engine.toUpperCase()})`);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const mimeType = recorder.mimeType;
      const audioChunks = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data); // 音声チャンクを配列に保存
      };

      const recordStartTime = Date.now(); // ★ 同期の基準となる録音開始時刻

      recorder.onstop = async () => {
        addLog(`🎧 録音完了！${engine.toUpperCase()}で解析中...`);
        const audioBlob = new Blob(audioChunks, { type: mimeType });
        stream.getTracks().forEach(track => track.stop()); // マイクの解放

        // 選択されたエンジンで解析実行
        if (engine === "acrcloud") {
          await recognizeAudioWithACRCloud(audioBlob, mimeType, recordStartTime);
        } else {
          await recognizeAudioWithAudD(audioBlob, mimeType, recordStartTime);
        }
      };

      recorder.start();
      addLog("🔴 フロアの音を録音中（5秒間）...");
      
      // 5秒間録音したのち自動停止
      setTimeout(() => { if (recorder.state !== "inactive") recorder.stop(); }, 5000);

    } catch (err) {
      console.error(err);
      addLog("❌ マイクエラーが発生しました。マイクの権限を許可してください。");
      setIsListening(false);
    }
  };

  // ACRCloudによる解析
  const recognizeAudioWithACRCloud = async (audioBlob, mimeType, recordStartTime) => {
    try {
      if (audioBlob.size === 0) { addLog("❌ 録音データが空です。"); setIsListening(false); return; }

      const formData = await getAcrFormData(audioBlob, mimeType);
      let cleanHost = acrHost.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
      
      const response = await fetch(`https://${cleanHost}/v1/identify`, { method: "POST", body: formData });
      const data = await response.json();
      
      if (data.status && data.status.code === 0 && data.metadata && data.metadata.music && data.metadata.music.length > 0) {
        const musicInfo = data.metadata.music[0];
        const title = musicInfo.title;
        const artist = musicInfo.artists ? musicInfo.artists[0].name : "";
        const offsetMs = musicInfo.play_offset_ms || 0; // 曲の再生位置（ミリ秒）
        
        // 取得した基準位置をStateに保存（SYNC機能で利用）
        setSyncData({ baseOffsetSec: offsetMs / 1000, recordStartTime: recordStartTime });
        addLog(`✅ 曲を認識: ${artist} - ${title} (現在 ${Math.floor(offsetMs/1000)}秒目)`);
        
        // MVを優先して検索するためにofficial videoキーワードを追加
        const query = appendOfficial ? `${artist} ${title} official video` : `${artist} ${title}`;
        setSearchQuery(query);
        await searchYouTube(query);
      } else {
        addLog(`❌ 認識失敗: ${data.status?.msg}`);
        setIsListening(false);
      }
    } catch (err) {
      addLog("❌ ACRCloudエラーが発生しました。"); setIsListening(false);
    }
  };

  // AudDによる解析
  const recognizeAudioWithAudD = async (audioBlob, mimeType, recordStartTime) => {
    try {
      if (audioBlob.size === 0) { addLog("❌ 録音データが空です。"); setIsListening(false); return; }

      const formData = new FormData();
      formData.append("api_token", auddToken.trim());
      let extension = "webm";
      if (mimeType.includes("mp4")) extension = "m4a";
      if (mimeType.includes("ogg")) extension = "ogg";
      formData.append("file", audioBlob, `record.${extension}`);
      formData.append("return", "timecode");

      const response = await fetch("https://api.audd.io/", { method: "POST", body: formData });
      const data = await response.json();
      
      if (data.status === "success" && data.result) {
        const title = data.result.title;
        const artist = data.result.artist;
        const offsetSec = data.result.timecode ? parseAudDTimecode(data.result.timecode) : 0;
        
        // 取得した基準位置をStateに保存（SYNC機能で利用）
        setSyncData({ baseOffsetSec: offsetSec, recordStartTime: recordStartTime });
        addLog(`✅ 曲を認識: ${artist} - ${title} (現在 ${offsetSec}秒目)`);
        
        const query = appendOfficial ? `${artist} ${title} official video` : `${artist} ${title}`;
        setSearchQuery(query);
        await searchYouTube(query);
      } else {
        addLog(`❌ AudD 認識失敗: ${data.error?.error_message}`);
        setIsListening(false);
      }
    } catch (err) {
      addLog("❌ AudD通信エラーが発生しました。"); setIsListening(false);
    }
  };

  // =========================================================
  // 7. 現在位置の再解析 ＆ ジャンプ (Resync機能)
  // 再生がズレた際、もう一度マイクで5秒聞いて「現在の正確な位置」を取り直します
  // =========================================================
  const resyncToFloor = async () => {
    if (isListening) return;
    if (engine === "acrcloud" && !acrHost) return addLog("⚠️ ACRCloud設定がありません");
    if (engine === "audd" && !auddToken) return addLog("⚠️ AudD設定がありません");

    setIsListening(true);
    addLog(`🎙️ 現在位置を再取得中（5秒間 / ${engine.toUpperCase()}）...`);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const mimeType = recorder.mimeType;
      const audioChunks = [];

      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };

      const recordStartTime = Date.now();

      recorder.onstop = async () => {
        addLog("🎧 現在位置を計算中...");
        const audioBlob = new Blob(audioChunks, { type: mimeType });
        stream.getTracks().forEach(track => track.stop());

        // 解析後、直接ジャンプする処理を呼び出す
        if (engine === "acrcloud") {
          await calculateNewOffsetACR(audioBlob, mimeType, recordStartTime);
        } else {
          await calculateNewOffsetAudD(audioBlob, mimeType, recordStartTime);
        }
      };

      recorder.start();
      setTimeout(() => { if (recorder.state !== "inactive") recorder.stop(); }, 5000);

    } catch (err) {
      addLog("❌ マイクエラーが発生しました。"); setIsListening(false);
    }
  };

  // 万が一「再解析」が失敗した場合（無音やノイズなど）、
  // 以前の解析結果（syncData）からの経過時間を計算して推測位置に強制ジャンプします
  const fallbackToEstimatedSync = (errorMsg) => {
    if (!syncData || !ytPlayer.current) {
        addLog(`❌ 再取得失敗: ${errorMsg}`);
        return;
    }
    const elapsed = (Date.now() - syncData.recordStartTime) / 1000;
    const targetTime = syncData.baseOffsetSec + elapsed + syncOffset; // ★補正値を加算
    ytPlayer.current.seekTo(targetTime, true);
    if (popWinRef.current && !popWinRef.current.closed && popWinRef.current.popYT) {
      popWinRef.current.popYT.seekTo(targetTime, true);
    }
    addLog(`⚠️ 再解析失敗(${errorMsg})。推測位置へジャンプ！(補正: ${syncOffset}s)`);
  };

  const calculateNewOffsetACR = async (audioBlob, mimeType, recordStartTime) => {
    try {
      if (audioBlob.size === 0) { setIsListening(false); return; }
      const formData = await getAcrFormData(audioBlob, mimeType);
      let cleanHost = acrHost.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
      const response = await fetch(`https://${cleanHost}/v1/identify`, { method: "POST", body: formData });
      const data = await response.json();
      
      if (data.status && data.status.code === 0 && data.metadata && data.metadata.music && data.metadata.music.length > 0) {
        const offsetMs = data.metadata.music[0].play_offset_ms || 0;
        const baseOffsetSec = offsetMs / 1000;
        
        // 取得成功したら基準値を更新し、ジャンプ実行
        setSyncData({ baseOffsetSec: baseOffsetSec, recordStartTime: recordStartTime });
        jumpToSync(baseOffsetSec, recordStartTime);
      } else {
        fallbackToEstimatedSync(data.status?.msg || "No result");
      }
    } catch (err) {
      fallbackToEstimatedSync("ACRCloud通信エラー");
    } finally {
      setIsListening(false);
    }
  };

  const calculateNewOffsetAudD = async (audioBlob, mimeType, recordStartTime) => {
    try {
      if (audioBlob.size === 0) { setIsListening(false); return; }
      const formData = new FormData();
      formData.append("api_token", auddToken.trim());
      let extension = "webm";
      if (mimeType.includes("mp4")) extension = "m4a";
      if (mimeType.includes("ogg")) extension = "ogg";
      formData.append("file", audioBlob, `record.${extension}`);
      formData.append("return", "timecode");

      const response = await fetch("https://api.audd.io/", { method: "POST", body: formData });
      const data = await response.json();
      
      if (data.status === "success" && data.result) {
        const offsetSec = data.result.timecode ? parseAudDTimecode(data.result.timecode) : 0;
        setSyncData({ baseOffsetSec: offsetSec, recordStartTime: recordStartTime });
        jumpToSync(offsetSec, recordStartTime);
      } else {
        fallbackToEstimatedSync(data.error?.error_message || "No result");
      }
    } catch (err) {
      fallbackToEstimatedSync("AudD通信エラー");
    } finally {
      setIsListening(false);
    }
  };

  // 再解析によって得られた最新の基準位置から、録音にかかった時間を足してジャンプ
  const jumpToSync = (baseOffsetSec, recordStartTime) => {
    if (ytPlayer.current) {
      const elapsedSinceRecord = (Date.now() - recordStartTime) / 1000;
      const targetTime = baseOffsetSec + elapsedSinceRecord + syncOffset; // ★補正値を加算
      
      ytPlayer.current.seekTo(targetTime, true);
      if (popWinRef.current && !popWinRef.current.closed && popWinRef.current.popYT) {
        popWinRef.current.popYT.seekTo(targetTime, true);
      }
      addLog(`⚡ 再取得完了！ ${targetTime.toFixed(1)}秒へジャンプ！(補正: ${syncOffset}s)`);
    }
  };

  // =========================================================
  // 8. その他の処理 (YouTube検索, VJコントロール類, OBS Popout)
  // =========================================================
  
  // YouTube Data API を用いて動画を検索
  const searchYouTube = async (query) => {
    addLog(`🔍 YouTube検索: ${query}`);
    try {
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=5&key=${youtubeKey}`;
      const res = await fetch(url);
      const data = await res.json();
      
      if (data.items) {
        const results = data.items.map(item => ({
          id: item.id.videoId,
          title: item.snippet.title,
          thumb: item.snippet.thumbnails.medium.url
        }));
        setCandidates(results); // 再生候補リストを更新
        addLog("✅ 候補を取得しました。");
      }
    } catch (err) {
      addLog("❌ YouTube検索エラー");
    } finally {
      setIsListening(false);
    }
  };

  // 手動でキーワード入力して検索ボタンを押した時の処理
  const handleManualSearch = () => {
    if (!searchQuery) return;
    if (!youtubeKey) {
      addLog("⚠️ 検索の前にYouTube APIキーを設定してください！");
      setShowSettings(true); return;
    }
    setIsListening(true);
    searchYouTube(searchQuery);
  };

  // 再生候補から特定の動画をクリックしたときの処理
  const selectVideo = (id) => {
    setVideoId(id);
    // メインプレイヤーに読み込み
    if (ytPlayer.current) {
      ytPlayer.current.loadVideoById({ videoId: id, suggestedQuality: quality });
    }
    // OBSポップアウトが開いていればそちらにも読み込み
    if (popWinRef.current && !popWinRef.current.closed && popWinRef.current.popYT) {
      popWinRef.current.popYT.loadVideoById({ videoId: id, suggestedQuality: quality });
    }
    addLog(`🎬 動画を読み込みました。`);
  };

  // 再生速度の適用 (Pitch調整)
  const applyRate = (v) => {
    const r = Math.max(0.25, Math.min(2.0, v)); // YouTubeの制限 (0.25〜2.0) 内に収める
    setRate(r);
    ytPlayer.current?.setPlaybackRate(r);
    if (popWinRef.current && !popWinRef.current.closed && popWinRef.current.popYT) {
        popWinRef.current.popYT.setPlaybackRate(r);
    }
  };

  // NUDGE機能 (DJのジョグダイヤルのように、少しだけ再生位置を前後にズラす)
  const nudgeTime = (seconds) => {
    if (!ytPlayer.current) return;
    const newTime = ytPlayer.current.getCurrentTime() + seconds;
    ytPlayer.current.seekTo(newTime, true);
    if (popWinRef.current && !popWinRef.current.closed && popWinRef.current.popYT) {
       popWinRef.current.popYT.seekTo(newTime, true);
    }
    addLog(`位置を微調整: ${seconds > 0 ? '+' : ''}${seconds}秒`);
  };

  // ピッチベンド開始 (ボタン長押し時。一時的に再生速度を速める/遅くする)
  const startBend = (direction) => {
    if (!ytPlayer.current) return;
    const targetRate = Math.max(0.25, Math.min(2.0, rate + (direction === '+' ? 0.15 : -0.15)));
    ytPlayer.current.setPlaybackRate(targetRate);
    if (popWinRef.current && !popWinRef.current.closed && popWinRef.current.popYT) popWinRef.current.popYT.setPlaybackRate(targetRate);
    setStatus(`Bending... (${targetRate.toFixed(2)}x)`);
  };

  // ピッチベンド終了 (指を離した時。元の速度に戻す)
  const stopBend = () => {
    if (!ytPlayer.current) return;
    ytPlayer.current.setPlaybackRate(rate);
    if (popWinRef.current && !popWinRef.current.closed && popWinRef.current.popYT) popWinRef.current.popYT.setPlaybackRate(rate);
    setStatus(`速度を ${rate.toFixed(2)}x に戻しました`);
  };

  // 「経過時間で即座にSYNC」機能。
  // 一番最後に解析した基準点から、現在の時間を逆算してノータイムでジャンプします。
  const syncToFloor = () => {
    if (!syncData || !ytPlayer.current) return;
    const elapsed = (Date.now() - syncData.recordStartTime) / 1000;
    const targetTime = syncData.baseOffsetSec + elapsed + syncOffset; // ★補正値を加算
    
    ytPlayer.current.seekTo(targetTime, true);
    if (popWinRef.current && !popWinRef.current.closed && popWinRef.current.popYT) popWinRef.current.popYT.seekTo(targetTime, true);
    addLog(`⚡ 推測位置 (${targetTime.toFixed(1)}秒) へジャンプ！(補正: ${syncOffset}s)`);
  };

  // OBSで取り込むための「UI完全非表示のポップアウトウィンドウ」を開く
  const openPopout = () => {
    const id = videoId || (ytPlayer.current?.getVideoData ? ytPlayer.current.getVideoData().video_id : null);
    if (!id) return addLog("先に動画を読み込んでください！");

    if (popWinRef.current && !popWinRef.current.closed) popWinRef.current.close();
    // ツールバー等がないシンプルなウィンドウを開く
    const win = window.open("", "pop", "width=1280,height=720,menubar=no,toolbar=no,location=no,status=no");
    popWinRef.current = win;

    // ウィンドウ内にHTMLを直接書き込んでYouTubeプレイヤーを初期化する
    win.document.open();
    win.document.write(`
      <!DOCTYPE html>
      <html>
      <head><style>body { margin: 0; background: black; overflow: hidden; } #player { width: 100vw; height: 100vh; border: none; pointer-events: none; }</style></head>
      <body>
        <div id="player"></div>
        <script src="https://www.youtube.com/iframe_api"></script>
        <script>
          let player;
          function onYouTubeIframeAPIReady() {
            player = new YT.Player('player', {
              height: '100%', width: '100%', videoId: '${id}',
              playerVars: { 
                autoplay: 1, 
                controls: 0,       // OBS用はコントロール一切なし
                mute: 1,           // 初回自動再生ブロックを避けるためミュート
                disablekb: 1,
                rel: 0,
                iv_load_policy: 3,
                modestbranding: 1
              },
              events: { 
                // OBS側のプレイヤーの準備ができたら、メインウィンドウの変数(popYT)に登録
                onReady: () => { window.popYT = player; },
                // 画質の強制適用
                onStateChange: (e) => {
                  if (e.data === 1) e.target.setPlaybackQuality('${qualityRef.current}');
                }
              }
            });
          }
        </script>
      </body>
      </html>
    `);
    win.document.close();

    // メインプレイヤーとOBS側のプレイヤーがズレないよう、0.5秒おきに強制監視・補正するループ
    if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    syncIntervalRef.current = setInterval(() => {
      try {
        if (win.closed) { clearInterval(syncIntervalRef.current); return; }
        const main = ytPlayer.current; const pop = win.popYT;
        if (!main || !pop || typeof pop.getCurrentTime !== "function") return;
        
        const mainState = main.getPlayerState?.(); const popState = pop.getPlayerState?.();
        
        // 再生・一時停止のステータス同期
        if (mainState === 1 && popState !== 1) pop.playVideo();
        else if (mainState === 2 && popState !== 2) pop.pauseVideo();
        
        // 再生位置が2秒以上ズレていたら、OBS側をメイン側に強制的に合わせる
        if (mainState === 1 || mainState === 2) {
          const tMain = main.getCurrentTime?.() || 0; const tPop = pop.getCurrentTime?.() || 0;
          if (Math.abs(tMain - tPop) > 2.0) pop.seekTo(tMain, true);
        }
      } catch (e) {}
    }, 500);
  };

  // =========================================================
  // Render UI (HTML構造とデザイン)
  // =========================================================
  return (
    <div className="vj-app">
      {/* 
        ★ 画面左右の白い余白を消すため、bodyタグに対して margin: 0 と 背景色を設定しています。
        横幅のレスポンシブデザインを実現するためのCSS定義。
        FlexboxやCSS Gridを利用して、画面幅が狭い場合（スマホ等）は自動で要素を縦積みにします。
        縦方向は自然にスクロールする構成（min-height: 100vh）です。
      */}
      <style>{`
        body { margin: 0; padding: 0; background: #1a1a1a; }
        .vj-app { padding: 20px; font-family: sans-serif; background: #1a1a1a; color: #eee; min-height: 100vh; box-sizing: border-box; }
        
        /* 画面上部のヘッダー行 */
        .header-row { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333; padding-bottom: 10px; flex-wrap: wrap; gap: 10px; }
        
        /* 設定パネル周りのデザイン */
        .settings-panel { background: #222; padding: 20px; margin-top: 10px; border-radius: 8px; border: 1px solid #444; }
        .settings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 15px; padding-bottom: 15px; border-bottom: 1px solid #333; }
        .keys-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 15px; }
        
        /* 左右パネルのコンテナ（flexWrap: wrap により画面幅が足りない時は右パネルが下へ落ちる） */
        .vj-container { display: flex; gap: 20px; margin-top: 20px; flex-wrap: wrap; }
        .vj-left { flex: 1 1 300px; display: flex; flex-direction: column; gap: 20px; }
        .vj-right { flex: 2 1 500px; display: flex; flex-direction: column; gap: 20px; }
        
        /* 各パネルのベースデザイン */
        .panel { background: #2a2a2a; padding: 15px; border-radius: 8px; }
        .panel-flex { display: flex; flex-direction: column; flex: 1; }
        
        /* プレイヤー周りとSYNCパネルのデザイン */
        .player-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-wrap: wrap; gap: 10px; }
        .sync-panel { background: #111; padding: 15px; border-radius: 4px; border: 1px solid #333; }
        .sync-header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
        
        /* ボタングループの並び（横幅が広い時は横並び） */
        .sync-buttons { display: flex; gap: 10px; margin-top: 10px; }
        .nudge-buttons { display: flex; gap: 5px; margin-top: 5px; }
        .pitch-buttons { display: flex; gap: 5px; margin-top: 5px; }
        
        /* 各種ボタンの基本デザイン */
        .btn { padding: 12px 15px; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; color: #fff; text-align: center; }
        .btn:disabled { cursor: not-allowed; opacity: 0.6; }
        .btn-nudge { flex: 1; padding: 15px 5px; background: #444; border: none; cursor: pointer; border-radius: 4px; color: #fff; font-size: 13px; }
        .btn-pitch { flex: 1; padding: 15px; border: none; cursor: pointer; font-weight: bold; border-radius: 4px; color: #fff; }
        
        /* 入力フォームの基本デザイン */
        .input-base { width: 100%; box-sizing: border-box; padding: 10px; background: #111; border: 1px solid #555; color: #fff; border-radius: 4px; }
        
        /* 画面幅が狭い場合（スマホやタブレットの縦持ち等）のレイアウト切り替え */
        @media (max-width: 768px) {
          .vj-app { padding: 10px; }
          .sync-buttons { flex-direction: column; } /* SYNCボタンを縦積みに */
          .nudge-buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; } /* 4つのボタンを2x2のグリッドに */
          .pitch-buttons { flex-direction: column; } /* ピッチボタンを縦積みに */
        }
      `}</style>

      {/* ＝＝＝ ヘッダーエリア ＝＝＝ */}
      <div className="header-row">
        <h2 style={{ margin: 0, color: "#00e676" }}>VJ AutoSync Controller</h2>
        
        {/* ステータス表示＆設定ボタン */}
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ background: "#333", padding: "5px 15px", borderRadius: 20, fontSize: 14 }}>{status}</span>
          <button onClick={() => setShowSettings(!showSettings)} className="btn" style={{ background: showSettings ? "#d32f2f" : "#444" }}>
            {showSettings ? "✕ 閉じる" : "⚙️ 設定"}
          </button>
        </div>
      </div>

      {/* ＝＝＝ 設定パネル (showSettingsがtrueの時のみ表示) ＝＝＝ */}
      {showSettings && (
        <div className="settings-panel">
          
          {/* 基本設定のグリッド（検索オプション・エンジン選択・画質） */}
          <div className="settings-grid">
            <div>
              <label style={{ display: "block", fontSize: 14, fontWeight: "bold", marginBottom: 5 }}>🔍 検索オプション</label>
              <label style={{ display: "flex", alignItems: "center", fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={appendOfficial} onChange={(e) => setAppendOfficial(e.target.checked)} style={{ marginRight: 10, transform: "scale(1.2)" }} />
                検索時に "official video" を自動で追加する
              </label>
            </div>
            <div>
              <label style={{ display: "block", fontSize: 14, fontWeight: "bold", marginBottom: 5 }}>🧠 音声認識エンジン</label>
              <select className="input-base" value={engine} onChange={(e) => setEngine(e.target.value)}>
                <option value="acrcloud">ACRCloud (アニソン・日本楽曲に強い)</option>
                <option value="audd">AudD (洋楽・ビルボードに強い)</option>
              </select>
            </div>
            <div>
              <label style={{ display: "block", fontSize: 14, fontWeight: "bold", marginBottom: 5 }}>📺 再生画質 (OBS用)</label>
              <select className="input-base" value={quality} onChange={(e) => applyQuality(e.target.value)}>
                <option value="hd1080">1080p (FHD - 推奨)</option>
                <option value="hd720">720p (HD)</option>
                <option value="large">480p</option>
                <option value="medium">360p</option>
                <option value="default">自動 (Auto)</option>
              </select>
            </div>
          </div>

          <h3 style={{ marginTop: 0, color: "#fff", fontSize: 14 }}>🔑 APIキー設定</h3>
          
          {/* ACRCloud選択時の入力フォーム */}
          {engine === "acrcloud" && (
            <div className="keys-grid">
              <div>
                <label style={{ display: "block", fontSize: 12, marginBottom: 5 }}>ACRCloud Host</label>
                <input type="text" className="input-base" value={acrHost} onChange={(e) => setAcrHost(e.target.value)} />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12, marginBottom: 5 }}>ACRCloud Access Key</label>
                <input type="password" className="input-base" value={acrAccessKey} onChange={(e) => setAcrAccessKey(e.target.value)} />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12, marginBottom: 5 }}>ACRCloud Access Secret</label>
                <input type="password" className="input-base" value={acrAccessSecret} onChange={(e) => setAcrAccessSecret(e.target.value)} />
              </div>
            </div>
          )}

          {/* AudD選択時の入力フォーム */}
          {engine === "audd" && (
            <div className="keys-grid">
              <div>
                <label style={{ display: "block", fontSize: 12, marginBottom: 5 }}>AudD API Token</label>
                <input type="password" className="input-base" value={auddToken} onChange={(e) => setAuddToken(e.target.value)} />
              </div>
            </div>
          )}

          {/* YouTube APIキーと保存ボタン */}
          <div className="keys-grid" style={{ marginBottom: 0 }}>
            <div>
              <label style={{ display: "block", fontSize: 12, marginBottom: 5 }}>YouTube Data API v3 Key</label>
              <input type="password" className="input-base" value={youtubeKey} onChange={(e) => setYoutubeKey(e.target.value)} />
            </div>
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <button onClick={saveSettings} className="btn" style={{ background: "#00e676", color: "#000", width: "100%" }}>設定を保存する</button>
            </div>
          </div>
        </div>
      )}

      {/* ＝＝＝ メイン UI コンテナ (左: 検索・解析 / 右: VJ操作) ＝＝＝ */}
      <div className="vj-container">
        
        {/* ==========================================================
            【左側パネル】フロアの音声認識・検索・候補リスト表示
            ========================================================== */}
        <div className="vj-left">
          
          {/* 録音＆検索セクション */}
          <div className="panel">
            <h3 style={{ marginTop: 0 }}>1. フロア音声認識</h3>
            {/* 楽曲認識ボタン（録音中は赤いボタンに切り替わり、二重クリックを防止） */}
            <button 
              onClick={startListening} disabled={isListening}
              className="btn" style={{ width: "100%", padding: 15, fontSize: 16, background: isListening ? "#d32f2f" : "#1976d2" }}>
              {isListening ? "🔴 録音＆解析中..." : `🎙️ 新しい曲を認識 (${engine.toUpperCase()})`}
            </button>
            
            {/* 手動検索フォーム */}
            <div style={{ marginTop: 15, display: "flex", gap: 5 }}>
              <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="手動で曲名を検索..." className="input-base" style={{ padding: 8 }} />
              <button onClick={handleManualSearch} disabled={isListening} className="btn" style={{ background: "#444", padding: "8px 15px" }}>検索</button>
            </div>
          </div>

          {/* 再生候補セクション (検索結果のリスト表示) */}
          <div className="panel panel-flex">
            <h3 style={{ marginTop: 0 }}>2. 再生候補</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {candidates.map(c => (
                <div key={c.id} onClick={() => selectVideo(c.id)} style={{ display: "flex", alignItems: "center", gap: 10, background: "#111", padding: 5, cursor: "pointer", border: videoId === c.id ? "2px solid #00e676" : "2px solid transparent", borderRadius: 4 }}>
                  <img src={c.thumb} alt="thumb" style={{ width: 80, height: 45, objectFit: "cover", borderRadius: 2 }} />
                  <span style={{ fontSize: 13, lineHeight: 1.2 }}>{c.title}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ==========================================================
            【右側パネル】YouTubeの表示と、VJ向けのシビアな操作群
            ========================================================== */}
        <div className="vj-right">
          
          <div className="panel panel-flex">
            
            {/* プレイヤー ヘッダー＆OBSウィンドウを開くボタン */}
            <div className="player-header">
              <h3 style={{ margin: 0 }}>3. メインプレイヤー (VJ操作)</h3>
              <button onClick={openPopout} className="btn" style={{ background: "#e65100" }}>
                🪟 OBS用ウィンドウを開く
              </button>
            </div>

            {/* YouTube 埋め込みエリア (アスペクト比16:9を維持) */}
            <div style={{ background: "#000", width: "100%", aspectRatio: "16/9", borderRadius: 8, overflow: "hidden" }}>
              <div ref={playerRef} style={{ width: "100%", height: "100%" }} />
            </div>

            {/* VJ操作 UIエリア */}
            <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 15 }}>
              
              {/* -------------------------------------------
                  🔄 SYNC操作 (フロアとの同期制御)
                  ------------------------------------------- */}
              <div className="sync-panel">
                <div className="sync-header">
                  <span style={{ fontSize: 14, color: "#00e676", fontWeight: "bold" }}>🔄 フロアに同期 (SYNC)</span>
                  
                  {/* 同期ズレ補正入力: 録音マイクの遅延やAPIの特性を補正するための重要なパラメータ */}
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ fontSize: 12, color: "#aaa" }}>同期ズレ補正:</span>
                    <input 
                      type="number" step="0.1" value={syncOffset} 
                      onChange={(e) => handleOffsetChange(parseFloat(e.target.value) || 0)} 
                      style={{ width: 60, padding: 5, background: "#222", border: "1px solid #555", color: "#fff", borderRadius: 4, textAlign: "right" }}
                    />
                    <span style={{ fontSize: 12, color: "#aaa" }}>秒</span>
                  </div>

                </div>
                <p style={{ fontSize: 12, color: "#888", margin: "5px 0" }}>再生位置が迷子になったら「再解析」を使って最新の位置を取得してください。</p>
                
                {/* SYNCアクションボタン群 */}
                <div className="sync-buttons">
                  <button 
                    onClick={syncToFloor} disabled={!syncData}
                    className="btn" style={{ flex: 1, background: syncData ? "#333" : "#222", color: syncData ? "#fff" : "#555", border: "1px solid #555" }}>
                    ⚡ 経過時間でSYNC (即時)
                  </button>
                  <button 
                    onClick={resyncToFloor} disabled={isListening}
                    className="btn" style={{ flex: 1, background: isListening ? "#d32f2f" : "#00e676", color: isListening ? "#fff" : "#000" }}>
                    {isListening ? "録音＆計算中..." : "🔄 再解析してSYNC (5秒)"}
                  </button>
                </div>
              </div>

              {/* -------------------------------------------
                  🕒 NUDGE (位置微調整) 操作
                  DJコントローラーのプラッター(ジョグ)を回すような感覚で、
                  再生位置を瞬時に前後へズラすためのボタン群
                  ------------------------------------------- */}
              <div>
                <span style={{ fontSize: 12, color: "#aaa", fontWeight: "bold" }}>🕒 位置微調整 (NUDGE)</span>
                <div className="nudge-buttons">
                  <button className="btn-nudge" onClick={() => nudgeTime(-0.5)}>&lt;&lt; 0.5秒 早い</button>
                  <button className="btn-nudge" onClick={() => nudgeTime(-0.1)}>&lt; 0.1秒 早い</button>
                  <button className="btn-nudge" onClick={() => nudgeTime(0.1)}>0.1秒 遅い &gt;</button>
                  <button className="btn-nudge" onClick={() => nudgeTime(0.5)}>0.5秒 遅い &gt;&gt;</button>
                </div>
              </div>

              {/* -------------------------------------------
                  🚀 PITCH (速度調整) 操作
                  楽曲のテンポ変化に追従するための速度スライダーと、
                  一時的に再生速度を可変させるピッチベンドボタン
                  ------------------------------------------- */}
              <div style={{ marginTop: 10 }}>
                
                {/* 現在の速度表示と、スライダーによる速度変更 */}
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12, color: "#aaa", fontWeight: "bold" }}>🚀 速度調整 (PITCH)</span>
                  <span style={{ fontSize: 14, color: "#00e676", fontWeight: "bold" }}>{rate.toFixed(2)}x</span>
                </div>
                <input type="range" min="0.5" max="1.5" step="0.01" value={rate} onChange={(e) => applyRate(parseFloat(e.target.value))} style={{ width: "100%", margin: "15px 0", cursor: "pointer" }} />
                
                {/* ピッチベンドボタン: 押している間だけ速度が変化し、離すと元に戻る */}
                <div className="pitch-buttons">
                  {/* マウスクリックおよびスマホのタッチ操作に対応させるため、onTouchイベントも併用 */}
                  <button className="btn-pitch" style={{ background: "#800000" }} onMouseDown={() => startBend('-')} onMouseUp={stopBend} onMouseLeave={stopBend} onTouchStart={() => startBend('-')} onTouchEnd={stopBend}>遅くする (HOLD)</button>
                  <button className="btn-pitch" style={{ background: "#004d00" }} onMouseDown={() => startBend('+')} onMouseUp={stopBend} onMouseLeave={stopBend} onTouchStart={() => startBend('+')} onTouchEnd={stopBend}>早くする (HOLD)</button>
                </div>
              </div>

            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
