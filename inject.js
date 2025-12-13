(function() {
    // Evita criar múltiplas instâncias
    if (window.fxVisionOverlay) {
        return;
    }

    window.fxVisionOverlay = true;

    // Carregar biblioteca Supabase se não estiver disponível
    if (typeof supabase === 'undefined') {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
        script.async = false;
        document.head.appendChild(script);
    }

       // === CONFIGURABLES (MODO DE OPERACIÓN DEL ANALIZADOR) ===
    // NO es recomendación de inversión; solo controla qué tan estricto es el filtro técnico.
   // "AGGRESSIVE" | "BALANCED" | "STRICT"

    const MODE = "AGGRESSIVE"; // prueba primero así

const MODES = {
    AGGRESSIVE: {
        MIN_PROB: 44,
        STRONG_PROB: 58,
        MIN_FREQ: 1,
        EMA_FAST: 8,
        EMA_SLOW: 34,
        MIN_SIGNAL_MS: 520,   // ~0.8s para confirmar
        STICK_MS: 1800,       // se queda pegada ~2.5s
        ALERT_GAP_MS: 5500,
        PROB_WINDOW: 4,
        VOL_WINDOW: 5,
        CONGESTION_TICKS: 2
    },
    BALANCED: {
        MIN_PROB: 50,
        STRONG_PROB: 56,
        MIN_FREQ: 2,
        EMA_FAST: 12,
        EMA_SLOW: 48,
        MIN_SIGNAL_MS: 2000,
        STICK_MS: 3500,
        ALERT_GAP_MS: 10000,
        PROB_WINDOW: 8,
        VOL_WINDOW: 10,
        CONGESTION_TICKS: 3
    },
    STRICT: {
        MIN_PROB: 55,
        STRONG_PROB: 62,
        MIN_FREQ: 3,
        EMA_FAST: 14,
        EMA_SLOW: 55,
        MIN_SIGNAL_MS: 3000,
        STICK_MS: 4000,
        ALERT_GAP_MS: 15000,
        PROB_WINDOW: 10,
        VOL_WINDOW: 12,
        CONGESTION_TICKS: 4
    }
};


    const CONF = MODES[MODE];

    const MIN_PROB = CONF.MIN_PROB;            // prob mínima para candidato
    const STRONG_PROB = CONF.STRONG_PROB;      // prob para señal fuerte
    const MIN_FREQ = CONF.MIN_FREQ;            // freq base mínima
    const EMA_FAST = CONF.EMA_FAST;
    const EMA_SLOW = CONF.EMA_SLOW;
    const MIN_SIGNAL_DURATION = CONF.MIN_SIGNAL_MS; // tiempo para confirmar señal
    const SIGNAL_STICK_TIME = CONF.STICK_MS;        // tiempo que la mantenemos pegada
    const MIN_ALERT_INTERVAL = CONF.ALERT_GAP_MS;   // intervalo mínimo entre avisos a n8n
    const PROB_WINDOW = CONF.PROB_WINDOW;           // ventana de suavizado
    const VOL_WINDOW = CONF.VOL_WINDOW;             // ventana para volatilidad adaptativa
    const CONGESTION_TICKS = CONF.CONGESTION_TICKS; // cuántos ciclos con el mismo lado
    const RESET_TIME = 30000;                       // reset ligero (limpieza de buffers)
     const PRICE_WINDOW_SIZE = 30; // ~5-7s con intervalos de 250ms
    const MOVE_WINDOW_SIZE = 30;  // ~5-7s para slope micro
    const RANGE_MULTIPLIER = 1.2;
    const PRICE_INACTIVITY_MS = 5000;
    // Estado de análisis
      window.lastObservedPrice = null;
    window.priceSource = 'n/a';
    let lastObservedPrice = null;
    let lastPrice = null;            // último precio procesado
    let lastDelta = 0;
    let lastProbRaw = 0;
    let lastPriceSelector = null;

    let freq = 0;

    const priceHistory = [];
    const priceWindow = [];
    const tickMoves = [];
    const tickTimestamps = [];
    const probHistory = [];
    const volHistory = [];
    const sideHistory = [];

    let lastEmaFast = null;
    let priceObserver = null;
    let lastPriceChangeAt = 0; // control de actividad real del precio
    let lastWsPriceAt = 0;
    let lastSymbol = null;

    // Estado de mercado y auto-trade
    let marketStatus = "NO PRICE";
    let autoTradeEnabled = false;
    let lastAutoTradeAt = 0;

    // Estado de señal
    let currentSignalSide = "NO TRADE";  // lado candidato que se está formando
    let signalStartAt = 0;               // cuándo empezó ese candidato

    let lastStableSignal = null;         // última señal confirmada enviada
    let lastStableTime = 0;              // cuándo se envió

    // === PANEL MINI ===
   let fxProbEl = null;
    let fxFreqEl = null;
    let fxTrendEl = null;
    let fxStateEl = null;
    let fxDebugEl = null;
    let fxMarketEl = null;
    let fxCallTextEl = null;
    let fxPutTextEl = null;
    let fxAutoBtn = null;

     let gaugeHardHideInjected = false;

    function hideBigPercentageGauge() {
        const overlayEl = document.getElementById('fx-vision-overlay');
        if (!overlayEl) return;

        const regex = /^\d{2,3}(\.\d+)?%$/;
        overlayEl.querySelectorAll('*').forEach(el => {
            const text = (el.textContent || '').trim();
            if (!text || !regex.test(text)) return;
            if (el.closest('#fxvision-signal-box')) return;

            let container = el;
            let depth = 0;
            while (container.parentElement && depth < 3) {
                container = container.parentElement;
                depth++;
            }

            if (container && container !== overlayEl) {
                container.style.display = 'none';
            }
        });
    }

     function ensureFxSignalBox() {
        const fxOverlay = document.getElementById("fx-vision-overlay");
        if (!fxOverlay) return;

        const gaugeSelectors = [
  '.speedometer',
            // Mantener visible el contenedor para no ocultar el botón TURN ON / SELLER VOLUME
            '.gauge',
            '.percentage',
            '.percentage-wrapper'
        ];

        gaugeSelectors.forEach(selector => {
            fxOverlay.querySelectorAll(selector).forEach(el => {
                el.style.display = 'none';
            });
        });

         if (!gaugeHardHideInjected) {
            const style = document.createElement('style');
            style.textContent = `
#fx-vision-overlay .speedometer,
#fx-vision-overlay .gauge,
#fx-vision-overlay .percentage,
#fx-vision-overlay .percentage-wrapper {
    display: none !important;
}
            `;
            document.head.appendChild(style);
            gaugeHardHideInjected = true;
        }

        let signalBox = document.getElementById('fxvision-signal-box');
        if (!signalBox) {
            signalBox = document.createElement('div');
            signalBox.id = 'fxvision-signal-box';
            signalBox.style.cssText = `
                width: 100%;
                background: rgba(0, 0, 0, 0.55);
                border-radius: 14px;
                padding: 12px 14px;
                box-sizing: border-box;
                border: 1px solid rgba(0, 255, 255, 0.2);
                box-shadow: 0 0 25px rgba(0, 0, 0, 0.35);
                display: flex;
                flex-direction: column;
                gap: 6px;
                color: #e5f5ff;
                font-family: 'Segoe UI', 'Roboto', 'Arial', sans-serif;
                font-size: 13px;
                margin-top: auto;
            `;

            fxProbEl = document.createElement('div');
            fxProbEl.id = 'fxv-prob';
            fxProbEl.textContent = 'Prob: ...%';

            fxFreqEl = document.createElement('div');
            fxFreqEl.id = 'fxv-freq';
            fxFreqEl.textContent = 'Freq: ...';

            fxTrendEl = document.createElement('div');
            fxTrendEl.id = 'fxv-trend';
            fxTrendEl.textContent = 'Trend: ...';

            fxStateEl = document.createElement('div');
            fxStateEl.id = 'fxv-state';
            fxStateEl.textContent = 'State: ANALYZING';

            fxDebugEl = document.createElement('div');
            fxDebugEl.id = 'fxv-debug';
            fxDebugEl.style.opacity = '0.8';
            fxDebugEl.textContent = 'Price: ... | d: ... | probUp: ... | range: ... | src: ...';

            fxMarketEl = document.createElement('div');
            fxMarketEl.id = 'fxv-market';
            fxMarketEl.textContent = 'Market: NO PRICE';
            fxMarketEl.style.cssText = `
                font-weight: 700;
                margin-top: 2px;
            `;

            const statusRow = document.createElement('div');
            statusRow.style.cssText = `
                display: flex;
                align-items: center;
                gap: 10px;
                margin-top: 2px;
            `;

            fxAutoBtn = document.createElement('button');
            fxAutoBtn.id = 'fxv-auto';
            fxAutoBtn.textContent = 'AUTO: OFF';
            fxAutoBtn.style.cssText = `
                padding: 6px 10px;
                border-radius: 8px;
                border: 1px solid rgba(0, 255, 200, 0.35);
                background: rgba(255, 255, 255, 0.05);
                color: #d8f5ff;
                cursor: pointer;
                font-weight: 700;
                font-size: 12px;
            `;

            statusRow.appendChild(fxMarketEl);
            statusRow.appendChild(fxAutoBtn);



    const buttonsRow = document.createElement('div');
            buttonsRow.className = 'fxv-buttons-row';
            buttonsRow.style.cssText = `
                display: flex;
                gap: 10px;
                margin-top: 8px;
            `;

            fxCallTextEl = document.createElement('div');
            fxCallTextEl.id = 'fxv-call';
            fxCallTextEl.textContent = 'CALL';
            fxCallTextEl.style.cssText = `
                flex: 1;
                text-align: center;
                padding: 14px 10px;
                border-radius: 10px;
                background: linear-gradient(135deg, rgba(0, 200, 120, 0.8), rgba(0, 180, 100, 0.9));
                color: #f5fff7;
                font-weight: 800;
                letter-spacing: 1px;
                font-size: 16px;
                border: 1px solid rgba(0, 255, 160, 0.4);
                box-shadow: 0 0 20px rgba(0, 255, 160, 0.3);
                display: none;
            `;

            fxPutTextEl = document.createElement('div');
            fxPutTextEl.id = 'fxv-put';
            fxPutTextEl.textContent = 'PUT';
            fxPutTextEl.style.cssText = `
                flex: 1;
                text-align: center;
                padding: 14px 10px;
                border-radius: 10px;
                background: linear-gradient(135deg, rgba(230, 80, 80, 0.85), rgba(200, 40, 40, 0.95));
                color: #fff5f5;
                font-weight: 800;
                letter-spacing: 1px;
                font-size: 16px;
                border: 1px solid rgba(255, 120, 120, 0.4);
                box-shadow: 0 0 20px rgba(255, 100, 100, 0.3);
                display: none;
            `;

            buttonsRow.appendChild(fxCallTextEl);
            buttonsRow.appendChild(fxPutTextEl);

            signalBox.appendChild(fxProbEl);
            signalBox.appendChild(fxFreqEl);
            signalBox.appendChild(fxTrendEl);
            signalBox.appendChild(fxStateEl);
            signalBox.appendChild(fxDebugEl);
            signalBox.appendChild(statusRow);
            signalBox.appendChild(buttonsRow);

            fxOverlay.appendChild(signalBox);
        } else {
            fxProbEl = document.getElementById('fxv-prob');
            fxFreqEl = document.getElementById('fxv-freq');
            fxTrendEl = document.getElementById('fxv-trend');
            fxStateEl = document.getElementById('fxv-state');
            fxDebugEl = document.getElementById('fxv-debug');
             fxMarketEl = document.getElementById('fxv-market');
            fxCallTextEl = document.getElementById('fxv-call');
            fxPutTextEl = document.getElementById('fxv-put');
             fxAutoBtn = document.getElementById('fxv-auto');
        }

        if (fxAutoBtn && !fxAutoBtn.dataset.bound) {
            fxAutoBtn.dataset.bound = '1';
            fxAutoBtn.addEventListener('click', () => {
                if (marketStatus !== 'OK') {
                    autoTradeEnabled = false;
                } else {
                    autoTradeEnabled = !autoTradeEnabled;
                }
                updateAutoTradeButton();
            });
            updateAutoTradeButton();
        }
    }

    // === WebSocket sniffer para obtener el precio real ===
    function extractPricesFromPayload(payload) {
        if (!payload || typeof payload !== 'string') return null;



         const candidates = matches
            .map(p => parseFloat(p))
            .filter(n => Number.isFinite(n) && n > 0 && n < 100000 && n !== Infinity);

        if (!candidates.length) return null;

        return candidates[candidates.length - 1];
    }

             function handleSocketPayloadText(payload) {
        const price = extractPricesFromPayload(payload);
        if (price === null) return;

        lastObservedPrice = price;
        window.lastObservedPrice = price;
        window.priceSource = 'WS';
        lastPriceSelector = 'WS';
        lastWsPriceAt = Date.now();
        handlePriceTick(price);
    }

                function attachWsListeners(ws) {
        ws.addEventListener('message', (ev) => {
            const data = ev && ev.data;
            if (typeof data === 'string') {
                handleSocketPayloadText(data);
                return;
            }

            if (data instanceof ArrayBuffer) {
                const text = new TextDecoder().decode(data);
                handleSocketPayloadText(text);
                return;
            }
        
       if (data instanceof Blob) {
                const reader = new FileReader();
                reader.onload = () => {
                    handleSocketPayloadText(typeof reader.result === 'string' ? reader.result : '');
                };
                reader.readAsText(data);
            }
        });
    }

     function setupWebSocketSniffer() {
        if (window.__fxVisionWsPatched) return;
        window.__fxVisionWsPatched = true;

        const OriginalWebSocket = window.WebSocket;

   const PatchedWebSocket = function(url, protocols) {
            const instance = protocols !== undefined
                ? new OriginalWebSocket(url, protocols)
                : new OriginalWebSocket(url);

            try {
                const urlStr = (instance && instance.url) || url || '';
                if (typeof urlStr === 'string' && urlStr.includes('socket.io')) {
                    attachWsListeners(instance);
                }
            } catch (e) {
                // No romper el flujo principal
            }
            return instance;
        };

            PatchedWebSocket.prototype = OriginalWebSocket.prototype;
        PatchedWebSocket.OPEN = OriginalWebSocket.OPEN;
        PatchedWebSocket.CLOSED = OriginalWebSocket.CLOSED;
        PatchedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
        PatchedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
        Object.setPrototypeOf(PatchedWebSocket, OriginalWebSocket);

        window.WebSocket = PatchedWebSocket;
    }


         function median(values) {
        if (!values || values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        if (sorted.length % 2 === 0) {
            return (sorted[mid - 1] + sorted[mid]) / 2;
        }
        return sorted[mid];
    }


    function calcEMA(values, period) {
        if (!values || values.length < period) return null;

        const k = 2 / (period + 1);
        let ema = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;

        for (let i = period; i < values.length; i++) {
            ema = values[i] * k + ema * (1 - k);
        }

        return ema;
    }

    function getSignalState(probRaw, trend, freq, lastProb) {
        // No es recomendación de inversión, solo clasificación técnica
        const hasMovement = freq >= MIN_FREQ;
        const probRising = probRaw >= lastProb;

        if (!hasMovement) {
            return { signal: "NO TRADE", state: "ANALYZING" };
        }

        if (probRaw >= MIN_PROB && probRising) {
            if (trend === "up") {
                return { signal: "CALL", state: "POTENTIAL UP" };
            }
            if (trend === "down") {
                return { signal: "PUT", state: "POTENTIAL DOWN" };
            }
        }

        return { signal: "NO TRADE", state: "NO CLEAR SIGNAL" };
    }
    function getCurrentSymbol() {
        try {
            const pairEl = document.querySelector('.asset-title span, [data-asset-name]');
            if (pairEl) return pairEl.textContent.trim();
        } catch (e) {
            return null;
        }
        return null;
    }

    function resetPriceBuffers() {
        priceWindow.splice(0, priceWindow.length);
        tickMoves.splice(0, tickMoves.length);
        tickTimestamps.splice(0, tickTimestamps.length);
        volHistory.splice(0, volHistory.length);
        probHistory.splice(0, probHistory.length);
        sideHistory.splice(0, sideHistory.length);
        lastPrice = null;
        lastDelta = 0;
        lastObservedPrice = null;
        window.lastObservedPrice = null;
        window.priceSource = 'n/a';
        lastPriceChangeAt = 0;
        lastWsPriceAt = 0;
    }

    // === INTEGRACIÓN CON N8N (ENVÍO DE ESTADO DEL PANEL) ===
    const N8N_WEBHOOK_URL = "https://n8n.crmwild.space/webhook/fxvison";

    // Para no saturar n8n, controlamos cada cuánto mandamos datos
    let lastSentAt = 0;
    const SNAPSHOT_MIN_INTERVAL = 2000; // mínimo 2 segundos entre envíos

    function sendPanelSnapshotToN8n(probRaw, trend, signal, stateLabel, freq) {
        if (!N8N_WEBHOOK_URL) return;
        const now = Date.now();

        // Limitamos frecuencia de envío
        if (now - lastSentAt < SNAPSHOT_MIN_INTERVAL) return;
        lastSentAt = now;

        // Intentar obtener el par actual del DOM (ajusta selectores si hace falta)
        let pair = null;
        try {
            const pairEl = document.querySelector('.asset-title span, [data-asset-name]');
            if (pairEl) {
                pair = pairEl.textContent.trim();
            }
        } catch (e) {
            pair = null;
        }

        const snapshot = {
            timestamp: now,
            pair,
            prob: probRaw,
            trend,          // "up" | "down" | "none"
            signal,         // "CALL" | "PUT" | "NO TRADE"
            state: stateLabel,
            freq
        };

        try {
            fetch(N8N_WEBHOOK_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(snapshot)
            }).catch(() => {
                // Ignoramos errores de red para no romper el panel
            });
        } catch (e) {
            // Silenciar cualquier error inesperado
        }
    }

     // Calcula tasa de ticks recientes (2s) para evaluar velocidad real
    function getRecentTickRate(now) {
        const cutoff = now - 2000;
        const recent = tickTimestamps.filter(ts => ts >= cutoff);
        return recent.length / 2; // ticks por segundo aproximados
    }

    // Determina el estado del mercado para evitar operar en condiciones malas
    function determineMarketStatus(now, isChop, medianAbsDelta, recentRange) {
        if (lastObservedPrice === null || (now - lastWsPriceAt > PRICE_INACTIVITY_MS)) {
        }

        if (isChop) {
            return "CHOPPY";
        }

        const tickRate = getRecentTickRate(now);
        const slowFreq = tickRate < Math.max(1, MIN_FREQ);
        const slowVol = medianAbsDelta === 0 || medianAbsDelta < Math.max(0.00005, recentRange * 0.002);

        if (slowFreq || slowVol) {
            return "SLOW";
        }

        return "OK";
    }

    // Actualiza el estado visual del mercado y sincroniza auto-trade
    function updateMarketUI() {
        if (!fxMarketEl) return;
        const colorMap = {
            OK: '#5CFF8C',
            SLOW: '#ffb347',
            CHOPPY: '#ffb347',
             'NO PRICE': '#ff6b6b',
            'WAITING FEED': '#ffb347'
        };
        fxMarketEl.textContent = `Market: ${marketStatus}`;
        fxMarketEl.style.color = colorMap[marketStatus] || '#e5f5ff';
    }

    function updateAutoTradeButton() {
        if (!fxAutoBtn) return;
        fxAutoBtn.textContent = autoTradeEnabled ? 'AUTO: ON' : 'AUTO: OFF';
        fxAutoBtn.style.borderColor = autoTradeEnabled ? 'rgba(0, 255, 160, 0.6)' : 'rgba(0, 255, 200, 0.35)';
        fxAutoBtn.style.boxShadow = autoTradeEnabled ? '0 0 10px rgba(0,255,160,0.35)' : 'none';
        fxAutoBtn.style.opacity = marketStatus === 'OK' ? '1' : '0.6';
    }

    // Click seguro del botón de trade real (CALL/PUT)
    function triggerAutoTrade(side) {
        const now = Date.now();
        if (now - lastAutoTradeAt < 6500) return; // cooldown interno 6-7s

        const selectors = side === 'CALL'
            ? [
                'button[data-qa="deal-up"]',
                'button[data-qa="trade-up"]',
                'button[class*="call" i]',
                'button[class*="buy" i]',
                '.trade-button--call',
                '.trade-button.call'
            ]
            : [
                'button[data-qa="deal-down"]',
                'button[data-qa="trade-down"]',
                'button[class*="put" i]',
                'button[class*="sell" i]',
                '.trade-button--put',
                '.trade-button.put'
            ];

        let button = null;
        for (const sel of selectors) {
            const candidate = document.querySelector(sel);
            if (candidate) {
                button = candidate;
                break;
            }
        }

        if (!button) return;

        button.click();
        lastAutoTradeAt = now;
    }

       function handlePriceTick(price) {
        if (price === null || Number.isNaN(price)) return;

     const priceChanged = lastPrice !== null && price !== lastPrice;
        const now = Date.now();

        if (priceChanged) {
            const delta = price - lastPrice;
            lastDelta = delta;
            if (delta > 0) tickMoves.push(1);
            if (delta < 0) tickMoves.push(-1);
            if (tickMoves.length > MOVE_WINDOW_SIZE) tickMoves.shift();
            freq = tickMoves.length;
            lastPriceChangeAt = now;
            tickTimestamps.push(lastPriceChangeAt);
            if (tickTimestamps.length > 120) tickTimestamps.shift();

            volHistory.push(Math.abs(delta));
            if (volHistory.length > VOL_WINDOW) volHistory.shift();
} else if (lastPriceChangeAt === 0) {
            lastPriceChangeAt = now;
        }

        lastPrice = price;

        priceHistory.push(price);
        if (priceHistory.length > 600) priceHistory.shift();
        // Ventana corta de precios para el análisis micro (5-7s)
        priceWindow.push(price);
        if (priceWindow.length > PRICE_WINDOW_SIZE) priceWindow.shift();
    }

       function calculate() {
       ensureFxSignalBox();
       const now = Date.now();
        const currentSymbol = getCurrentSymbol();
        if (currentSymbol !== lastSymbol) {
            lastSymbol = currentSymbol;
            resetPriceBuffers();
            marketStatus = "WAITING FEED";
            if (fxStateEl) fxStateEl.textContent = 'State: WAITING FEED';
            updateMarketUI();
            return;
        }

         if (lastObservedPrice === null || (now - lastWsPriceAt > PRICE_INACTIVITY_MS)) {
            marketStatus = "NO PRICE";
            
            if (autoTradeEnabled) {
                autoTradeEnabled = false;
                updateAutoTradeButton();
            }
            if (fxDebugEl) {
                fxDebugEl.textContent = `Price: ... | d: 0.00000 | probUp: ... | range: ... | src: ${lastPriceSelector || 'n/a'}`;
            }
             updateMarketUI();
            return;
        }

        
        const tickRate = getRecentTickRate(now);

        const upCount = tickMoves.filter(m => m === 1).length;
        const downCount = tickMoves.filter(m => m === -1).length;
        const total = upCount + downCount;
        const probUpRaw = total > 0 ? (upCount / total) * 100 : 0;
        lastProbRaw = probUpRaw;

        
        probHistory.push(probUpRaw);
        if (probHistory.length > PROB_WINDOW) probHistory.shift();

         const smoothedProbUp = probHistory.reduce((a, b) => a + b, 0) / probHistory.length;
        const smoothedProbDown = 100 - smoothedProbUp;

        const recentPrices = priceWindow.slice(-PRICE_WINDOW_SIZE);
        const recentMax = recentPrices.length > 0 ? Math.max(...recentPrices) : 0;
        const recentMin = recentPrices.length > 0 ? Math.min(...recentPrices) : 0;
        const recentRange = recentMax - recentMin;

        
        const deltas = [];
        for (let i = 1; i < recentPrices.length; i++) {
            deltas.push(recentPrices[i] - recentPrices[i - 1]);
        }
        const absDeltas = deltas.map(Math.abs);
        const medianAbsDelta = median(absDeltas);
       const minRange = medianAbsDelta > 0 ? medianAbsDelta * RANGE_MULTIPLIER : 0;
        const isChop = recentRange <= minRange;

        const microSlope = recentPrices.length > 1
            ? (recentPrices[recentPrices.length - 1] - recentPrices[0]) / recentPrices.length
            : 0;

        marketStatus = determineMarketStatus(now, isChop, medianAbsDelta, recentRange);
        freq = tickMoves.length;

        
        let stableSignal = "NO TRADE";
        let stateLabel = "ANALYZING";
        if (isChop) {
            stateLabel = "CHOP / NO TRADE";
        } else if (smoothedProbUp > 60 && microSlope > 0) {
            stableSignal = "CALL";
            stateLabel = "CALL";
        } else if (smoothedProbUp < 40 && microSlope < 0) {
            stableSignal = "PUT";
            stateLabel = "PUT";
        } else if ((smoothedProbUp > 60 && microSlope <= 0) || (smoothedProbDown > 60 && microSlope >= 0)) {
            stateLabel = "PROB VS TREND";
        }

       if (marketStatus !== "OK" && marketStatus !== "SLOW") {
            stableSignal = "NO TRADE";
            stateLabel = `MARKET ${marketStatus} / NO TRADE`;
            
        }

        if (autoTradeEnabled && marketStatus !== "OK") {
            autoTradeEnabled = false;
            updateAutoTradeButton();
        }

        

        if (fxProbEl) {
            fxProbEl.textContent = `Prob: ${smoothedProbUp.toFixed(1)}%`;
        }

        if (fxFreqEl) {
            fxFreqEl.textContent = `Freq: ${freq} | ${tickRate.toFixed(2)} t/s`;
        }

        if (fxTrendEl) {
            const label = microSlope > 0 ? "UP" : microSlope < 0 ? "DOWN" : "FLAT";
            fxTrendEl.textContent = `Trend: ${label}`;
        }

        if (fxStateEl) {
            fxStateEl.textContent = `State: ${stateLabel}`;
        }

        if (fxDebugEl) {
            const priceStr = lastObservedPrice !== null ? lastObservedPrice.toFixed(5) : '...';
            const deltaStr = lastDelta ? lastDelta.toFixed(5) : '0.00000';
            fxDebugEl.textContent = `Price: ${priceStr} | d: ${deltaStr} | probUp: ${smoothedProbUp.toFixed(1)} | range: ${recentRange.toFixed(5)} | src: ${window.priceSource || lastPriceSelector || 'n/a'}`;
        }
        updateMarketUI();
        updateAutoTradeButton();


    

        if (fxCallTextEl && fxPutTextEl) {
            fxCallTextEl.style.display = "none";
            fxPutTextEl.style.display = "none";

              if (stableSignal === "CALL") {
                fxCallTextEl.style.display = "block";
            } else if (stableSignal === "PUT") {
                fxPutTextEl.style.display = "block";
            }
        }
         const entryWindowActive = stableSignal !== "NO TRADE" && !isChop;
        if (autoTradeEnabled && marketStatus === "OK" && stableSignal !== "NO TRADE" && entryWindowActive) {
            triggerAutoTrade(stableSignal);
        }


        let shouldSend = false;

        if (stableSignal === "CALL" || stableSignal === "PUT") {
            const enoughTimeSinceLast =
                now - lastStableTime >= MIN_ALERT_INTERVAL;
            const isNewSide = stableSignal !== lastStableSignal;

            if (enoughTimeSinceLast || isNewSide) {
                shouldSend = true;
                lastStableSignal = stableSignal;
                lastStableTime = now;
            }
        }

        if (shouldSend) {
            const probToSend = smoothedProbUp;

            sendPanelSnapshotToN8n(
                probToSend,
                microSlope > 0 ? 'up' : microSlope < 0 ? 'down' : 'none',
                stableSignal,
                stateLabel,
                freq
            );
        }
    }

     // Sniffer de WebSocket para capturar precio real (socket.io)
    setupWebSocketSniffer();


    // Reset periódico ligero de buffers (sin perder el último precio)
    setInterval(() => {
         if (tickMoves.length > MOVE_WINDOW_SIZE) tickMoves.splice(0, tickMoves.length - MOVE_WINDOW_SIZE);
        if (priceWindow.length > PRICE_WINDOW_SIZE) priceWindow.splice(0, priceWindow.length - PRICE_WINDOW_SIZE);
        probHistory.splice(0, Math.max(0, probHistory.length - PROB_WINDOW));
    }, RESET_TIME);

    // Loop principal de análisis
    setInterval(calculate, 250);


    // Função para detectar dispositivos móveis
    function isMobileDevice() {
        return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
               window.innerWidth <= 768 ||
               ('ontouchstart' in window) ||
               (navigator.maxTouchPoints > 0);
    }
    
    // Definir tamanhos baseados no dispositivo
    const deviceSizes = isMobileDevice() ? {
        width: 320,
        height: 560,
        minWidth: 280,
        minHeight: 400,
        maxWidth: 400,
        maxHeight: 600
    } : {
        width: 420,
        height: 720,
        minWidth: 280,
        minHeight: 520,
        maxWidth: 650,
        maxHeight: 850
    };
    
    // Cria o overlay principal
    const overlay = document.createElement('div');
    overlay.id = 'fx-vision-overlay';
    overlay.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: ${deviceSizes.width}px;
        height: ${deviceSizes.height}px;
        background: linear-gradient(135deg, 
            rgba(10, 10, 30, 0.95) 0%, 
            rgba(20, 20, 50, 0.95) 25%, 
            rgba(15, 25, 60, 0.95) 50%, 
            rgba(25, 15, 45, 0.95) 75%, 
            rgba(10, 10, 30, 0.95) 100%);
        border-radius: 20px;
        box-shadow: 
            0 0 50px rgba(0, 255, 255, 0.3),
            0 0 100px rgba(138, 43, 226, 0.2),
            inset 0 1px 0 rgba(255, 255, 255, 0.1);
        z-index: 999999;
        padding: ${isMobileDevice() ? '15px' : '25px'};
        font-family: 'Segoe UI', 'Roboto', 'Arial', sans-serif;
        border: 1px solid rgba(0, 255, 255, 0.4);
        backdrop-filter: blur(15px);
        color: white;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: ${isMobileDevice() ? '15px' : '20px'};
        min-width: ${deviceSizes.minWidth}px;
        min-height: ${deviceSizes.minHeight}px;
        resize: none;
        overflow: hidden;
        animation: fadeInScale 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    `;

    
    // Adiciona animações CSS
    const style = document.createElement('style');
    style.textContent = `
        @keyframes fadeInScale {
            0% {
                opacity: 0;
                transform: translate(-50%, -50%) scale(0.8);
            }
            100% {
                opacity: 1;
                transform: translate(-50%, -50%) scale(1);
            }
        }
        
        @keyframes glow {
            0%, 100% { box-shadow: 0 0 20px rgba(0, 255, 255, 0.5); }
            50% { box-shadow: 0 0 30px rgba(0, 255, 255, 0.8); }
        }
        
        @keyframes pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.05); }
        }
        
        @keyframes slideIn {
            0% { transform: translateY(20px); opacity: 0; }
            100% { transform: translateY(0); opacity: 1; }
        }
        
        @keyframes numberGlow {
            0%, 100% { 
                color: #00ff88; 
                text-shadow: 0 0 20px rgba(0, 255, 136, 0.8);
            }
            50% { 
                color: #00ffff; 
                text-shadow: 0 0 30px rgba(0, 255, 255, 1);
            }
        }
        
        @keyframes rotate {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        @keyframes gradientShift {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
        }
        
        @keyframes fadeSlide {
            0% { 
                transform: translateX(-150%);
                opacity: 0;
            }
            20% {
                opacity: 1;
            }
            50% {
                opacity: 1;
            }
            80% {
                opacity: 1;
            }
            100% { 
                transform: translateX(250%);
                opacity: 0;
            }
        }
        
        @keyframes arrowUp {
            0%, 100% { 
                transform: translateY(0px);
                opacity: 0.7;
            }
            50% { 
                transform: translateY(-3px);
                opacity: 1;
            }
        }
        
        @keyframes arrowDown {
            0%, 100% { 
                transform: translateY(0px);
                opacity: 0.7;
            }
            50% { 
                transform: translateY(3px);
                opacity: 1;
            }
        }
        
        @keyframes borderLightSlow {
            0% { 
                transform: rotate(0deg);
                opacity: 0.8;
            }
            100% { 
                transform: rotate(360deg);
                opacity: 0.8;
            }
        }
        
        @keyframes borderLightFast {
            0% { 
                transform: rotate(0deg);
                opacity: 1;
            }
            100% { 
                transform: rotate(360deg);
                opacity: 1;
            }
        }

        @keyframes techScan {
            0% { 
                left: -100%;
                opacity: 0;
            }
            10% {
                opacity: 1;
            }
            50% {
                opacity: 1;
            }
            90% {
                opacity: 1;
            }
            100% { 
                left: 100%;
                opacity: 0;
            }
        }

        @keyframes dataPulse {
            0%, 100% { 
                transform: scale(1);
                opacity: 0.8;
            }
            50% { 
                transform: scale(1.02);
                opacity: 1;
            }
        }

        @keyframes circuitGlow {
            0%, 100% { 
                box-shadow: 
                    0 0 20px rgba(0, 255, 255, 0.3),
                    inset 0 0 20px rgba(0, 255, 255, 0.1);
            }
            50% { 
                box-shadow: 
                    0 0 40px rgba(0, 255, 255, 0.6),
                    inset 0 0 30px rgba(0, 255, 255, 0.2);
            }
        }

        @keyframes modalFadeIn {
            0% {
                opacity: 0;
                transform: scale(0.8);
            }
            100% {
                opacity: 1;
                transform: scale(1);
            }
        }

        @keyframes shake {
            0%, 100% { transform: translateX(0); }
            25% { transform: translateX(-5px); }
            75% { transform: translateX(5px); }
        }

        @keyframes vipPulseInitial {
            0%, 20%, 40%, 60%, 80%, 100% { 
                transform: scale(1);
                opacity: 0.8;
            }
            10%, 30%, 50% { 
                transform: scale(1.2);
                opacity: 1;
            }
        }
        
        @keyframes vipContinuousPulse {
            0%, 100% { 
                transform: scale(1);
                opacity: 0.8;
                filter: drop-shadow(0 0 8px rgba(255, 215, 0, 0.6));
            }
            50% { 
                transform: scale(1.1);
                opacity: 1;
                filter: drop-shadow(0 0 12px rgba(255, 215, 0, 1));
            }
        }

        @keyframes float {
            0% { transform: translateY(0px) rotate(0deg); opacity: 0; }
            10% { opacity: 1; }
            90% { opacity: 1; }
            100% { transform: translateY(-100vh) rotate(360deg); opacity: 0; }
        }
        
        @keyframes onlineBlink {
            0%, 100% { 
                opacity: 1;
                transform: scale(1);
            }
            50% { 
                opacity: 0.3;
                transform: scale(0.8);
            }
        }

        @keyframes logoutSlideIn {
            0% {
                opacity: 0;
                transform: translateY(-10px) scale(0.9);
            }
            100% {
                opacity: 1;
                transform: translateY(0) scale(1);
            }
        }

        @keyframes logoutSlideOut {
            0% {
                opacity: 1;
                transform: translateY(0) scale(1);
            }
            100% {
                opacity: 0;
                transform: translateY(-10px) scale(0.9);
            }
        }

        @keyframes gearRotate {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        @keyframes settingsSlideIn {
            0% {
                opacity: 0;
                transform: scale(0.95);
            }
            100% {
                opacity: 1;
                transform: scale(1);
            }
        }

        @keyframes settingsSlideOut {
            0% {
                opacity: 1;
                transform: scale(1);
            }
            100% {
                opacity: 0;
                transform: scale(0.95);
            }
        }

        @keyframes historySlideIn {
            0% {
                opacity: 0;
                transform: translate(-50%, -50%) scale(0.9);
            }
            100% {
                opacity: 1;
                transform: translate(-50%, -50%) scale(1);
            }
        }

        @keyframes historySlideOut {
            0% {
                opacity: 1;
                transform: translate(-50%, -50%) scale(1);
            }
            100% {
                opacity: 0;
                transform: translate(-50%, -50%) scale(0.9);
            }
        }

        @keyframes winPulse {
            0%, 100% { 
                transform: scale(1);
                text-shadow: 0 0 8px rgba(0, 255, 136, 0.8);
            }
            50% { 
                transform: scale(1.05);
                text-shadow: 0 0 12px rgba(0, 255, 136, 1);
            }
        }

        @keyframes lossPulse {
            0%, 100% { 
                transform: scale(1);
                text-shadow: 0 0 8px rgba(255, 68, 68, 0.8);
            }
            50% { 
                transform: scale(1.05);
                text-shadow: 0 0 12px rgba(255, 68, 68, 1);
            }
        }

        .history-scroll {
            scrollbar-width: thin;
            scrollbar-color: rgba(0, 255, 255, 0.5) rgba(255, 255, 255, 0.1);
        }

        .history-scroll::-webkit-scrollbar {
            width: 6px;
        }

        .history-scroll::-webkit-scrollbar-track {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 3px;
        }

        .history-scroll::-webkit-scrollbar-thumb {
            background: rgba(0, 255, 255, 0.5);
            border-radius: 3px;
        }

        .history-scroll::-webkit-scrollbar-thumb:hover {
            background: rgba(0, 255, 255, 0.8);
        }
    `;
    document.head.appendChild(style);
    
    // Efeito de partículas de fundo
    const particlesContainer = document.createElement('div');
    particlesContainer.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        overflow: hidden;
        border-radius: 20px;
    `;
    
    // Cria partículas flutuantes
    for (let i = 0; i < 15; i++) {
        const particle = document.createElement('div');
        particle.style.cssText = `
            position: absolute;
            width: ${Math.random() * 4 + 2}px;
            height: ${Math.random() * 4 + 2}px;
            background: rgba(0, 255, 255, ${Math.random() * 0.8 + 0.2});
            border-radius: 50%;
            left: ${Math.random() * 100}%;
            top: ${Math.random() * 100}%;
            animation: float ${Math.random() * 10 + 5}s infinite linear;
        `;
        particlesContainer.appendChild(particle);
    }
    
    // Área de redimensionamento
    const resizeHandle = document.createElement('div');
    resizeHandle.style.cssText = `
        position: absolute;
        bottom: 0;
        right: 0;
        width: ${isMobileDevice() ? '120px' : '80px'};
        height: ${isMobileDevice() ? '120px' : '100px'};
        cursor: nw-resize;
        background: transparent;
        z-index: 10;
        ${isMobileDevice() ? 'touch-action: none;' : ''}
    `;
    
    // Indicador visual futurista para redimensionamento
    const resizeIndicator = document.createElement('div');
    resizeIndicator.style.cssText = `
        position: absolute;
        bottom: ${isMobileDevice() ? '12px' : '8px'};
        right: ${isMobileDevice() ? '12px' : '8px'};
        width: ${isMobileDevice() ? '24px' : '16px'};
        height: ${isMobileDevice() ? '24px' : '16px'};
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        align-items: flex-end;
        gap: ${isMobileDevice() ? '3px' : '2px'};
        pointer-events: none;
        opacity: 0.6;
        transition: all 0.3s ease;
    `;
    
    // Criar as três linhas do ícone de redimensionamento
    for (let i = 0; i < 3; i++) {
        const line = document.createElement('div');
        const baseWidth = isMobileDevice() ? 6 : 4;
        const width = (i + 1) * baseWidth + (isMobileDevice() ? 4 : 2);
        line.style.cssText = `
            width: ${width}px;
            height: ${isMobileDevice() ? '3px' : '2px'};
            background: linear-gradient(90deg, 
                rgba(0, 255, 255, 0.8) 0%, 
                rgba(100, 200, 255, 0.8) 100%);
            border-radius: ${isMobileDevice() ? '2px' : '1px'};
            box-shadow: 0 0 4px rgba(0, 255, 255, 0.4);
        `;
        resizeIndicator.appendChild(line);
    }
    
    // Hover effect para o handle de redimensionamento
    resizeHandle.addEventListener('mouseenter', function() {
        resizeIndicator.style.opacity = '1';
        resizeIndicator.style.transform = `scale(${isMobileDevice() ? '1.2' : '1.1'})`;
        const lines = resizeIndicator.querySelectorAll('div');
        lines.forEach(line => {
            line.style.boxShadow = '0 0 8px rgba(0, 255, 255, 0.8)';
            line.style.background = 'linear-gradient(90deg, rgba(0, 255, 255, 1) 0%, rgba(100, 200, 255, 1) 100%)';
        });
    });
    
    resizeHandle.addEventListener('mouseleave', function() {
        resizeIndicator.style.opacity = '0.6';
        resizeIndicator.style.transform = 'scale(1)';
        const lines = resizeIndicator.querySelectorAll('div');
        lines.forEach(line => {
            line.style.boxShadow = '0 0 4px rgba(0, 255, 255, 0.4)';
            line.style.background = 'linear-gradient(90deg, rgba(0, 255, 255, 0.8) 0%, rgba(100, 200, 255, 0.8) 100%)';
        });
    });
    
    // Touch effects para mobile
    if (isMobileDevice()) {
        resizeHandle.addEventListener('touchstart', function(e) {
            e.preventDefault();
            resizeIndicator.style.opacity = '1';
            resizeIndicator.style.transform = 'scale(1.3)';
            const lines = resizeIndicator.querySelectorAll('div');
            lines.forEach(line => {
                line.style.boxShadow = '0 0 12px rgba(0, 255, 255, 1)';
                line.style.background = 'linear-gradient(90deg, rgba(0, 255, 255, 1) 0%, rgba(100, 200, 255, 1) 100%)';
            });
        });
        
        resizeHandle.addEventListener('touchend', function(e) {
            setTimeout(() => {
                resizeIndicator.style.opacity = '0.8';
                resizeIndicator.style.transform = 'scale(1)';
                const lines = resizeIndicator.querySelectorAll('div');
                lines.forEach(line => {
                    line.style.boxShadow = '0 0 6px rgba(0, 255, 255, 0.6)';
                    line.style.background = 'linear-gradient(90deg, rgba(0, 255, 255, 0.9) 0%, rgba(100, 200, 255, 0.9) 100%)';
                });
            }, 100);
        });
        
        // Manter visibilidade maior em mobile
        resizeIndicator.style.opacity = '0.8';
    }
    
    // Logo do FX Vision com efeitos
    const logoContainer = document.createElement('div');
    logoContainer.style.cssText = `
        position: relative;
        margin-bottom: ${isMobileDevice() ? '10px' : '15px'};
        animation: slideIn 0.8s ease-out 0.2s both;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: ${isMobileDevice() ? '6px' : '8px'};
    `;
    
    const logo = document.createElement('img');
    logo.src = 'https://i.ibb.co/wFdnfkDM/O-sucesso-e-construi-do-nos-bastidores-onde-ningue-m-ve-mas-Deus-observa-tudo-2.png';
    logo.style.cssText = `
        width: ${isMobileDevice() ? '120px' : '160px'};
        height: auto;
        border-radius: 12px;
        transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        filter: drop-shadow(0 0 20px rgba(0, 255, 255, 0.4));
    `;
    
    logo.addEventListener('mouseenter', function() {
        this.style.transform = 'scale(1.05)';
        this.style.filter = 'drop-shadow(0 0 30px rgba(0, 255, 255, 0.8))';
    });
    
    logo.addEventListener('mouseleave', function() {
        this.style.transform = 'scale(1)';
        this.style.filter = 'drop-shadow(0 0 20px rgba(0, 255, 255, 0.4))';
    });
    
    logoContainer.appendChild(logo);

    // Email display com ícone VIP (inicialmente oculto)
    const emailDisplay = document.createElement('div');
    emailDisplay.style.cssText = `
        font-size: 12px;
        color: rgba(0, 255, 255, 0.8);
        text-shadow: 0 0 10px rgba(0, 255, 255, 0.5);
        letter-spacing: 1px;
        font-weight: 500;
        background: rgba(0, 255, 255, 0.1);
        padding: 4px 12px;
        border-radius: 15px;
        border: 1px solid rgba(0, 255, 255, 0.3);
        backdrop-filter: blur(10px);
        display: none;
        animation: slideIn 0.6s ease-out;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        transition: all 0.3s ease;
        position: relative;
    `;
    
    // Hover effect para o email display
    emailDisplay.addEventListener('mouseenter', function() {
        this.style.background = 'rgba(0, 255, 255, 0.15)';
        this.style.borderColor = 'rgba(0, 255, 255, 0.5)';
        this.style.transform = 'scale(1.02)';
    });
    
    emailDisplay.addEventListener('mouseleave', function() {
        this.style.background = 'rgba(0, 255, 255, 0.1)';
        this.style.borderColor = 'rgba(0, 255, 255, 0.3)';
        this.style.transform = 'scale(1)';
    });
    
    logoContainer.appendChild(emailDisplay);
    
    // ===== PAINEL TECNOLÓGICO UNIFICADO =====
    const unifiedPanel = document.createElement('div');
    unifiedPanel.style.cssText = `
        position: relative;
        width: 95%;
        max-width: 350px;
        height: 65px;
        background: linear-gradient(135deg, 
            rgba(15, 25, 45, 0.95) 0%, 
            rgba(25, 35, 55, 0.95) 25%,
            rgba(35, 45, 65, 0.95) 50%,
            rgba(25, 35, 55, 0.95) 75%,
            rgba(15, 25, 45, 0.95) 100%);
        border-radius: 15px;
        border: 1px solid rgba(0, 255, 255, 0.3);
        box-shadow: 
            0 0 25px rgba(0, 255, 255, 0.2),
            inset 0 1px 0 rgba(255, 255, 255, 0.1),
            inset 0 -1px 0 rgba(0, 0, 0, 0.3);
        backdrop-filter: blur(15px);
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 20px;
        overflow: hidden;
        animation: slideIn 0.8s ease-out 0.4s both, circuitGlow 3s ease-in-out infinite;
        transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    `;

    // Efeito de scan tecnológico
    const scanEffect = document.createElement('div');
    scanEffect.style.cssText = `
        position: absolute;
        top: 0;
        left: -100%;
        width: 100px;
        height: 100%;
        background: linear-gradient(90deg,
            transparent 0%,
            rgba(0, 255, 255, 0.1) 20%,
            rgba(0, 255, 255, 0.3) 50%,
            rgba(0, 255, 255, 0.1) 80%,
            transparent 100%);
        animation: techScan 4s ease-in-out infinite;
        pointer-events: none;
        border-radius: 15px;
    `;

    // Padrão de circuito tecnológico
    const circuitPattern = document.createElement('div');
    circuitPattern.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        opacity: 0.1;
        pointer-events: none;
        border-radius: 15px;
        background-image: 
            linear-gradient(90deg, rgba(0, 255, 255, 0.3) 1px, transparent 1px),
            linear-gradient(rgba(0, 255, 255, 0.3) 1px, transparent 1px);
        background-size: 20px 20px;
    `;

    // Container para logo QUOTEX
    const quotexLogoContainer = document.createElement('div');
    quotexLogoContainer.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
        z-index: 2;
    `;

    // Texto QUOTEX
    const quotexText = document.createElement('div');
    quotexText.style.cssText = `
        font-size: 16px;
        font-weight: 700;
        color: #ffffff;
        text-shadow: 0 0 10px rgba(0, 255, 255, 0.5);
        letter-spacing: 2px;
        text-transform: uppercase;
        font-family: 'Segoe UI', 'Orbitron', monospace;
    `;
    quotexText.textContent = 'QUOTEX';

    // Container para ativo
    const assetContainer = document.createElement('div');
    assetContainer.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
        z-index: 2;
        position: relative;
        flex: 1;
        min-width: 0;
    `;

    // Indicador de status do ativo
    const assetStatus = document.createElement('div');
    assetStatus.style.cssText = `
        width: 8px;
        height: 8px;
        background: #00ff88;
        border-radius: 50%;
        box-shadow: 0 0 10px rgba(0, 255, 136, 0.8);
        animation: dataPulse 1s ease-in-out infinite;
        flex-shrink: 0;
    `;

    // Texto do ativo
    const assetText = document.createElement('div');
    assetText.style.cssText = `
        font-size: 14px;
        font-weight: 600;
        color: #ffffff;
        text-shadow: 0 0 8px rgba(255, 255, 255, 0.3);
        letter-spacing: 1px;
        font-family: 'Segoe UI', 'Orbitron', monospace;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        text-align: right;
        flex: 1;
        min-width: 0;
    `;
    assetText.textContent = 'Loading...';

    // Montagem do painel unificado
    quotexLogoContainer.appendChild(quotexText);
    
    assetContainer.appendChild(assetStatus);
    assetContainer.appendChild(assetText);
    
    unifiedPanel.appendChild(circuitPattern);
    unifiedPanel.appendChild(scanEffect);
    unifiedPanel.appendChild(quotexLogoContainer);
    unifiedPanel.appendChild(assetContainer);

    // Hover effects do painel
    unifiedPanel.addEventListener('mouseenter', function() {
        this.style.transform = 'scale(1.02)';
        this.style.boxShadow = `
            0 0 35px rgba(0, 255, 255, 0.4),
            inset 0 1px 0 rgba(255, 255, 255, 0.2),
            inset 0 -1px 0 rgba(0, 0, 0, 0.4)`;
        this.style.borderColor = 'rgba(0, 255, 255, 0.6)';
        
        // Acelera a animação do scan
        scanEffect.style.animationDuration = '2s';
        assetStatus.style.boxShadow = '0 0 15px rgba(0, 255, 136, 1)';
    });
    
    unifiedPanel.addEventListener('mouseleave', function() {
        this.style.transform = 'scale(1)';
        this.style.boxShadow = `
            0 0 25px rgba(0, 255, 255, 0.2),
            inset 0 1px 0 rgba(255, 255, 255, 0.1),
            inset 0 -1px 0 rgba(0, 0, 0, 0.3)`;
        this.style.borderColor = 'rgba(0, 255, 255, 0.3)';
        
        // Volta à velocidade normal
        scanEffect.style.animationDuration = '4s';
        assetStatus.style.boxShadow = '0 0 10px rgba(0, 255, 136, 0.8)';
    });
    
    // Velocímetro circular
    const speedometerContainer = document.createElement('div');
    speedometerContainer.className = 'speedometer-container';
    speedometerContainer.style.cssText = `
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 15px;
        margin: 20px 0;
        animation: slideIn 0.8s ease-out 0.8s both;
    `;
    
    // Container do velocímetro
    const speedometer = document.createElement('div');
     speedometer.className = 'speedometer gauge';
    speedometer.style.cssText = `
        position: relative;
        width: ${isMobileDevice() ? '140px' : '180px'};
        height: ${isMobileDevice() ? '140px' : '180px'};
        border-radius: 50%;
        background: radial-gradient(circle at center, 
            rgba(45, 55, 65, 0.9) 0%, 
            rgba(35, 45, 55, 0.95) 70%, 
            rgba(25, 35, 45, 0.98) 100%);
        border: 2px solid rgba(255, 255, 255, 0.1);
        box-shadow: 
            0 0 30px rgba(0, 0, 0, 0.5),
            inset 0 0 30px rgba(0, 0, 0, 0.3);
        transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
    `;
    
    // Luz animada da borda
    const borderLight = document.createElement('div');
    borderLight.style.cssText = `
        position: absolute;
        top: -4px;
        left: -4px;
        width: calc(100% + 8px);
        height: calc(100% + 8px);
        border-radius: 50%;
        background: conic-gradient(
            transparent 0deg,
            transparent 270deg,
            #ff6b35 300deg,
            #ff8c42 320deg,
            #ff6b35 340deg,
            transparent 360deg
        );
        opacity: 0;
        pointer-events: none;
        z-index: 1;
    `;
    
    speedometer.appendChild(borderLight);
    
    // Marcações do velocímetro
    const marks = document.createElement('div');
    marks.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        border-radius: 50%;
    `;
    
    const speedometerRadius = isMobileDevice() ? 70 : 90;
    const markHeight = isMobileDevice() ? 15 : 20;
    const smallMarkHeight = isMobileDevice() ? 8 : 12;

    for (let i = 0; i < 12; i++) {
        const mark = document.createElement('div');
        const angle = (i * 30) - 90;
        const isMainMark = i % 3 === 0;

        mark.style.cssText = `
            position: absolute;
            width: ${isMainMark ? '3px' : '2px'};
            height: ${isMainMark ? markHeight + 'px' : smallMarkHeight + 'px'};
            background: ${isMainMark ? '#00aaff' : 'rgba(255, 255, 255, 0.4)'};
            top: 5px;
            left: 50%;
            transform-origin: 50% ${speedometerRadius}px;
            transform: translateX(-50%) rotate(${angle}deg);
            border-radius: 2px;
        `;
        marks.appendChild(mark);
    }
    
    // Conteúdo interno do velocímetro
    const innerContent = document.createElement('div');
    innerContent.style.cssText = `
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        gap: 8px;
        z-index: 10;
    `;

    // Logo de fundo com transparência
    const backgroundLogo = document.createElement('img');
    backgroundLogo.src = 'https://gnnswuwgfgadxreyfjof.supabase.co/storage/v1/object/public/general-images/1763354104906-5vmo3m.png';
    backgroundLogo.style.cssText = `
        position: absolute;
        width: ${isMobileDevice() ? '100px' : '130px'};
        height: auto;
        opacity: 0.15;
        z-index: 1;
        pointer-events: none;
        filter: brightness(1.2);
    `;

    // Porcentagem no centro
    const percentage = document.createElement('div');
    percentage.className = 'percentage';
    percentage.style.cssText = `
        font-size: ${isMobileDevice() ? '24px' : '32px'};
        font-weight: bold;
        color: #00aaff;
        text-shadow: 0 0 15px rgba(0, 170, 255, 0.6);
        font-family: 'Segoe UI', 'Roboto', sans-serif;
        letter-spacing: 0.5px;
        position: relative;
        z-index: 2;
    `;
    percentage.textContent = '0.0%';
    
    // Par de moedas
    const currencyPair = document.createElement('div');
    currencyPair.style.cssText = `
        font-size: ${isMobileDevice() ? '12px' : '14px'};
        color: rgba(255, 255, 255, 0.7);
        font-weight: 500;
        letter-spacing: 1px;
        margin: 5px 0;
    `;
    currencyPair.textContent = 'Loading...';

    // Ajustar z-index do currencyPair
    currencyPair.style.position = 'relative';
    currencyPair.style.zIndex = '2';

    // Montagem do conteúdo interno
    innerContent.appendChild(backgroundLogo);
    innerContent.appendChild(percentage);
    innerContent.appendChild(currencyPair);
    
    // Montagem do velocímetro
    speedometer.appendChild(marks);
    speedometer.appendChild(innerContent);
    
    // Label VOLUME FREQUENCY
    const volumeLabel = document.createElement('div');
    volumeLabel.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        font-size: 13px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.6);
        text-align: center;
        letter-spacing: 2px;
        margin-top: 10px;
        text-transform: uppercase;
        font-family: 'Segoe UI', sans-serif;
    `;
    
    const volumeText = document.createElement('span');
    volumeText.textContent = 'VOLUME FREQUENCY';
    
    // Ícone de engrenagem (inicialmente oculto)
    const gearIcon = document.createElement('div');
    gearIcon.style.cssText = `
        width: 16px;
        height: 16px;
        cursor: pointer;
        display: none;
        transition: all 0.3s ease;
        opacity: 0.7;
        position: relative;
    `;
    
    // SVG da engrenagem
    gearIcon.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15Z" stroke="rgba(255, 255, 255, 0.6)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M19.4 15C19.2669 15.3016 19.2272 15.6362 19.286 15.9606C19.3448 16.285 19.4995 16.5843 19.73 16.82L19.79 16.88C19.976 17.0657 20.1235 17.2863 20.2241 17.5291C20.3248 17.7719 20.3766 18.0322 20.3766 18.295C20.3766 18.5578 20.3248 18.8181 20.2241 19.0609C20.1235 19.3037 19.976 19.5243 19.79 19.71C19.6043 19.896 19.3837 20.0435 19.1409 20.1441C18.8981 20.2448 18.6378 20.2966 18.375 20.2966C18.1122 20.2966 17.8519 20.2448 17.6091 20.1441C17.3663 20.0435 17.1457 19.896 16.96 19.71L16.9 19.65C16.6643 19.4195 16.365 19.2648 16.0406 19.206C15.7162 19.1472 15.3816 19.1869 15.08 19.32C14.7842 19.4468 14.532 19.6572 14.3543 19.9255C14.1766 20.1938 14.0813 20.5082 14.08 20.83V21C14.08 21.5304 13.8693 22.0391 13.4942 22.4142C13.1191 22.7893 12.6104 23 12.08 23C11.5496 23 11.0409 22.7893 10.6658 22.4142C10.2907 22.0391 10.08 21.5304 10.08 21V20.91C10.0723 20.579 9.96512 20.2573 9.77251 19.9887C9.5799 19.7201 9.31074 19.5176 9 19.41C8.69838 19.2769 8.36381 19.2372 8.03941 19.296C7.71502 19.3548 7.41568 19.5095 7.18 19.74L7.12 19.8C6.93425 19.986 6.71368 20.1335 6.47088 20.2341C6.22808 20.3348 5.96783 20.3866 5.705 20.3866C5.44217 20.3866 5.18192 20.3348 4.93912 20.2341C4.69632 20.1335 4.47575 19.986 4.29 19.8C4.10405 19.6143 3.95653 19.3937 3.85588 19.1509C3.75523 18.9081 3.70343 18.6478 3.70343 18.385C3.70343 18.1222 3.75523 17.8619 3.85588 17.6191C3.95653 17.3763 4.10405 17.1557 4.29 16.97L4.35 16.91C4.58054 16.6743 4.73519 16.375 4.794 16.0506C4.85282 15.7262 4.81312 15.3916 4.68 15.09C4.55324 14.7942 4.34276 14.542 4.07447 14.3643C3.80618 14.1866 3.49179 14.0913 3.17 14.09H3C2.46957 14.09 1.96086 13.8793 1.58579 13.5042C1.21071 13.1291 1 12.6204 1 12.09C1 11.5596 1.21071 11.0509 1.58579 10.6758C1.96086 10.3007 2.46957 10.09 3 10.09H3.09C3.42099 10.0823 3.742 9.97512 4.01062 9.78251C4.27925 9.5899 4.48167 9.32074 4.59 9.01C4.72312 8.70838 4.76282 8.37381 4.704 8.04941C4.64519 7.72502 4.49054 7.42568 4.26 7.19L4.2 7.13C4.01405 6.94425 3.86653 6.72368 3.76588 6.48088C3.66523 6.23808 3.61343 5.97783 3.61343 5.715C3.61343 5.45217 3.66523 5.19192 3.76588 4.94912C3.86653 4.70632 4.01405 4.48575 4.2 4.3C4.38575 4.11405 4.60632 3.96653 4.84912 3.86588C5.09192 3.76523 5.35217 3.71343 5.615 3.71343C5.87783 3.71343 6.13808 3.76523 6.38088 3.86588C6.62368 3.96653 6.84425 4.11405 7.03 4.3L7.09 4.36C7.32568 4.59054 7.62502 4.74519 7.94941 4.804C8.27381 4.86282 8.60838 4.82312 8.91 4.69H9C9.29577 4.56324 9.54802 4.35276 9.72569 4.08447C9.90337 3.81618 9.99872 3.50179 10 3.18V3C10 2.46957 10.2107 1.96086 10.5858 1.58579C10.9609 1.21071 11.4696 1 12 1C12.5304 1 13.0391 1.21071 13.4142 1.58579C13.7893 1.96086 14 2.46957 14 3V3.09C14.0013 3.41179 14.0966 3.72618 14.2743 3.99447C14.452 4.26276 14.7042 4.47324 15 4.6C15.3016 4.73312 15.6362 4.77282 15.9606 4.714C16.285 4.65519 16.5843 4.50054 16.82 4.27L16.88 4.21C17.0657 4.02405 17.2863 3.87653 17.5291 3.77588C17.7719 3.67523 18.0322 3.62343 18.295 3.62343C18.5578 3.62343 18.8181 3.67523 19.0609 3.77588C19.3037 3.87653 19.5243 4.02405 19.71 4.21C19.896 4.39575 20.0435 4.61632 20.1441 4.85912C20.2448 5.10192 20.2966 5.36217 20.2966 5.625C20.2966 5.88783 20.2448 6.14808 20.1441 6.39088C20.0435 6.63368 19.896 6.85425 19.71 7.04L19.65 7.1C19.4195 7.33568 19.2648 7.63502 19.206 7.95941C19.1472 8.28381 19.1869 8.61838 19.32 8.92V9C19.4468 9.29577 19.6572 9.54802 19.9255 9.72569C20.1938 9.90337 20.5082 9.99872 20.83 10H21C21.5304 10 22.0391 10.2107 22.4142 10.5858C22.7893 10.9609 23 11.4696 23 12C23 12.5304 22.7893 13.0391 22.4142 13.4142C22.0391 13.7893 21.5304 14 21 14H20.91C20.5882 14.0013 20.2738 14.0966 20.0055 14.2743C19.7372 14.452 19.5268 14.7042 19.4 15Z" stroke="rgba(255, 255, 255, 0.6)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
    `;
    
    // Hover effects da engrenagem
    gearIcon.addEventListener('mouseenter', function() {
        this.style.opacity = '1';
        this.style.transform = 'scale(1.1)';
        this.style.animation = 'gearRotate 2s linear infinite';
        const svg = this.querySelector('svg path');
        if (svg) {
            svg.setAttribute('stroke', 'rgba(0, 255, 255, 0.8)');
        }
    });
    
    gearIcon.addEventListener('mouseleave', function() {
        this.style.opacity = '0.7';
        this.style.transform = 'scale(1)';
        this.style.animation = 'none';
        const svg = this.querySelector('svg path');
        if (svg) {
            svg.setAttribute('stroke', 'rgba(255, 255, 255, 0.6)');
        }
    });
    
    // Click na engrenagem
    gearIcon.addEventListener('click', function(e) {
        e.stopPropagation();
        openSettingsModal();
    });
    
    // Touch support para engrenagem em mobile
    if (isMobileDevice()) {
        gearIcon.addEventListener('touchstart', function(e) {
            e.preventDefault();
            e.stopPropagation();
            
            this.style.opacity = '1';
            this.style.transform = 'scale(1.2)';
            this.style.animation = 'gearRotate 1s linear infinite';
        });
        
        gearIcon.addEventListener('touchend', function(e) {
            e.preventDefault();
            e.stopPropagation();
            
            setTimeout(() => {
                openSettingsModal();
            }, 50);
        });
    }
    
    volumeLabel.appendChild(volumeText);
    volumeLabel.appendChild(gearIcon);
    
    // Estado do sistema
    let isReading = false;
    let isAuthenticated = false;
    let userEmail = '';
    let volumeCheckInterval;
    let signalCheckInterval;
    let currentVolumeState = 'READING';
    let currentMinute = -1;
    let speedometerInterval;
    let basePercentage = 0;

    // Inicializar Supabase Client
    const SUPABASE_URL = 'https://oggtaibqhyvmupulskfm.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nZ3RhaWJxaHl2bXVwdWxza2ZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgxNzgyNjgsImV4cCI6MjA3Mzc1NDI2OH0.TVhFOesB3Xs8gIenzrFitqX2ClCDpguzv56tzVQOT7c';

    let supabaseClient = null;
    let currentSignalId = null;
    let lastKnownAsset = '';

    // Função para inicializar Supabase (chamada após autenticação)
    async function initializeSupabase(session) {
        if (typeof supabase === 'undefined') {
            return null;
        }

        supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            global: {
                headers: {
                    Authorization: `Bearer ${session.access_token}`
                }
            }
        });

        return supabaseClient;
    }

    // Nova função para buscar sinal sincronizado do banco de dados
    async function fetchSynchronizedSignal() {
        if (!supabaseClient) {
            return;
        }

        if (!isReading) {
            return;
        }

        try {
            const now = new Date();
            const currentMinuteNow = now.getMinutes();

            // Obter ativo atual
            const currentAsset = detectCurrentAsset();
            const cleanedAsset = cleanAssetName(currentAsset);
            const assetForQuery = (cleanedAsset && cleanedAsset !== 'Not Found' && cleanedAsset !== 'Loading...') ? cleanedAsset : 'EURUSD';

            // Se o ativo mudou, resetar sinal e forçar novo
            if (lastKnownAsset && lastKnownAsset !== assetForQuery) {
                currentSignalId = null;
                currentVolumeState = 'ANALYZING';
                currentMinute = -1;
                lastKnownAsset = assetForQuery;
                await generateNewSignal();
                return;
            }

            lastKnownAsset = assetForQuery;

            // Buscar sinal ativo do banco de dados
            const { data: signal, error } = await supabaseClient
                .from('signals')
                .select('*')
                .eq('asset', assetForQuery)
                .gt('expires_at', now.toISOString())
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (error) {
                await generateNewSignal();
                return;
            }

            // Se não há sinal ou mudou o minuto, gerar novo
            if (!signal || signal.minute !== currentMinuteNow || signal.id !== currentSignalId) {
                await generateNewSignal();
                return;
            }

            // Aplicar sinal existente
            if (currentVolumeState !== signal.signal_type || currentMinute !== signal.minute) {
                currentVolumeState = signal.signal_type;
                currentMinute = signal.minute;
                currentSignalId = signal.id;

                // Se for BUYER ou SELLER, usar a porcentagem do banco
                if (signal.signal_type === 'BUYER' || signal.signal_type === 'SELLER') {
                    basePercentage = signal.percentage;
                }

                updateButtonAppearance();
            }
        } catch (err) {
            // Error handled silently
        }
    }

    // Função para gerar novo sinal via Edge Function
    async function generateNewSignal() {
        if (!supabaseClient) {
            return;
        }

        try {
            // Obter ativo atual
            const currentAsset = detectCurrentAsset();
            const cleanedAsset = cleanAssetName(currentAsset);
            const assetForQuery = (cleanedAsset && cleanedAsset !== 'Not Found' && cleanedAsset !== 'Loading...') ? cleanedAsset : 'EURUSD';

            const response = await fetch(`${SUPABASE_URL}/functions/v1/generate-signal`, {
                method: 'POST',
                headers: {
                    'apikey': SUPABASE_ANON_KEY,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ asset: assetForQuery })
            });

            if (response.ok) {
                const signal = await response.json();

                currentVolumeState = signal.signal_type;
                currentMinute = signal.minute;
                currentSignalId = signal.id;

                if (signal.signal_type === 'BUYER' || signal.signal_type === 'SELLER') {
                    basePercentage = signal.percentage;
                }

                updateButtonAppearance();
            }
        } catch (err) {
            // Error handled silently
        }
    }

    let globalOnlineUsers = 0;
    let isAutomaticOperationEnabled = false;
    let settingsModal = null;
    
    let logoutMenu = null;

    // ===== SISTEMA DE HISTÓRICO DE ATIVOS =====
    let historyModal = null;

    // Função para gerar dados de histórico fake mas realísticos
    function generateAssetHistory() {
        const assets = [
            'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CAD', 'USD/CHF',
            'NZD/USD', 'EUR/GBP', 'EUR/JPY', 'GBP/JPY', 'GOLD', 'SILVER',
            'OIL', 'BTC/USD', 'ETH/USD', 'ADA/USD', 'APPLE', 'GOOGLE',
            'TESLA', 'AMAZON', 'MICROSOFT', 'FACEBOOK'
        ];
        
        const histories = [];
        
        assets.forEach(asset => {
            const operations = [];
            let winCount = 0;
            let lossCount = 0;
            
            // Determinar se deve ter alta ou baixa assertividade
            const highWinRate = Math.random() < 0.75; // 75% dos ativos terão alta assertividade
            const targetWinRate = highWinRate ? 
                0.72 + Math.random() * 0.18 : // 72% a 90% para alta assertividade
                0.35 + Math.random() * 0.25;  // 35% a 60% para baixa assertividade
            
            // Gerar 30 operações
            for (let i = 0; i < 30; i++) {
                const currentWinRate = winCount / Math.max(1, winCount + lossCount);
                const shouldWin = currentWinRate < targetWinRate || (i < 5 && Math.random() < targetWinRate);
                
                const signal = Math.random() > 0.5 ? 'CALL' : 'PUT';
                const result = shouldWin ? 'WIN' : 'LOSS';
                
                if (result === 'WIN') {
                    winCount++;
                } else {
                    lossCount++;
                }
                
                const timeAgo = Math.floor(Math.random() * 120) + 1; // 1-120 minutos atrás
                
                operations.push({
                    signal: signal,
                    result: result,
                    timeAgo: timeAgo
                });
            }
            
            // Calcular estatísticas finais
            const totalOps = operations.length;
            const winRate = (winCount / totalOps) * 100;
            
            histories.push({
                asset: asset,
                operations: operations.reverse(), // Mais recente primeiro
                winRate: winRate,
                totalWins: winCount,
                totalLoss: lossCount,
                totalOps: totalOps
            });
        });
        
        return histories;
    }

    // Botão ASSET HISTORY (inicialmente oculto)
    const assetHistoryButton = document.createElement('button');
    assetHistoryButton.style.cssText = `
        display: none;
        align-items: center;
        justify-content: center;
        gap: 8px;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        border: none;
        padding: 10px 20px;
        border-radius: 25px;
        color: #ffffff;
        font-weight: bold;
        font-size: 11px;
        cursor: pointer;
        transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
        letter-spacing: 1px;
        margin-top: 8px;
        text-transform: uppercase;
        backdrop-filter: blur(10px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        width: 180px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        animation: slideIn 0.8s ease-out;
    `;

    // Ícone de histórico
    const historyIcon = document.createElement('div');
    historyIcon.style.cssText = `
        width: 14px;
        height: 14px;
        flex-shrink: 0;
    `;
    
    historyIcon.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2V6M12 18V22M4.93 4.93L7.76 7.76M16.24 16.24L19.07 19.07M2 12H6M18 12H22M4.93 19.07L7.76 16.24M16.24 7.76L19.07 4.93" stroke="rgba(255, 255, 255, 0.9)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="12" cy="12" r="3" stroke="rgba(255, 255, 255, 0.9)" stroke-width="2"/>
        </svg>
    `;

    // Texto do botão
    const historyButtonText = document.createElement('span');
    historyButtonText.textContent = 'ASSET HISTORY';

    assetHistoryButton.appendChild(historyIcon);
    assetHistoryButton.appendChild(historyButtonText);

    // Hover effects do botão de histórico
    assetHistoryButton.addEventListener('mouseenter', function() {
        this.style.background = 'linear-gradient(135deg, #7c4dff 0%, #9575cd 100%)';
        this.style.transform = 'scale(1.05)';
        this.style.boxShadow = '0 6px 20px rgba(124, 77, 255, 0.4)';
    });

    assetHistoryButton.addEventListener('mouseleave', function() {
        this.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
        this.style.transform = 'scale(1)';
        this.style.boxShadow = '0 4px 15px rgba(102, 126, 234, 0.3)';
    });

    // Click no botão de histórico
    assetHistoryButton.addEventListener('click', function(e) {
        e.stopPropagation();
        openAssetHistoryModal();
    });

    // Touch support para botão de histórico em mobile
    if (isMobileDevice()) {
        assetHistoryButton.addEventListener('touchstart', function(e) {
            e.preventDefault();
            e.stopPropagation();
            
            this.style.transform = 'scale(0.95)';
            this.style.background = 'linear-gradient(135deg, #7c4dff 0%, #9575cd 100%)';
        });
        
        assetHistoryButton.addEventListener('touchend', function(e) {
            e.preventDefault();
            e.stopPropagation();
            
            this.style.transform = 'scale(1)';
            this.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
            
            setTimeout(() => {
                openAssetHistoryModal();
            }, 50);
        });
    }

    // Função para abrir modal de histórico de ativos
    function openAssetHistoryModal() {
        if (historyModal) {
            return; // Modal já está aberto
        }
        
        historyModal = document.createElement('div');
        historyModal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.9);
            backdrop-filter: blur(15px);
            z-index: 1000002;
            display: flex;
            align-items: center;
            justify-content: center;
            animation: historySlideIn 0.4s ease-out;
            padding: 20px;
            box-sizing: border-box;
        `;
        
        const modalContent = document.createElement('div');
        modalContent.style.cssText = `
            background: linear-gradient(135deg, 
                rgba(15, 25, 45, 0.98) 0%, 
                rgba(25, 35, 55, 0.98) 25%,
                rgba(35, 45, 65, 0.98) 50%,
                rgba(25, 35, 55, 0.98) 75%,
                rgba(15, 25, 45, 0.98) 100%);
            border-radius: 20px;
            border: 1px solid rgba(0, 255, 255, 0.4);
            box-shadow: 
                0 0 60px rgba(0, 255, 255, 0.3),
                0 0 120px rgba(138, 43, 226, 0.2),
                inset 0 1px 0 rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(20px);
            padding: 30px;
            max-width: 900px;
            width: 100%;
            max-height: 80vh;
            color: white;
            font-family: 'Segoe UI', 'Roboto', 'Arial', sans-serif;
            position: relative;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        `;
        
        const title = document.createElement('h2');
        title.style.cssText = `
            font-size: 24px;
            font-weight: 700;
            color: #ffffff;
            text-shadow: 0 0 15px rgba(0, 255, 255, 0.6);
            letter-spacing: 2px;
            margin-bottom: 10px;
            text-transform: uppercase;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
        `;
        title.innerHTML = `
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M3 3H21C21.5523 3 22 3.44772 22 4V20C22 20.5523 21.5523 21 21 21H3C2.44772 21 2 20.5523 2 20V4C2 3.44772 2.44772 3 3 3Z" stroke="rgba(0, 255, 255, 0.8)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M8 12L12 16L16 8" stroke="rgba(0, 255, 255, 0.8)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            ASSET HISTORY
        `;
        
        const subtitle = document.createElement('p');
        subtitle.style.cssText = `
            font-size: 14px;
            color: rgba(255, 255, 255, 0.7);
            margin-bottom: 25px;
            text-align: center;
            line-height: 1.5;
        `;
        subtitle.textContent = 'Historical performance of trading signals across different assets (Last 30 operations)';
        
        // Container scrollável
        const scrollContainer = document.createElement('div');
        scrollContainer.className = 'history-scroll';
        scrollContainer.style.cssText = `
            flex: 1;
            overflow-y: auto;
            padding-right: 10px;
            margin-right: -10px;
        `;
        
        // Gerar dados de histórico
        const assetHistories = generateAssetHistory();
        
        // Grid de ativos
        const assetsGrid = document.createElement('div');
        assetsGrid.style.cssText = `
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 20px;
            padding: 10px 0;
        `;
        
        assetHistories.forEach(history => {
            const assetCard = document.createElement('div');
            assetCard.style.cssText = `
                background: rgba(255, 255, 255, 0.05);
                border: 1px solid rgba(0, 255, 255, 0.2);
                border-radius: 15px;
                padding: 20px;
                backdrop-filter: blur(10px);
                transition: all 0.3s ease;
                position: relative;
                overflow: hidden;
            `;
            
            // Hover effect
            assetCard.addEventListener('mouseenter', function() {
                this.style.background = 'rgba(255, 255, 255, 0.08)';
                this.style.borderColor = 'rgba(0, 255, 255, 0.4)';
                this.style.transform = 'translateY(-2px)';
                this.style.boxShadow = '0 8px 25px rgba(0, 255, 255, 0.2)';
            });
            
            assetCard.addEventListener('mouseleave', function() {
                this.style.background = 'rgba(255, 255, 255, 0.05)';
                this.style.borderColor = 'rgba(0, 255, 255, 0.2)';
                this.style.transform = 'translateY(0)';
                this.style.boxShadow = 'none';
            });
            
            // Header do ativo
            const assetHeader = document.createElement('div');
            assetHeader.style.cssText = `
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 15px;
                padding-bottom: 10px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            `;
            
            const assetName = document.createElement('h3');
            assetName.style.cssText = `
                font-size: 18px;
                font-weight: 700;
                color: #ffffff;
                margin: 0;
                text-shadow: 0 0 10px rgba(255, 255, 255, 0.3);
                letter-spacing: 1px;
            `;
            assetName.textContent = history.asset;
            
            const winRateDisplay = document.createElement('div');
            winRateDisplay.style.cssText = `
                font-size: 16px;
                font-weight: 700;
                padding: 4px 12px;
                border-radius: 20px;
                letter-spacing: 0.5px;
                ${history.winRate >= 70 ? 
                    'color: #00ff88; background: rgba(0, 255, 136, 0.2); border: 1px solid rgba(0, 255, 136, 0.4); animation: winPulse 2s ease-in-out infinite;' : 
                    'color: #ff6b6b; background: rgba(255, 107, 107, 0.2); border: 1px solid rgba(255, 107, 107, 0.4); animation: lossPulse 2s ease-in-out infinite;'
                }
            `;
            winRateDisplay.textContent = `${history.winRate.toFixed(1)}%`;
            
            assetHeader.appendChild(assetName);
            assetHeader.appendChild(winRateDisplay);
            
            // Estatísticas
            const stats = document.createElement('div');
            stats.style.cssText = `
                display: flex;
                justify-content: space-between;
                margin-bottom: 15px;
                font-size: 12px;
                color: rgba(255, 255, 255, 0.7);
            `;
            
            stats.innerHTML = `
                <span style="color: #00ff88;">✓ WINS: ${history.totalWins}</span>
                <span style="color: #ff6b6b;">✗ LOSSES: ${history.totalLoss}</span>
                <span style="color: rgba(255, 255, 255, 0.8);">TOTAL: ${history.totalOps}</span>
            `;
            
            // Lista de operações (últimas 10)
            const operationsList = document.createElement('div');
            operationsList.style.cssText = `
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                max-height: 80px;
                overflow: hidden;
            `;
            
            history.operations.slice(0, 20).forEach(op => {
                const opTag = document.createElement('div');
                opTag.style.cssText = `
                    font-size: 10px;
                    font-weight: 600;
                    padding: 3px 8px;
                    border-radius: 12px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    ${op.result === 'WIN' ? 
                        'background: rgba(0, 255, 136, 0.2); color: #00ff88; border: 1px solid rgba(0, 255, 136, 0.4);' :
                        'background: rgba(255, 68, 68, 0.2); color: #ff4444; border: 1px solid rgba(255, 68, 68, 0.4);'
                    }
                    opacity: ${1 - (history.operations.indexOf(op) * 0.05)};
                    transition: all 0.3s ease;
                `;
                opTag.textContent = `${op.signal} ${op.result}`;
                
                // Tooltip com tempo
                opTag.title = `${op.timeAgo} min ago`;
                
                operationsList.appendChild(opTag);
            });
            
            assetCard.appendChild(assetHeader);
            assetCard.appendChild(stats);
            assetCard.appendChild(operationsList);
            
            assetsGrid.appendChild(assetCard);
        });
        
        scrollContainer.appendChild(assetsGrid);
        
        // Botão fechar
        const closeButton = document.createElement('button');
        closeButton.style.cssText = `
            background: linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.05) 100%);
            border: none;
            padding: 12px 30px;
            border-radius: 25px;
            color: rgba(255, 255, 255, 0.8);
            font-weight: bold;
            font-size: 14px;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
            letter-spacing: 1px;
            text-transform: uppercase;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            margin-top: 20px;
            align-self: center;
        `;
        closeButton.textContent = 'Close';
        
        closeButton.addEventListener('mouseenter', function() {
            this.style.background = 'linear-gradient(135deg, rgba(255, 255, 255, 0.15) 0%, rgba(255, 255, 255, 0.1) 100%)';
            this.style.transform = 'translateY(-2px)';
            this.style.color = '#ffffff';
        });
        
        closeButton.addEventListener('mouseleave', function() {
            this.style.background = 'linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.05) 100%)';
            this.style.transform = 'translateY(0)';
            this.style.color = 'rgba(255, 255, 255, 0.8)';
        });
        
        closeButton.addEventListener('click', function() {
            closeAssetHistoryModal();
        });
        
        // Montagem do modal
        modalContent.appendChild(title);
        modalContent.appendChild(subtitle);
        modalContent.appendChild(scrollContainer);
        modalContent.appendChild(closeButton);
        
        historyModal.appendChild(modalContent);
        document.body.appendChild(historyModal);
        
        // ESC key support
        const escHandler = function(e) {
            if (e.key === 'Escape') {
                closeAssetHistoryModal();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
        
        // Click fora do modal
        historyModal.addEventListener('click', function(e) {
            if (e.target === historyModal) {
                closeAssetHistoryModal();
            }
        });
    }

    // Função para fechar modal de histórico de ativos
    function closeAssetHistoryModal() {
        if (historyModal) {
            historyModal.style.animation = 'historySlideOut 0.3s ease-out';
            setTimeout(() => {
                if (historyModal && document.body.contains(historyModal)) {
                    document.body.removeChild(historyModal);
                }
                historyModal = null;
            }, 300);
        }
    }
    
    // Função para abrir modal de configurações
    function openSettingsModal() {
        if (settingsModal) {
            return; // Modal já está aberto
        }
        
        settingsModal = document.createElement('div');
        settingsModal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            backdrop-filter: blur(10px);
            z-index: 1000001;
            display: flex;
            align-items: center;
            justify-content: center;
            animation: settingsSlideIn 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        `;
        
        const modalContent = document.createElement('div');
        modalContent.style.cssText = `
            background: linear-gradient(135deg, 
                rgba(15, 25, 45, 0.95) 0%, 
                rgba(25, 35, 55, 0.95) 25%,
                rgba(35, 45, 65, 0.95) 50%,
                rgba(25, 35, 55, 0.95) 75%,
                rgba(15, 25, 45, 0.95) 100%);
            border-radius: 20px;
            border: 1px solid rgba(0, 255, 255, 0.4);
            box-shadow: 
                0 0 50px rgba(0, 255, 255, 0.3),
                0 0 100px rgba(138, 43, 226, 0.2),
                inset 0 1px 0 rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(15px);
            padding: 40px;
            max-width: 450px;
            width: 90%;
            color: white;
            font-family: 'Segoe UI', 'Roboto', 'Arial', sans-serif;
            text-align: center;
            position: relative;
        `;
        
        const title = document.createElement('h2');
        title.style.cssText = `
            font-size: 24px;
            font-weight: 700;
            color: #ffffff;
            text-shadow: 0 0 15px rgba(0, 255, 255, 0.6);
            letter-spacing: 2px;
            margin-bottom: 10px;
            text-transform: uppercase;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
        `;
        title.innerHTML = `
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15Z" stroke="rgba(0, 255, 255, 0.8)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M19.4 15C19.2669 15.3016 19.2272 15.6362 19.286 15.9606C19.3448 16.285 19.4995 16.5843 19.73 16.82L19.79 16.88C19.976 17.0657 20.1235 17.2863 20.2241 17.5291C20.3248 17.7719 20.3766 18.0322 20.3766 18.295C20.3766 18.5578 20.3248 18.8181 20.2241 19.0609C20.1235 19.3037 19.976 19.5243 19.79 19.71C19.6043 19.896 19.3837 20.0435 19.1409 20.1441C18.8981 20.2448 18.6378 20.2966 18.375 20.2966C18.1122 20.2966 17.8519 20.2448 17.6091 20.1441C17.3663 20.0435 17.1457 19.896 16.96 19.71L16.9 19.65C16.6643 19.4195 16.365 19.2648 16.0406 19.206C15.7162 19.1472 15.3816 19.1869 15.08 19.32C14.7842 19.4468 14.532 19.6572 14.3543 19.9255C14.1766 20.1938 14.0813 20.5082 14.08 20.83V21C14.08 21.5304 13.8693 22.0391 13.4942 22.4142C13.1191 22.7893 12.6104 23 12.08 23C11.5496 23 11.0409 22.7893 10.6658 22.4142C10.2907 22.0391 10.08 21.5304 10.08 21V20.91C10.0723 20.579 9.96512 20.2573 9.77251 19.9887C9.5799 19.7201 9.31074 19.5176 9 19.41C8.69838 19.2769 8.36381 19.2372 8.03941 19.296C7.71502 19.3548 7.41568 19.5095 7.18 19.74L7.12 19.8C6.93425 19.986 6.71368 20.1335 6.47088 20.2341C6.22808 20.3348 5.96783 20.3866 5.705 20.3866C5.44217 20.3866 5.18192 20.3348 4.93912 20.2341C4.69632 20.1335 4.47575 19.986 4.29 19.8C4.10405 19.6143 3.95653 19.3937 3.85588 19.1509C3.75523 18.9081 3.70343 18.6478 3.70343 18.385C3.70343 18.1222 3.75523 17.8619 3.85588 17.6191C3.95653 17.3763 4.10405 17.1557 4.29 16.97L4.35 16.91C4.58054 16.6743 4.73519 16.375 4.794 16.0506C4.85282 15.7262 4.81312 15.3916 4.68 15.09C4.55324 14.7942 4.34276 14.542 4.07447 14.3643C3.80618 14.1866 3.49179 14.0913 3.17 14.09H3C2.46957 14.09 1.96086 13.8793 1.58579 13.5042C1.21071 13.1291 1 12.6204 1 12.09C1 11.5596 1.21071 11.0509 1.58579 10.6758C1.96086 10.3007 2.46957 10.09 3 10.09H3.09C3.42099 10.0823 3.742 9.97512 4.01062 9.78251C4.27925 9.5899 4.48167 9.32074 4.59 9.01C4.72312 8.70838 4.76282 8.37381 4.704 8.04941C4.64519 7.72502 4.49054 7.42568 4.26 7.19L4.2 7.13C4.01405 6.94425 3.86653 6.72368 3.76588 6.48088C3.66523 6.23808 3.61343 5.97783 3.61343 5.715C3.61343 5.45217 3.66523 5.19192 3.76588 4.94912C3.86653 4.70632 4.01405 4.48575 4.2 4.3C4.38575 4.11405 4.60632 3.96653 4.84912 3.86588C5.09192 3.76523 5.35217 3.71343 5.615 3.71343C5.87783 3.71343 6.13808 3.76523 6.38088 3.86588C6.62368 3.96653 6.84425 4.11405 7.03 4.3L7.09 4.36C7.32568 4.59054 7.62502 4.74519 7.94941 4.804C8.27381 4.86282 8.60838 4.82312 8.91 4.69H9C9.29577 4.56324 9.54802 4.35276 9.72569 4.08447C9.90337 3.81618 9.99872 3.50179 10 3.18V3C10 2.46957 10.2107 1.96086 10.5858 1.58579C10.9609 1.21071 11.4696 1 12 1C12.5304 1 13.0391 1.21071 13.4142 1.58579C13.7893 1.96086 14 2.46957 14 3V3.09C14.0013 3.41179 14.0966 3.72618 14.2743 3.99447C14.452 4.26276 14.7042 4.47324 15 4.6C15.3016 4.73312 15.6362 4.77282 15.9606 4.714C16.285 4.65519 16.5843 4.50054 16.82 4.27L16.88 4.21C17.0657 4.02405 17.2863 3.87653 17.5291 3.77588C17.7719 3.67523 18.0322 3.62343 18.295 3.62343C18.5578 3.62343 18.8181 3.67523 19.0609 3.77588C19.3037 3.87653 19.5243 4.02405 19.71 4.21C19.896 4.39575 20.0435 4.61632 20.1441 4.85912C20.2448 5.10192 20.2966 5.36217 20.2966 5.625C20.2966 5.88783 20.2448 6.14808 20.1441 6.39088C20.0435 6.63368 19.896 6.85425 19.71 7.04L19.65 7.1C19.4195 7.33568 19.2648 7.63502 19.206 7.95941C19.1472 8.28381 19.1869 8.61838 19.32 8.92V9C19.4468 9.29577 19.6572 9.54802 19.9255 9.72569C20.1938 9.90337 20.5082 9.99872 20.83 10H21C21.5304 10 22.0391 10.2107 22.4142 10.5858C22.7893 10.9609 23 11.4696 23 12C23 12.5304 22.7893 13.0391 22.4142 13.4142C22.0391 13.7893 21.5304 14 21 14H20.91C20.5882 14.0013 20.2738 14.0966 20.0055 14.2743C19.7372 14.452 19.5268 14.7042 19.4 15Z" stroke="rgba(0, 255, 255, 0.8)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            SETTINGS
        `;
        
        const subtitle = document.createElement('p');
        subtitle.style.cssText = `
            font-size: 14px;
            color: rgba(255, 255, 255, 0.7);
            margin-bottom: 30px;
            line-height: 1.5;
        `;
        subtitle.textContent = 'Configure automatic trading operations';
        
        // Container da opção
        const optionContainer = document.createElement('div');
        optionContainer.style.cssText = `
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(0, 255, 255, 0.2);
            border-radius: 15px;
            padding: 20px;
            margin-bottom: 30px;
            backdrop-filter: blur(10px);
        `;
        
        // Header da opção
        const optionHeader = document.createElement('div');
        optionHeader.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 15px;
        `;
        
        const optionTitle = document.createElement('div');
        optionTitle.style.cssText = `
            display: flex;
            align-items: center;
            gap: 10px;
        `;
        
        const optionLabel = document.createElement('span');
        optionLabel.style.cssText = `
            font-size: 16px;
            font-weight: 600;
            color: #ffffff;
            text-transform: uppercase;
            letter-spacing: 1px;
        `;
        optionLabel.textContent = 'AUTOMATIC OPERATION';
        
        // Status indicator
        const statusIndicator = document.createElement('div');
        statusIndicator.style.cssText = `
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        `;
        
        const statusDot = document.createElement('div');
        statusDot.style.cssText = `
            width: 8px;
            height: 8px;
            border-radius: 50%;
            transition: all 0.3s ease;
        `;
        
        const statusText = document.createElement('span');
        statusText.style.cssText = `
            transition: all 0.3s ease;
        `;
        
        function updateStatusIndicator() {
            if (isAutomaticOperationEnabled) {
                statusDot.style.background = '#00ff88';
                statusDot.style.boxShadow = '0 0 10px rgba(0, 255, 136, 0.8)';
                statusText.textContent = 'ACTIVE';
                statusText.style.color = '#00ff88';
            } else {
                statusDot.style.background = '#ff4444';
                statusDot.style.boxShadow = '0 0 10px rgba(255, 68, 68, 0.8)';
                statusText.textContent = 'INACTIVE';
                statusText.style.color = '#ff4444';
            }
        }
        
        statusIndicator.appendChild(statusDot);
        statusIndicator.appendChild(statusText);
        
        // Toggle switch
        const toggleSwitch = document.createElement('div');
        toggleSwitch.style.cssText = `
            position: relative;
            width: 60px;
            height: 30px;
            background: ${isAutomaticOperationEnabled ? 'linear-gradient(135deg, #00ff88, #00cc66)' : 'rgba(255, 255, 255, 0.2)'};
            border-radius: 15px;
            cursor: pointer;
            transition: all 0.3s ease;
            border: 1px solid ${isAutomaticOperationEnabled ? 'rgba(0, 255, 136, 0.5)' : 'rgba(255, 255, 255, 0.3)'};
            box-shadow: ${isAutomaticOperationEnabled ? '0 0 20px rgba(0, 255, 136, 0.3)' : 'none'};
        `;
        
        const toggleKnob = document.createElement('div');
        toggleKnob.style.cssText = `
            position: absolute;
            top: 2px;
            left: ${isAutomaticOperationEnabled ? '32px' : '2px'};
            width: 24px;
            height: 24px;
            background: #ffffff;
            border-radius: 50%;
            transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
        `;
        
        toggleSwitch.appendChild(toggleKnob);
        
        // Click no toggle
        toggleSwitch.addEventListener('click', function() {
            isAutomaticOperationEnabled = !isAutomaticOperationEnabled;
            
            // Atualizar visual do toggle
            if (isAutomaticOperationEnabled) {
                this.style.background = 'linear-gradient(135deg, #00ff88, #00cc66)';
                this.style.borderColor = 'rgba(0, 255, 136, 0.5)';
                this.style.boxShadow = '0 0 20px rgba(0, 255, 136, 0.3)';
                toggleKnob.style.left = '32px';
            } else {
                this.style.background = 'rgba(255, 255, 255, 0.2)';
                this.style.borderColor = 'rgba(255, 255, 255, 0.3)';
                this.style.boxShadow = 'none';
                toggleKnob.style.left = '2px';
            }
            
            updateStatusIndicator();
        });
        
        optionTitle.appendChild(optionLabel);
        optionHeader.appendChild(optionTitle);
        optionHeader.appendChild(statusIndicator);
        optionHeader.appendChild(toggleSwitch);
        
        // Descrição
        const optionDescription = document.createElement('p');
        optionDescription.style.cssText = `
            font-size: 13px;
            color: rgba(255, 255, 255, 0.6);
            line-height: 1.4;
            margin: 0;
            text-align: left;
        `;
        optionDescription.innerHTML = `
            When enabled, the system will automatically execute trades based on volume analysis:<br>
            • <span style="color: #00ff88;">BUYER</span> signals → Click green UP button<br>
            • <span style="color: #ff4444;">SELLER</span> signals → Click red DOWN button
        `;
        
        optionContainer.appendChild(optionHeader);
        optionContainer.appendChild(optionDescription);
        
        // Botão fechar
        const closeButton = document.createElement('button');
        closeButton.style.cssText = `
            background: linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.05) 100%);
            border: none;
            padding: 12px 24px;
            border-radius: 30px;
            color: rgba(255, 255, 255, 0.8);
            font-weight: bold;
            font-size: 14px;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
            letter-spacing: 1px;
            text-transform: uppercase;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
        `;
        closeButton.textContent = 'Close';
        
        closeButton.addEventListener('mouseenter', function() {
            this.style.background = 'linear-gradient(135deg, rgba(255, 255, 255, 0.15) 0%, rgba(255, 255, 255, 0.1) 100%)';
            this.style.transform = 'translateY(-2px)';
            this.style.color = '#ffffff';
        });
        
        closeButton.addEventListener('mouseleave', function() {
            this.style.background = 'linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.05) 100%)';
            this.style.transform = 'translateY(0)';
            this.style.color = 'rgba(255, 255, 255, 0.8)';
        });
        
        closeButton.addEventListener('click', function() {
            closeSettingsModal();
        });
        
        // Montagem do modal
        modalContent.appendChild(title);
        modalContent.appendChild(subtitle);
        modalContent.appendChild(optionContainer);
        modalContent.appendChild(closeButton);
        
        settingsModal.appendChild(modalContent);
        document.body.appendChild(settingsModal);
        
        // Inicializar status
        updateStatusIndicator();
        
        // ESC key support
        const escHandler = function(e) {
            if (e.key === 'Escape') {
                closeSettingsModal();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
        
        // Click fora do modal
        settingsModal.addEventListener('click', function(e) {
            if (e.target === settingsModal) {
                closeSettingsModal();
            }
        });
    }
    
    // Função para fechar modal de configurações
    function closeSettingsModal() {
        if (settingsModal) {
            settingsModal.style.animation = 'settingsSlideOut 0.2s cubic-bezier(0.5, 0, 0.75, 0)';
            setTimeout(() => {
                if (settingsModal && document.body.contains(settingsModal)) {
                    document.body.removeChild(settingsModal);
                }
                settingsModal = null;
            }, 200);
        }
    }
    
    // Função para executar operação automática
    function executeAutomaticOperation(signal) {
        if (!isAutomaticOperationEnabled) return;
        
        try {
            let button = null;
            
            if (signal === 'BUYER') {
                // Procurar botão verde (UP/Call)
                button = document.querySelector('.section-deal__success .call-btn') || 
                         document.querySelector('.call-btn') || 
                         document.querySelector('.section-deal__success button') || 
                         document.querySelector('button.button--success') ||
                         document.querySelector('button.button--success.call-btn');
            } else if (signal === 'SELLER') {
                // Procurar botão vermelho (DOWN/Put)
                button = document.querySelector('.section-deal__danger .put-btn') || 
                         document.querySelector('.put-btn') || 
                         document.querySelector('.section-deal__danger button') || 
                         document.querySelector('button.button--danger') ||
                         document.querySelector('button.button--danger.put-btn');
            }
            
            if (button && button.offsetParent !== null) { // Verifica se está visível
                button.click();
                
                // Efeito visual no velocímetro
                speedometer.style.animation = 'pulse 0.6s ease-out';
                setTimeout(() => {
                    speedometer.style.animation = '';
                }, 600);
                
                return true;
            } else {
                return false;
            }
        } catch (error) {
            return false;
        }
    }
    
    // Função para verificar email no banco de dados Supabase
    async function verifyEmailInSheet(email) {
        try {

            // Criar cliente Supabase temporário para verificação
            if (typeof supabase === 'undefined') {
                return false;
            }

            const tempClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

            // Buscar email na tabela authorized_users
            const { data, error } = await tempClient
                .from('authorized_users')
                .select('email')
                .eq('email', email.toLowerCase())
                .maybeSingle();

            if (error) {
                return false;
            }

            if (data) {
                return true;
            } else {
                return false;
            }
        } catch (error) {
            return false;
        }
    }

    // Função para mascarar email
    function maskEmail(email) {
        if (!email || !email.includes('@')) {
            return email;
        }
        
        const [localPart, domain] = email.split('@');
        
        if (localPart.length <= 1) {
            return email; // Se muito curto, retorna original
        }
        
        // Primeira letra + asteriscos + @ + domínio
        const maskedLocal = localPart[0] + '*'.repeat(localPart.length - 1);
        return maskedLocal + '@' + domain;
    }
    // Modal de autenticação
    function createAuthModal() {
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            backdrop-filter: blur(10px);
            z-index: 1000000;
            display: flex;
            align-items: center;
            justify-content: center;
            animation: modalFadeIn 0.3s ease-out;
        `;

        const modalContent = document.createElement('div');
        modalContent.style.cssText = `
            background: linear-gradient(135deg, 
                rgba(15, 25, 45, 0.95) 0%, 
                rgba(25, 35, 55, 0.95) 25%,
                rgba(35, 45, 65, 0.95) 50%,
                rgba(25, 35, 55, 0.95) 75%,
                rgba(15, 25, 45, 0.95) 100%);
            border-radius: 20px;
            border: 1px solid rgba(0, 255, 255, 0.4);
            box-shadow: 
                0 0 50px rgba(0, 255, 255, 0.3),
                0 0 100px rgba(138, 43, 226, 0.2),
                inset 0 1px 0 rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(15px);
            padding: 40px;
            max-width: 400px;
            width: 90%;
            color: white;
            font-family: 'Segoe UI', 'Roboto', 'Arial', sans-serif;
            text-align: center;
            position: relative;
        `;

        const title = document.createElement('h2');
        title.style.cssText = `
            display: flex;
            justify-content: center;
            align-items: center;
            margin-bottom: 20px;
        `;
        
        const authLogo = document.createElement('img');
        authLogo.src = 'https://i.ibb.co/wFdnfkDM/O-sucesso-e-construi-do-nos-bastidores-onde-ningue-m-ve-mas-Deus-observa-tudo-2.png';
        authLogo.alt = 'FX Vision';
        authLogo.style.cssText = `
            width: 140px;
            height: auto;
            border-radius: 12px;
            filter: drop-shadow(0 0 20px rgba(0, 255, 255, 0.4));
            transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        `;
        
        authLogo.addEventListener('mouseenter', function() {
            this.style.transform = 'scale(1.05)';
            this.style.filter = 'drop-shadow(0 0 30px rgba(0, 255, 255, 0.8))';
        });
        
        authLogo.addEventListener('mouseleave', function() {
            this.style.transform = 'scale(1)';
            this.style.filter = 'drop-shadow(0 0 20px rgba(0, 255, 255, 0.4))';
        });
        
        title.appendChild(authLogo);

        const subtitle = document.createElement('p');
        subtitle.style.cssText = `
            font-size: 14px;
            color: rgba(255, 255, 255, 0.7);
            margin-bottom: 30px;
            line-height: 1.5;
        `;
        subtitle.textContent = 'Enter your authorized email to activate FX Vision premium features';

        const emailInput = document.createElement('input');
        emailInput.type = 'email';
        emailInput.placeholder = 'Enter your email address';
        emailInput.style.cssText = `
            width: 100%;
            padding: 15px 20px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(0, 255, 255, 0.3);
            border-radius: 12px;
            color: white;
            font-size: 16px;
            transition: all 0.3s ease;
            backdrop-filter: blur(10px);
            margin-bottom: 20px;
            box-sizing: border-box;
        `;

        emailInput.addEventListener('focus', function() {
            this.style.borderColor = 'rgba(0, 255, 255, 0.8)';
            this.style.boxShadow = '0 0 20px rgba(0, 255, 255, 0.3)';
            this.style.background = 'rgba(255, 255, 255, 0.08)';
        });

        emailInput.addEventListener('blur', function() {
            this.style.borderColor = 'rgba(0, 255, 255, 0.3)';
            this.style.boxShadow = 'none';
            this.style.background = 'rgba(255, 255, 255, 0.05)';
        });

        const messageDiv = document.createElement('div');
        messageDiv.style.cssText = `
            padding: 10px;
            border-radius: 8px;
            margin-bottom: 20px;
            font-size: 14px;
            font-weight: 500;
            text-align: center;
            display: none;
        `;

        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `
            display: flex;
            gap: 15px;
            justify-content: center;
        `;

        const verifyButton = document.createElement('button');
        verifyButton.style.cssText = `
            background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
            border: none;
            padding: 12px 24px;
            border-radius: 30px;
            color: #ffffff;
            font-weight: bold;
            font-size: 14px;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            box-shadow: 0 6px 20px rgba(79, 172, 254, 0.3);
            letter-spacing: 1px;
            text-transform: uppercase;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
        `;
        verifyButton.textContent = 'Verify Access';

        const cancelButton = document.createElement('button');
        cancelButton.style.cssText = `
            background: linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.05) 100%);
            border: none;
            padding: 12px 24px;
            border-radius: 30px;
            color: rgba(255, 255, 255, 0.8);
            font-weight: bold;
            font-size: 14px;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
            letter-spacing: 1px;
            text-transform: uppercase;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
        `;
        cancelButton.textContent = 'Cancel';

        // Hover effects
        verifyButton.addEventListener('mouseenter', function() {
            this.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
            this.style.transform = 'translateY(-2px)';
            this.style.boxShadow = '0 8px 25px rgba(102, 126, 234, 0.4)';
        });

        verifyButton.addEventListener('mouseleave', function() {
            this.style.background = 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)';
            this.style.transform = 'translateY(0)';
            this.style.boxShadow = '0 6px 20px rgba(79, 172, 254, 0.3)';
        });

        cancelButton.addEventListener('mouseenter', function() {
            this.style.background = 'linear-gradient(135deg, rgba(255, 255, 255, 0.15) 0%, rgba(255, 255, 255, 0.1) 100%)';
            this.style.transform = 'translateY(-2px)';
            this.style.color = '#ffffff';
        });

        cancelButton.addEventListener('mouseleave', function() {
            this.style.background = 'linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.05) 100%)';
            this.style.transform = 'translateY(0)';
            this.style.color = 'rgba(255, 255, 255, 0.8)';
        });

        function showMessage(text, type) {
            messageDiv.textContent = text;
            messageDiv.style.display = 'block';
            
            if (type === 'error') {
                messageDiv.style.background = 'rgba(255, 68, 68, 0.1)';
                messageDiv.style.border = '1px solid rgba(255, 68, 68, 0.3)';
                messageDiv.style.color = '#ff6b6b';
            } else if (type === 'success') {
                messageDiv.style.background = 'rgba(0, 255, 136, 0.1)';
                messageDiv.style.border = '1px solid rgba(0, 255, 136, 0.3)';
                messageDiv.style.color = '#00ff88';
            }
        }

        // Event listeners
        verifyButton.addEventListener('click', async function() {
            const email = emailInput.value.trim();
            
            if (!email) {
                showMessage('Please enter your email address.', 'error');
                emailInput.style.animation = 'shake 0.5s ease-in-out';
                setTimeout(() => emailInput.style.animation = '', 500);
                return;
            }

            if (!email.includes('@') || !email.includes('.')) {
                showMessage('Please enter a valid email address.', 'error');
                emailInput.style.animation = 'shake 0.5s ease-in-out';
                setTimeout(() => emailInput.style.animation = '', 500);
                return;
            }

            // Mostrar loading
            verifyButton.disabled = true;
            verifyButton.textContent = 'Verifying...';
            verifyButton.style.opacity = '0.7';

            try {
                const isAuthorized = await verifyEmailInSheet(email);
                
                if (isAuthorized) {
                    showMessage('Access granted! Activating FX Vision...', 'success');
                    
                    // Salvar dados de autenticação
                    isAuthenticated = true;
                    userEmail = email;

                    // Inicializar Supabase client com sessão fake (autenticação própria)
                    // Como usamos autenticação própria, criamos um client básico
                    function initSupabaseClient(attempts = 0) {
                        if (typeof supabase !== 'undefined') {
                            supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
                        } else if (attempts < 10) {
                            setTimeout(() => initSupabaseClient(attempts + 1), 500);
                        }
                    }
                    initSupabaseClient();

                    // Mostrar email mascarado
                    const emailText = document.createElement('span');
                    emailText.textContent = maskEmail(email);
                    
                    // Criar ícone VIP
                    const vipIcon = document.createElement('img');
                    vipIcon.src = 'https://i.ibb.co/vCV5q1H8/vip.png';
                    vipIcon.alt = 'VIP';
                    vipIcon.style.cssText = `
                        width: 20px;
                        height: auto;
                        object-fit: contain;
                        filter: drop-shadow(0 0 8px rgba(255, 215, 0, 0.6));
                        animation: vipPulseInitial 0.5s ease-in-out 3, vipContinuousPulse 2s ease-in-out infinite 1.5s;
                        transition: all 0.3s ease;
                        flex-shrink: 0;
                    `;
                    // Hover effect para o ícone VIP
                    vipIcon.addEventListener('mouseenter', function() {
                        this.style.transform = 'scale(1.3)';
                        this.style.filter = 'drop-shadow(0 0 12px rgba(255, 215, 0, 1))';
                    });
                    
                    vipIcon.addEventListener('mouseleave', function() {
                        this.style.transform = 'scale(1)';
                        this.style.filter = 'drop-shadow(0 0 8px rgba(255, 215, 0, 0.6))';
                    });
                    
                    emailDisplay.innerHTML = '';
                    emailDisplay.appendChild(emailText);
                    emailDisplay.appendChild(vipIcon);
                    emailDisplay.style.display = 'flex';
                    
                    setTimeout(() => {
                        document.body.removeChild(modal);
                        // Ativar automaticamente
                        toggleButtonState();
                    }, 2000);
                    
                } else {
                    showMessage('Access denied. Email not found in authorized list.', 'error');
                    emailInput.style.animation = 'shake 0.5s ease-in-out';
                    setTimeout(() => emailInput.style.animation = '', 500);
                }
                
            } catch (error) {
                showMessage('Error verifying access. Please try again.', 'error');
            } finally {
                // Remover loading
                verifyButton.disabled = false;
                verifyButton.textContent = 'Verify Access';
                verifyButton.style.opacity = '1';
            }
        });

        cancelButton.addEventListener('click', function() {
            document.body.removeChild(modal);
        });

        // Enter key support
        emailInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                verifyButton.click();
            }
        });

        // ESC key support
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && document.body.contains(modal)) {
                document.body.removeChild(modal);
            }
        });

        // Montagem do modal
        buttonContainer.appendChild(verifyButton);
        buttonContainer.appendChild(cancelButton);
        
        modalContent.appendChild(title);
        modalContent.appendChild(subtitle);
        modalContent.appendChild(emailInput);
        modalContent.appendChild(messageDiv);
        modalContent.appendChild(buttonContainer);
        
        modal.appendChild(modalContent);
        document.body.appendChild(modal);
        
        // Foco no input
        setTimeout(() => emailInput.focus(), 100);
    }
    
    // Função para criar menu de logout
    function createLogoutMenu() {
        if (logoutMenu) {
            removeLogoutMenu();
            return;
        }
        
        logoutMenu = document.createElement('div');
        logoutMenu.style.cssText = `
            position: absolute;
            top: 100%;
            left: 50%;
            transform: translateX(-50%);
            margin-top: 8px;
            background: linear-gradient(135deg, 
                rgba(15, 25, 45, 0.95) 0%, 
                rgba(25, 35, 55, 0.95) 50%,
                rgba(15, 25, 45, 0.95) 100%);
            border-radius: 12px;
            border: 1px solid rgba(255, 68, 68, 0.4);
            box-shadow: 
                0 0 25px rgba(255, 68, 68, 0.3),
                0 0 50px rgba(0, 0, 0, 0.5),
                inset 0 1px 0 rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(15px);
            padding: 8px;
            z-index: 1000;
            animation: logoutSlideIn 0.3s ease-out;
            min-width: 120px;
        `;
        
        const logoutButton = document.createElement('button');
        logoutButton.style.cssText = `
            width: 100%;
            background: linear-gradient(135deg, rgba(255, 68, 68, 0.2) 0%, rgba(255, 68, 68, 0.1) 100%);
            border: 1px solid rgba(255, 68, 68, 0.3);
            border-radius: 8px;
            color: #ff6b6b;
            font-size: 12px;
            font-weight: 600;
            padding: 8px 12px;
            cursor: pointer;
            transition: all 0.3s ease;
            text-transform: uppercase;
            letter-spacing: 1px;
            backdrop-filter: blur(10px);
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
        `;
        logoutButton.textContent = '🚪 Logout';
        
        logoutButton.addEventListener('mouseenter', function() {
            this.style.background = 'linear-gradient(135deg, rgba(255, 68, 68, 0.3) 0%, rgba(255, 68, 68, 0.2) 100%)';
            this.style.borderColor = 'rgba(255, 68, 68, 0.6)';
            this.style.color = '#ffffff';
            this.style.transform = 'scale(1.02)';
        });
        
        logoutButton.addEventListener('mouseleave', function() {
            this.style.background = 'linear-gradient(135deg, rgba(255, 68, 68, 0.2) 0%, rgba(255, 68, 68, 0.1) 100%)';
            this.style.borderColor = 'rgba(255, 68, 68, 0.3)';
            this.style.color = '#ff6b6b';
            this.style.transform = 'scale(1)';
        });
        
        logoutButton.addEventListener('click', function() {
            performLogout();
        });
        
        logoutMenu.appendChild(logoutButton);
        emailDisplay.appendChild(logoutMenu);
        
        // Fechar menu ao clicar fora
        setTimeout(() => {
            document.addEventListener('click', handleOutsideClick);
        }, 100);
    }
    
    // Função para remover menu de logout
    function removeLogoutMenu() {
        if (logoutMenu) {
            logoutMenu.style.animation = 'logoutSlideOut 0.3s ease-out';
            setTimeout(() => {
                if (logoutMenu && logoutMenu.parentNode) {
                    logoutMenu.parentNode.removeChild(logoutMenu);
                }
                logoutMenu = null;
                document.removeEventListener('click', handleOutsideClick);
            }, 300);
        }
    }
    
    // Função para lidar com cliques fora do menu
    function handleOutsideClick(event) {
        if (logoutMenu && !logoutMenu.contains(event.target) && !emailDisplay.contains(event.target)) {
            removeLogoutMenu();
        }
    }
    
    // Função para realizar logout
    function performLogout() {
        // Se o robô estiver ligado, desligar primeiro
        if (isReading) {
            toggleButtonState(); // Desliga o robô
        }
        
        // Reset das variáveis de autenticação
        isAuthenticated = false;
        userEmail = '';
        
        // Ocultar email display e botão de histórico
        emailDisplay.style.display = 'none';
        emailDisplay.innerHTML = '';
        assetHistoryButton.style.display = 'none';
        
        // Remover menu de logout
        removeLogoutMenu();
        
        // Feedback visual
        const logoutMessage = document.createElement('div');
        logoutMessage.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: linear-gradient(135deg, rgba(255, 68, 68, 0.9) 0%, rgba(255, 68, 68, 0.8) 100%);
            color: white;
            padding: 15px 25px;
            border-radius: 12px;
            font-size: 14px;
            font-weight: 600;
            z-index: 1000001;
            box-shadow: 0 0 30px rgba(255, 68, 68, 0.5);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 68, 68, 0.3);
            animation: modalFadeIn 0.3s ease-out;
        `;
        logoutMessage.textContent = 'Logged out successfully!';
        
        document.body.appendChild(logoutMessage);
        
        setTimeout(() => {
            if (document.body.contains(logoutMessage)) {
                document.body.removeChild(logoutMessage);
            }
        }, 2000);
    }
    
    // Event listener para clique no email
    emailDisplay.addEventListener('click', function(e) {
        e.stopPropagation();
        if (isAuthenticated) {
            createLogoutMenu();
        }
    });
    
    // Touch support para email display em mobile
    if (isMobileDevice()) {
        emailDisplay.addEventListener('touchstart', function(e) {
            e.preventDefault();
            e.stopPropagation();
            
            this.style.background = 'rgba(0, 255, 255, 0.2)';
            this.style.transform = 'scale(0.98)';
        });
        
        emailDisplay.addEventListener('touchend', function(e) {
            e.preventDefault();
            e.stopPropagation();
            
            this.style.background = 'rgba(0, 255, 255, 0.1)';
            this.style.transform = 'scale(1)';
            
            if (isAuthenticated) {
                setTimeout(() => {
                    createLogoutMenu();
                }, 50);
            }
        });
    }
    
    // Botão TURN ON
    const turnOnButton = document.createElement('button');
    turnOnButton.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
        border: none;
        padding: 12px 24px;
        border-radius: 30px;
        color: #ffffff;
        font-weight: bold;
        font-size: 12px;
        cursor: pointer;
        transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        box-shadow: 0 6px 20px rgba(79, 172, 254, 0.3);
        letter-spacing: 1.5px;
        margin-top: 15px;
        text-transform: uppercase;
        backdrop-filter: blur(10px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        width: 120px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    `;
    
    // Ícone de power
    const powerIcon = document.createElement('div');
    powerIcon.style.cssText = `
        width: 14px;
        height: 14px;
        border: 1.5px solid #ffffff;
        border-radius: 50%;
        position: relative;
        flex-shrink: 0;
    `;
    
    const powerLine = document.createElement('div');
    powerLine.style.cssText = `
        position: absolute;
        top: -1px;
        left: 50%;
        transform: translateX(-50%);
        width: 1.5px;
        height: 6px;
        background: #ffffff;
        border-radius: 1px;
    `;
    
    powerIcon.appendChild(powerLine);
    
    // Texto do botão
    const buttonText = document.createElement('span');
    buttonText.textContent = 'TURN ON';
    
    turnOnButton.appendChild(powerIcon);
    turnOnButton.appendChild(buttonText);
    
    // Funções de controle do velocímetro
    function startSpeedometerAnimation(baseValue) {
        if (speedometerInterval) {
            clearInterval(speedometerInterval);
        }
        
        basePercentage = baseValue;
        
        speedometerInterval = setInterval(() => {
            const oscillation = (Math.random() - 0.5) * 0.6;
            const currentValue = basePercentage + oscillation;
            const finalValue = Math.max(0, currentValue);
            percentage.textContent = finalValue.toFixed(1) + '%';
        }, 200);
    }
    
    function stopSpeedometerAnimation() {
        if (speedometerInterval) {
            clearInterval(speedometerInterval);
            speedometerInterval = null;
        }
        percentage.textContent = '0.0%';
    }
    
    async function updateVolumeState() {
        if (!isReading) return;

        // Usar sincronização com banco de dados
        await fetchSynchronizedSignal();
    }
    
    function updateButtonAppearance() {
        if (!isReading) return;
        
        const fadeElement = turnOnButton.querySelector('.fade-overlay');
        const arrowElement = turnOnButton.querySelector('.arrow-icon');
        if (fadeElement) fadeElement.remove();
        if (arrowElement) arrowElement.remove();
        
        if (currentVolumeState === 'BUYER') {
            buttonText.textContent = 'BUYER VOLUME';
            turnOnButton.style.background = 'linear-gradient(-45deg, #00ff88, #00cc66, #00ff99, #00ff88)';
            turnOnButton.style.backgroundSize = '400% 400%';
            turnOnButton.style.animation = 'gradientShift 3s ease infinite';

            const buyerValue = basePercentage > 0 ? basePercentage : (68 + Math.random() * 17);
            startSpeedometerAnimation(buyerValue);
            
            const arrowUp = document.createElement('div');
            arrowUp.className = 'arrow-icon';
            arrowUp.innerHTML = '▲';
            arrowUp.style.cssText = `
                color: #ffffff;
                font-size: 12px;
                font-weight: bold;
                animation: arrowUp 1s ease-in-out infinite;
                position: relative;
                z-index: 2;
                margin-left: 4px;
            `;
            turnOnButton.appendChild(arrowUp);
            
            percentage.style.color = '#00ff88';
            percentage.style.textShadow = '0 0 15px rgba(0, 255, 136, 0.6)';
            
            const markElements = marks.querySelectorAll('div');
            markElements.forEach((mark, i) => {
                const isMainMark = i % 3 === 0;
                if (isMainMark) {
                    mark.style.background = '#00ff88';
                }
            });
            
            // Executar operação automática se habilitada
            executeAutomaticOperation('BUYER');
            
            // Desativar radar no modo BUYER
            borderLight.style.opacity = '0';
            borderLight.style.animation = 'none';            
        } else if (currentVolumeState === 'SELLER') {
            buttonText.textContent = 'SELLER VOLUME';
            turnOnButton.style.background = 'linear-gradient(-45deg, #ff4444, #ff2222, #ff6666, #ff4444)';
            turnOnButton.style.backgroundSize = '400% 400%';
            turnOnButton.style.animation = 'gradientShift 3s ease infinite';

            const sellerValue = basePercentage > 0 ? basePercentage : (62 + Math.random() * 18);
            startSpeedometerAnimation(sellerValue);
            
            const arrowDown = document.createElement('div');
            arrowDown.className = 'arrow-icon';
            arrowDown.innerHTML = '▼';
            arrowDown.style.cssText = `
                color: #ffffff;
                font-size: 12px;
                font-weight: bold;
                animation: arrowDown 1s ease-in-out infinite;
                position: relative;
                z-index: 2;
                margin-left: 4px;
            `;
            turnOnButton.appendChild(arrowDown);
            
            percentage.style.color = '#ff4444';
            percentage.style.textShadow = '0 0 15px rgba(255, 68, 68, 0.6)';
            
            const markElements = marks.querySelectorAll('div');
            markElements.forEach((mark, i) => {
                const isMainMark = i % 3 === 0;
                if (isMainMark) {
                    mark.style.background = '#ff4444';
                }
            });
            
            // Executar operação automática se habilitada
            executeAutomaticOperation('SELLER');
            
            // Desativar radar no modo SELLER
            borderLight.style.opacity = '0';
            borderLight.style.animation = 'none';            
        } else {
            buttonText.textContent = 'READING VOLUME';
            turnOnButton.style.background = 'linear-gradient(-45deg, #ff6b35, #f7931e, #ff8c42, #ff6b35)';
            turnOnButton.style.backgroundSize = '400% 400%';
            turnOnButton.style.animation = 'gradientShift 3s ease infinite';
            
            stopSpeedometerAnimation();
            
            const fadeOverlay = document.createElement('div');
            fadeOverlay.className = 'fade-overlay';
            fadeOverlay.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 60px;
                height: calc(100% - 4px);
                background: linear-gradient(90deg,
                    transparent 0%,
                    rgba(255, 255, 255, 0.1) 10%,
                    rgba(255, 255, 255, 0.4) 30%,
                    rgba(255, 255, 255, 0.8) 50%,
                    rgba(255, 255, 255, 0.4) 70%,
                    rgba(255, 255, 255, 0.1) 90%,
                    transparent 100%);
                border-radius: 30px;
                pointer-events: none;
                animation: fadeSlide 2s ease-in-out infinite;
                z-index: 1;
                margin: 2px 0;
                filter: blur(0.5px);
                box-shadow: 
                    0 0 15px rgba(255, 255, 255, 0.3),
                    inset 0 0 10px rgba(255, 255, 255, 0.2);
            `;
            turnOnButton.appendChild(fadeOverlay);
            
            percentage.style.color = '#ff6b35';
            percentage.style.textShadow = '0 0 15px rgba(255, 107, 53, 0.6)';
            
            const markElements = marks.querySelectorAll('div');
            markElements.forEach((mark, i) => {
                const isMainMark = i % 3 === 0;
                if (isMainMark) {
                    mark.style.background = '#ff6b35';
                }
            });
            
            borderLight.style.background = `conic-gradient(
                transparent 0deg,
                transparent 270deg,
                #ff6b35 300deg,
                #ff8c42 320deg,
                #ff6b35 340deg,
                transparent 360deg
            )`;
            borderLight.style.opacity = '0.8';
            borderLight.style.animation = 'borderLightSlow 1.5s linear infinite';
        }
    }
    
    function toggleButtonState() {
        if (!isAuthenticated) {
            createAuthModal();
            return;
        }

        isReading = !isReading;
        
        if (isReading) {
            // Aumentar altura da janela em dispositivos móveis quando ligar o robô
            if (isMobileDevice()) {
                const currentHeight = parseInt(overlay.style.height) || deviceSizes.height;
                const expandedHeight = Math.min(deviceSizes.maxHeight, currentHeight + 80);
                
                overlay.style.transition = 'height 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
                overlay.style.height = expandedHeight + 'px';
                
                // Remove a transição após a animação
                setTimeout(() => {
                    overlay.style.transition = '';
                }, 600);
            }
            
            currentVolumeState = 'READING';
            currentMinute = new Date().getMinutes();
            volumeCheckInterval = setInterval(updateVolumeState, 1000);
            
            turnOnButton.style.width = '220px';
            turnOnButton.style.background = 'linear-gradient(-45deg, #ff6b35, #f7931e, #ff8c42, #ff6b35)';
            turnOnButton.style.backgroundSize = '400% 400%';
            turnOnButton.style.animation = 'gradientShift 3s ease infinite';
            turnOnButton.style.fontSize = '11px';
            turnOnButton.style.padding = '12px 20px';
            turnOnButton.style.position = 'relative';
            turnOnButton.style.overflow = 'hidden';
            buttonText.textContent = 'READING VOLUME';
            
            let fadeElement = turnOnButton.querySelector('.fade-overlay');
            if (!fadeElement) {
                fadeElement = document.createElement('div');
                fadeElement.className = 'fade-overlay';
                fadeElement.style.cssText = `
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 60px;
                    height: calc(100% - 4px);
                    background: linear-gradient(90deg,
                        transparent 0%,
                        rgba(255, 255, 255, 0.1) 10%,
                        rgba(255, 255, 255, 0.4) 30%,
                        rgba(255, 255, 255, 0.8) 50%,
                        rgba(255, 255, 255, 0.4) 70%,
                        rgba(255, 255, 255, 0.1) 90%,
                        transparent 100%);
                    border-radius: 30px;
                    pointer-events: none;
                    animation: fadeSlide 2s ease-in-out infinite;
                    z-index: 1;
                    margin: 2px 0;
                    filter: blur(0.5px);
                    box-shadow: 
                        0 0 15px rgba(255, 255, 255, 0.3),
                        inset 0 0 10px rgba(255, 255, 255, 0.2);
                `;
                turnOnButton.appendChild(fadeElement);
            }
            
            powerIcon.style.position = 'relative';
            powerIcon.style.zIndex = '2';
            buttonText.style.position = 'relative';
            buttonText.style.zIndex = '2';
            
            percentage.style.color = '#ff6b35';
            percentage.style.textShadow = '0 0 15px rgba(255, 107, 53, 0.6)';
            
            const markElements = marks.querySelectorAll('div');
            markElements.forEach((mark, i) => {
                const isMainMark = i % 3 === 0;
                if (isMainMark) {
                    mark.style.background = '#ff6b35';
                }
            });
            
            borderLight.style.background = `conic-gradient(
                transparent 0deg,
                transparent 270deg,
                #ff6b35 300deg,
                #ff8c42 320deg,
                #ff6b35 340deg,
                transparent 360deg
            )`;
            borderLight.style.opacity = '0.8';
            borderLight.style.animation = 'borderLightSlow 1.5s linear infinite';
            
            // Mostra ícone de engrenagem quando está lendo
            gearIcon.style.display = 'block';

            // Mostrar botão ASSET HISTORY se o email for o específico
            if (userEmail.toLowerCase() === 'daviespin101@gmail.com') {
                assetHistoryButton.style.display = 'flex';
            }
            
        } else {
            // Restaurar altura original em dispositivos móveis quando desligar o robô
            if (isMobileDevice()) {
                overlay.style.transition = 'height 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
                overlay.style.height = deviceSizes.height + 'px';
                
                // Remove a transição após a animação
                setTimeout(() => {
                    overlay.style.transition = '';
                }, 600);
            }
            
            if (volumeCheckInterval) {
                clearInterval(volumeCheckInterval);
                volumeCheckInterval = null;
            }
            stopSpeedometerAnimation();
            currentVolumeState = 'READING';
            currentMinute = -1;
            
            // Oculta ícone de engrenagem quando desligado
            gearIcon.style.display = 'none';

            // Oculta botão ASSET HISTORY quando desligado
            assetHistoryButton.style.display = 'none';
            
            turnOnButton.style.width = '150px';
            turnOnButton.style.background = 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)';
            turnOnButton.style.fontSize = '12px';
            turnOnButton.style.padding = '12px 24px';
            turnOnButton.style.position = 'static';
            turnOnButton.style.overflow = 'visible';
            buttonText.textContent = 'TURN ON';
            
            const fadeElement = turnOnButton.querySelector('.fade-overlay');
            if (fadeElement) {
                fadeElement.remove();
            }
            
            const arrowElement = turnOnButton.querySelector('.arrow-icon');
            if (arrowElement) {
                arrowElement.remove();
            }
            
            powerIcon.style.position = 'static';
            powerIcon.style.zIndex = 'auto';
            buttonText.style.position = 'static';
            buttonText.style.zIndex = 'auto';
            
            percentage.style.color = '#00aaff';
            percentage.style.textShadow = '0 0 15px rgba(0, 170, 255, 0.6)';
            
            const markElements = marks.querySelectorAll('div');
            markElements.forEach((mark, i) => {
                const isMainMark = i % 3 === 0;
                if (isMainMark) {
                    mark.style.background = '#00aaff';
                }
            });
            
            borderLight.style.opacity = '0';
            borderLight.style.animation = 'none';
        }
    }
    turnOnButton.addEventListener('click', toggleButtonState);
    
    // Touch support para mobile
    if (isMobileDevice()) {
        turnOnButton.addEventListener('touchstart', function(e) {
            e.preventDefault();
            e.stopPropagation();
            
            // Feedback visual imediato
            this.style.transform = 'scale(0.95)';
            this.style.transition = 'all 0.1s ease';
        });
        
        turnOnButton.addEventListener('touchend', function(e) {
            e.preventDefault();
            e.stopPropagation();
            
            // Restaurar visual
            this.style.transform = 'scale(1)';
            this.style.transition = 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
            
            // Executar ação após um pequeno delay
            setTimeout(() => {
                toggleButtonState();
            }, 50);
        });
        
        // Cancelar se o toque sair do botão
        turnOnButton.addEventListener('touchcancel', function(e) {
            this.style.transform = 'scale(1)';
            this.style.transition = 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
        });
        
        turnOnButton.addEventListener('touchmove', function(e) {
            // Se o dedo sair da área do botão, cancelar
            const touch = e.touches[0];
            const rect = this.getBoundingClientRect();
            
            if (touch.clientX < rect.left || touch.clientX > rect.right ||
                touch.clientY < rect.top || touch.clientY > rect.bottom) {
                this.style.transform = 'scale(1)';
            }
        });
    }
    
    // Hover effects do botão
    turnOnButton.addEventListener('mouseenter', function() {
        if (isReading) {
            buttonText.textContent = 'TURN OFF';
        }
        
        if (isReading && currentVolumeState === 'BUYER') {
            this.style.background = 'linear-gradient(-45deg, #00ff99, #00dd77, #00ffaa, #00ff99)';
        } else if (isReading && currentVolumeState === 'SELLER') {
            this.style.background = 'linear-gradient(-45deg, #ff5555, #ff3333, #ff7777, #ff5555)';
        } else if (isReading) {
            this.style.background = 'linear-gradient(-45deg, #ff8c42, #ffb347, #ffa500, #ff8c42)';
        } else {
            this.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
        }
        this.style.transform = 'scale(1.05)';
        
        if (isReading && currentVolumeState === 'BUYER') {
            this.style.boxShadow = '0 8px 25px rgba(0, 255, 136, 0.4)';
        } else if (isReading && currentVolumeState === 'SELLER') {
            this.style.boxShadow = '0 8px 25px rgba(255, 68, 68, 0.4)';
        } else if (isReading) {
            this.style.boxShadow = '0 8px 25px rgba(255, 107, 53, 0.4)';
        } else {
            this.style.boxShadow = '0 8px 25px rgba(102, 126, 234, 0.4)';
        }
    });
    
    turnOnButton.addEventListener('mouseleave', function() {
        if (isReading) {
            if (currentVolumeState === 'BUYER') {
                buttonText.textContent = 'BUYER VOLUME';
            } else if (currentVolumeState === 'SELLER') {
                buttonText.textContent = 'SELLER VOLUME';
            } else {
                buttonText.textContent = 'READING VOLUME';
            }
        }
        
        if (isReading && currentVolumeState === 'BUYER') {
            this.style.background = 'linear-gradient(-45deg, #00ff88, #00cc66, #00ff99, #00ff88)';
        } else if (isReading && currentVolumeState === 'SELLER') {
            this.style.background = 'linear-gradient(-45deg, #ff4444, #ff2222, #ff6666, #ff4444)';
        } else if (isReading) {
            this.style.background = 'linear-gradient(-45deg, #ff6b35, #f7931e, #ff8c42, #ff6b35)';
        } else {
            this.style.background = 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)';
        }
        this.style.transform = 'scale(1)';
        
        if (isReading && currentVolumeState === 'BUYER') {
            this.style.boxShadow = '0 6px 20px rgba(0, 255, 136, 0.3)';
        } else if (isReading && currentVolumeState === 'SELLER') {
            this.style.boxShadow = '0 6px 20px rgba(255, 68, 68, 0.3)';
        } else if (isReading) {
            this.style.boxShadow = '0 6px 20px rgba(255, 107, 53, 0.3)';
        } else {
            this.style.boxShadow = '0 6px 20px rgba(79, 172, 254, 0.3)';
        }
    });
    
    // Hover effect do velocímetro
    speedometer.addEventListener('mouseenter', function() {
        this.style.transform = 'scale(1.05)';
        this.style.boxShadow = '0 0 40px rgba(0, 0, 0, 0.6), inset 0 0 40px rgba(0, 0, 0, 0.4)';
    });
    
    speedometer.addEventListener('mouseleave', function() {
        this.style.transform = 'scale(1)';
        this.style.boxShadow = '0 0 30px rgba(0, 0, 0, 0.5), inset 0 0 30px rgba(0, 0, 0, 0.3)';
    });
    
    speedometerContainer.appendChild(speedometer);
    speedometerContainer.appendChild(volumeLabel);
    speedometerContainer.appendChild(turnOnButton);
    speedometerContainer.appendChild(assetHistoryButton); // Adiciona o botão de histórico
    
    // Botão de fechar futurista
    const closeButton = document.createElement('button');
    closeButton.innerHTML = '×';
    closeButton.style.cssText = `
        position: absolute;
        top: 15px;
        right: 20px;
        background: linear-gradient(135deg, rgba(255, 0, 100, 0.3), rgba(255, 0, 150, 0.3));
        border: 1px solid rgba(255, 0, 100, 0.5);
        color: white;
        font-size: 24px;
        width: 35px;
        height: 35px;
        border-radius: 50%;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        z-index: 11;
        font-weight: bold;
        backdrop-filter: blur(10px);
        box-shadow: 0 0 20px rgba(255, 0, 100, 0.3);
    `;
    
    closeButton.addEventListener('mouseenter', function() {
        this.style.background = 'linear-gradient(135deg, rgba(255, 0, 100, 0.6), rgba(255, 0, 150, 0.6))';
        this.style.transform = 'scale(1.1)';
        this.style.boxShadow = '0 0 30px rgba(255, 0, 100, 0.6)';
    });
    
    closeButton.addEventListener('mouseleave', function() {
        this.style.background = 'linear-gradient(135deg, rgba(255, 0, 100, 0.3), rgba(255, 0, 150, 0.3))';
        this.style.transform = 'scale(1)';
        this.style.boxShadow = '0 0 20px rgba(255, 0, 100, 0.3)';
    });
    
    closeButton.addEventListener('click', function() {
        overlay.style.animation = 'fadeInScale 0.3s reverse';
        setTimeout(() => {
            document.body.removeChild(overlay);
            clearInterval(assetCheckInterval);
            if (volumeCheckInterval) {
                clearInterval(volumeCheckInterval);
            }
            if (speedometerInterval) {
                clearInterval(speedometerInterval);
            }
            window.fxVisionOverlay = false;
        }, 300);
    });
    
    // Touch support para botão fechar em mobile
    if (isMobileDevice()) {
        closeButton.addEventListener('touchstart', function(e) {
            e.preventDefault();
            e.stopPropagation();
            
            this.style.background = 'linear-gradient(135deg, rgba(255, 0, 100, 0.8), rgba(255, 0, 150, 0.8))';
            this.style.transform = 'scale(0.9)';
        });
        
        closeButton.addEventListener('touchend', function(e) {
            e.preventDefault();
            e.stopPropagation();
            
            this.style.background = 'linear-gradient(135deg, rgba(255, 0, 100, 0.3), rgba(255, 0, 150, 0.3))';
            this.style.transform = 'scale(1)';
            
            setTimeout(() => {
                overlay.style.animation = 'fadeInScale 0.3s reverse';
                setTimeout(() => {
                    document.body.removeChild(overlay);
                    clearInterval(assetCheckInterval);
                            if (onlineUsersInterval) {
                                }
                    if (volumeCheckInterval) {
                        clearInterval(volumeCheckInterval);
                    }
                    if (speedometerInterval) {
                        clearInterval(speedometerInterval);
                    }
                    window.fxVisionOverlay = false;
                }, 300);
            }, 50);
        });
    }

    // Adiciona todos os elementos
    overlay.appendChild(particlesContainer);
    overlay.appendChild(closeButton);
    overlay.appendChild(logoContainer);
    overlay.appendChild(unifiedPanel);
    overlay.appendChild(speedometerContainer);
    overlay.appendChild(resizeHandle);
    overlay.appendChild(resizeIndicator);
    
    // Função para detectar o ativo atual
    function detectCurrentAsset() {
        let assetName = 'Not Found';
        
        const desktopElement = document.querySelector('.section-deal__name');
        if (desktopElement) {
            assetName = desktopElement.textContent.trim();
        } else {
            const mobileContainer = document.querySelector('.---react-features-Header-MobileAssetIcon-styles-module__mobileSelect--f8nDe');
            if (mobileContainer) {
                const mobileAssetDiv = mobileContainer.querySelector('div:not([class])');
                if (mobileAssetDiv) {
                    assetName = mobileAssetDiv.textContent.trim();
                }
            }
        }
        
        return assetName;
    }
    
    // Função para limpar o nome do ativo
    function cleanAssetName(assetName) {
        if (!assetName || assetName === 'Not Found' || assetName === 'Loading...') {
            return assetName;
        }
        
        let cleanName = assetName.replace(/\s*\(OTC\)/gi, '');
        cleanName = cleanName.replace(/\s*\(.*?\)/g, '');
        cleanName = cleanName.trim();
        
        return cleanName || assetName;
    }
    
    // Atualiza o ativo a cada 500ms
    const assetCheckInterval = setInterval(() => {
        const currentAsset = detectCurrentAsset();
        const cleanedAsset = cleanAssetName(currentAsset);
        
        // Atualiza o painel unificado
        if (assetText.textContent !== currentAsset) {
            assetText.textContent = currentAsset;
            // Efeito de pulse quando muda
            assetText.style.animation = 'pulse 0.6s ease-out';
            setTimeout(() => {
                assetText.style.animation = '';
            }, 600);
        }
        
        // Atualiza o velocímetro com o nome limpo
        if (currencyPair.textContent !== cleanedAsset) {
            currencyPair.textContent = cleanedAsset;
            currencyPair.style.animation = 'pulse 0.6s ease-out';
            setTimeout(() => {
                currencyPair.style.animation = '';
            }, 600);
        }
    }, 500);
    
    // Adiciona o overlay ao corpo da página
    document.body.appendChild(overlay);
     hideBigPercentageGauge();
     ensureFxSignalBox();
    
    // Aplicar tamanhos de fonte iniciais
    updateResponsiveFontSizes();
    
    // Detecção inicial
    const initialAsset = detectCurrentAsset();
    const initialCleanedAsset = cleanAssetName(initialAsset);
    assetText.textContent = initialAsset;
    currencyPair.textContent = initialCleanedAsset;
    
    // Variáveis para arrastar
    let isDragging = false;
    let currentX;
    let currentY;
    let initialX;
    let initialY;
    let xOffset = 0;
    let yOffset = 0;
    
    // Variáveis para redimensionar
    let isResizing = false;
    let startX, startY, startWidth, startHeight;
    
    // Event listeners para arrastar
    overlay.addEventListener("mousedown", dragStart);
    document.addEventListener("mousemove", drag);
    document.addEventListener("mouseup", dragEnd);
    
    // Event listeners para touch (mobile)
    overlay.addEventListener("touchstart", dragStartTouch, { passive: false });
    document.addEventListener("touchmove", dragTouch, { passive: false });
    document.addEventListener("touchend", dragEndTouch);
    
    // Event listeners para redimensionar
    resizeHandle.addEventListener("mousedown", resizeStart);
    document.addEventListener("mousemove", resize);
    document.addEventListener("mouseup", resizeEnd);
    
    // Event listeners para touch resize (mobile)
    resizeHandle.addEventListener("touchstart", resizeStartTouch, { passive: false });
    document.addEventListener("touchmove", resizeTouch, { passive: false });
    document.addEventListener("touchend", resizeEndTouch);
    
    function dragStart(e) {
        if (e.target === closeButton || e.target === resizeHandle) return;
        
        initialX = e.clientX - xOffset;
        initialY = e.clientY - yOffset;
        
        if (e.target === overlay || overlay.contains(e.target)) {
            isDragging = true;
            overlay.style.cursor = 'grabbing';
        }
    }
    
    function drag(e) {
        if (isDragging && !isResizing) {
            e.preventDefault();
            
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;
            
            xOffset = currentX;
            yOffset = currentY;
            
            overlay.style.transform = `translate(${currentX}px, ${currentY}px)`;
        }
    }
    
    function dragEnd(e) {
        initialX = currentX;
        initialY = currentY;
        
        isDragging = false;
        overlay.style.cursor = 'grab';
    }
    
    // Funções para touch events (mobile)
    function dragStartTouch(e) {
        if (e.target === closeButton || e.target === resizeHandle) return;
        
        const touch = e.touches[0];
        initialX = touch.clientX - xOffset;
        initialY = touch.clientY - yOffset;
        
        if (e.target === overlay || overlay.contains(e.target)) {
            isDragging = true;
            e.preventDefault(); // Previne scroll da página
        }
    }
    
    function dragTouch(e) {
        if (isDragging && !isResizing) {
            e.preventDefault(); // Previne scroll da página
            
            const touch = e.touches[0];
            currentX = touch.clientX - initialX;
            currentY = touch.clientY - initialY;
            
            xOffset = currentX;
            yOffset = currentY;
            
            overlay.style.transform = `translate(${currentX}px, ${currentY}px)`;
        }
    }
    
    function dragEndTouch(e) {
        initialX = currentX;
        initialY = currentY;
        
        isDragging = false;
    }
    
    function resizeStart(e) {
        e.preventDefault();
        e.stopPropagation();
        isResizing = true;
        
        startX = e.clientX;
        startY = e.clientY;
        startWidth = parseInt(document.defaultView.getComputedStyle(overlay).width, 10);
        startHeight = parseInt(document.defaultView.getComputedStyle(overlay).height, 10);
        
        document.body.style.cursor = 'nw-resize';
    }
    
    function resize(e) {
        if (!isResizing) return;
        
        e.preventDefault();
        
        const width = startWidth + (e.clientX - startX);
        const height = startHeight + (e.clientY - startY);
        
        const minWidth = deviceSizes.minWidth;
        const minHeight = deviceSizes.minHeight;
        const maxWidth = deviceSizes.maxWidth;
        const maxHeight = deviceSizes.maxHeight;
        
        const newWidth = Math.max(minWidth, Math.min(maxWidth, width));
        const newHeight = Math.max(minHeight, Math.min(maxHeight, height));
        
        overlay.style.width = newWidth + 'px';
        overlay.style.height = newHeight + 'px';
    }
    
    function resizeEnd(e) {
        isResizing = false;
        document.body.style.cursor = 'default';
        
        // Atualizar tamanhos de fonte baseado no tamanho da janela
        updateResponsiveFontSizes();
    }
    
    // Funções para touch resize (mobile)
    function resizeStartTouch(e) {
        e.preventDefault();
        e.stopPropagation();
        isResizing = true;
        
        const touch = e.touches[0];
        startX = touch.clientX;
        startY = touch.clientY;
        startWidth = parseInt(document.defaultView.getComputedStyle(overlay).width, 10);
        startHeight = parseInt(document.defaultView.getComputedStyle(overlay).height, 10);
    }
    
    function resizeTouch(e) {
        if (!isResizing) return;
        
        e.preventDefault();
        
        const touch = e.touches[0];
        const width = startWidth + (touch.clientX - startX);
        const height = startHeight + (touch.clientY - startY);
        
        const minWidth = isMobileDevice() ? 280 : 280;
        const minHeight = isMobileDevice() ? 400 : 520;
        const maxWidth = isMobileDevice() ? 400 : 650;
        const maxHeight = isMobileDevice() ? 600 : 750;
        
        const newWidth = Math.max(minWidth, Math.min(maxWidth, width));
        const newHeight = Math.max(minHeight, Math.min(maxHeight, height));
        
        overlay.style.width = newWidth + 'px';
        overlay.style.height = newHeight + 'px';
    }
    
    function resizeEndTouch(e) {
        isResizing = false;
        
        // Atualizar tamanhos de fonte baseado no tamanho da janela
        updateResponsiveFontSizes();
    }
    
    // Função para atualizar tamanhos de fonte responsivos
    function updateResponsiveFontSizes() {
        const overlayWidth = parseInt(overlay.style.width) || deviceSizes.width;
        const overlayHeight = parseInt(overlay.style.height) || deviceSizes.height;
        
        // Calcular fator de escala baseado na largura de referência
        const widthScale = Math.max(0.7, Math.min(1.2, overlayWidth / deviceSizes.width));
        
        // Calcular fator de escala baseado na altura de referência
        const heightScale = Math.max(0.7, Math.min(1.2, overlayHeight / deviceSizes.height));
        
        // Usar o menor fator para manter proporções
        const scale = Math.min(widthScale, heightScale);
        
        // Atualizar fonte do QUOTEX (base: 16px desktop, 14px mobile)
        const baseFontQuotex = isMobileDevice() ? 14 : 16;
        const quotexFontSize = Math.max(10, Math.min(20, baseFontQuotex * scale));
        quotexText.style.fontSize = quotexFontSize + 'px';
        
        // Atualizar fonte do ativo (base: 14px desktop, 12px mobile)
        const baseFontAsset = isMobileDevice() ? 12 : 14;
        const assetFontSize = Math.max(8, Math.min(16, baseFontAsset * scale));
        assetText.style.fontSize = assetFontSize + 'px';
        
        // Atualizar altura do painel se necessário
        const basePanelHeight = isMobileDevice() ? 55 : 65;
        const panelHeight = Math.max(45, Math.min(75, basePanelHeight * scale));
        unifiedPanel.style.height = panelHeight + 'px';
        
        // Atualizar padding do painel
        const basePanelPadding = isMobileDevice() ? 15 : 20;
        const panelPadding = Math.max(10, Math.min(25, basePanelPadding * scale));
        unifiedPanel.style.padding = `0 ${panelPadding}px`;
    }
    
    overlay.style.cursor = 'grab';
    
})();