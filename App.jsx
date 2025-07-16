import React, { useState, useRef, useEffect } from "react";
import * as d3 from "d3";
import "./App.css";

// Ruuvi Data Format 5 decoder (binary, 24 bytes)
function decodeRuuviDF5(dataView) {
    if (!(dataView instanceof DataView) || dataView.byteLength !== 24 || dataView.getUint8(0) !== 0x05) return null;
    try {
        let tempRaw = dataView.getInt16(1, false);
        const temperature = tempRaw === -32768 ? null : +(tempRaw / 200.0);
        const humidityRaw = dataView.getUint16(3, false);
        const humidity = humidityRaw === 0xFFFF ? null : +(humidityRaw / 400.0);
        const pressureRaw = dataView.getUint16(5, false);
        const pressure = pressureRaw === 0xFFFF ? null : +((pressureRaw + 50000) / 100.0);
        let accX = dataView.getInt16(7, false);
        let accY = dataView.getInt16(9, false);
        let accZ = dataView.getInt16(11, false);
        if (accX === -32768) accX = null;
        if (accY === -32768) accY = null;
        if (accZ === -32768) accZ = null;
        const powerInfo = dataView.getUint8(13);
        const batteryVoltage = powerInfo >> 5;
        const txPowerRaw = powerInfo & 0x1F;
        const battery = batteryVoltage === 0b1111111 ? null : 1600 + batteryVoltage;
        const txPower = txPowerRaw === 0b11111 ? null : -40 + (txPowerRaw * 2);
        const movement_counter = dataView.getUint8(15);
        const measurement_sequence_number = dataView.getUint16(16, false);
        const mac = Array.from({length: 6}, (_, i) => dataView.getUint8(18 + i).toString(16).padStart(2, '0')).join(":");
        return {
            humidity,
            temperature,
            pressure,
            acceleration_x: accX,
            acceleration_y: accY,
            acceleration_z: accZ,
            battery,
            txPower,
            movement_counter,
            measurement_sequence_number,
            mac
        };
    } catch (e) {
        return null;
    }
}
function apparentTemperature(T, RH) {
    if (T == null || RH == null) return null;
    const e = (RH / 100) * 6.105 * Math.exp(17.27 * T / (237.7 + T));
    const AT = T + 0.33 * e - 4.00;
    return AT;
}

function createRealSensor(onUpdate) {
    let bleScan = null;
    let advListener = null;
    return {
        async start() {
            try {
                bleScan = await navigator.bluetooth.requestLEScan({ filters: [{ namePrefix: "Ruuvi" }] });
                advListener = event => {
                    for (const [companyId, dataView] of event.manufacturerData) {
                        if (companyId === 0x0499 && dataView.byteLength === 24) {
                            const decoded = decodeRuuviDF5(dataView);
                            if (decoded) {
                                const at = apparentTemperature(decoded.temperature, decoded.humidity);
                                onUpdate({
                                    temperature: decoded.temperature,
                                    humidity: decoded.humidity,
                                    apparentTemperature: at
                                });
                            }
                        }
                    }
                };
                navigator.bluetooth.addEventListener('advertisementreceived', advListener);
            } catch (error) {
                onUpdate({ temperature: null, humidity: null, apparentTemperature: null, error: error.toString() });
            }
        },
        stop() {
            if (bleScan) bleScan.stop();
            if (advListener) navigator.bluetooth.removeEventListener('advertisementreceived', advListener);
            bleScan = null;
            advListener = null;
        }
    };
}
function createDebugSensor(onUpdate) {
    let interval = null;
    const BASELINE_RH = 5;
    const BASELINE_TEMP = 60;
    let trueTemp = BASELINE_TEMP, trueRH = BASELINE_RH, fakeTemp = BASELINE_TEMP, fakeRH = BASELINE_RH;
    let running = false;
    function fakeLoyly() {
        trueRH = Math.min(trueRH + 10, 100);
    }
    return {
        async start() {
            running = true;
            trueTemp = BASELINE_TEMP; trueRH = BASELINE_RH; fakeTemp = BASELINE_TEMP; fakeRH = BASELINE_RH;
            onUpdate({ temperature: fakeTemp, humidity: fakeRH, apparentTemperature: apparentTemperature(fakeTemp, fakeRH) });
            interval = setInterval(() => {
                // True env random walk
                //trueTemp += (Math.random() * 2 - 1);
                //trueTemp = Math.max(60, Math.min(120, trueTemp));
                // Decay RH spike
                if (trueRH > BASELINE_RH) {
                    trueRH -= Math.max((trueRH - BASELINE_RH) * 0.08, 0.05);
                    if (trueRH < BASELINE_RH) trueRH = BASELINE_RH;
                }
                // Exponential smoothing
                const tau = 2.0, dt = 1.0, alpha = 1 - Math.exp(-dt / tau);
                fakeTemp += alpha * (trueTemp - fakeTemp);
                fakeRH += alpha * (trueRH - fakeRH);
                onUpdate({ temperature: fakeTemp, humidity: fakeRH, apparentTemperature: apparentTemperature(fakeTemp, fakeRH) });
            }, 1000);
            this.fakeLoyly = fakeLoyly;
        },
        stop() {
            running = false;
            if (interval) clearInterval(interval);
            interval = null;
        },
        fakeLoyly,
        getBaselineRH: () => BASELINE_RH,
        getBaselineTemp: () => BASELINE_TEMP
    };
}

function getLoylyColor(val) {
    let mintemp = 20;
    let maxtemp = 150;
    let t = Math.max(mintemp, Math.min(maxtemp, Number(val)));
    let norm = (t - mintemp) / (maxtemp - mintemp);
    norm = 1 - norm;
    norm = norm * norm;
    let hue = norm * 180;
    return `hsl(${hue}, 100%, 50%)`;
}

const WINDOW_MS = 5 * 60 * 1000;

function TimeSeriesChart({ data, windowMs = WINDOW_MS }) {
    const ref = useRef();
    const [width, setWidth] = useState(0);
    useEffect(() => {
        if (!ref.current) return;
        const parent = ref.current.parentElement;
        if (!parent) return;
        setWidth(parent.offsetWidth);
        const observer = new window.ResizeObserver(entries => {
            for (let entry of entries) {
                if (entry.contentRect) {
                    setWidth(entry.contentRect.width);
                }
            }
        });
        observer.observe(parent);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (!ref.current || width === 0) return;
        // Only plot data within the window
        const now = Date.now();
        let filtered = data.filter(d => now - d.ts <= windowMs);
        // Remove garbage samples: both value and temperature null/NaN
        filtered = filtered.filter(d => (
            (d.value !== null && !isNaN(d.value)) ||
            (d.temperature !== null && !isNaN(d.temperature))
        ));
        if (!filtered.length) return;
        const height = Math.round(width * 0.5); // 50% aspect ratio
        const margin = { top: 10, right: 36, bottom: 24, left: 10 };
        const svg = d3.select(ref.current);
        svg.selectAll("*").remove();
        svg.attr("width", width).attr("height", height);
        // X scale: time axis
        const minTs = filtered[0].ts;
        const maxTs = filtered[filtered.length - 1].ts;
        const x = d3.scaleLinear()
            .domain([0, windowMs]) // 0s on the right
            .range([width - margin.right, margin.left]); // Newest right
        const y = d3.scaleLinear()
            .domain([
                Math.min(
                    d3.min(filtered, d => d.value),
                    d3.min(filtered, d => d.temperature)
                ) - 2,
                Math.max(
                    d3.max(filtered, d => d.value),
                    d3.max(filtered, d => d.temperature)
                ) + 2
            ])
            .range([height - margin.bottom, margin.top]);
        // Area path
        const areaPath = d3.area()
            .defined(d => d.value !== null && !isNaN(d.value)) // allow flat lines
            .x(d => x(now - d.ts))
            .y0(height - margin.bottom)
            .y1(d => y(d.value));
        
        // Draw area fill (ensure always drawn, even if flat)
        svg.append('path')
            .datum(filtered)
            .attr('d', areaPath)
            .attr('fill', '#222') // fallback fill, replace with gradient if needed
            .attr('stroke', 'none');
        // Colored line segments
        for (let i = 1; i < filtered.length; ++i) {
            const prev = filtered[i - 1];
            const curr = filtered[i];
            const x0 = x(now - prev.ts), x1 = x(now - curr.ts);
            const color = getLoylyColor(curr.value);
            svg.append('line')
                .attr('x1', x0)
                .attr('y1', y(prev.value))
                .attr('x2', x1)
                .attr('y2', y(curr.value))
                .attr('stroke', color)
                .attr('stroke-width', 2)
                .attr('fill', 'none');
        }
        // --- Add temperature line ---
        if (filtered[0] && filtered[0].temperature !== undefined) {
            const tempLine = d3.line()
                .defined(d => d.temperature !== null && !isNaN(d.temperature))
                .x(d => x(now - d.ts))
                .y(d => y(d.temperature));
            svg.append('path')
                .datum(filtered)
                .attr('d', tempLine)
                .attr('stroke', '#fff')
                .attr('stroke-width', 2)
                .attr('fill', 'none');
        }
        // --- End temperature line ---
        // X axis
        svg.append('g')
            .attr('transform', `translate(0,${height - margin.bottom})`)
            .call(d3.axisBottom(x)
                .tickValues(Array.from({length: Math.floor(windowMs / 60000) + 1}, (_, i) => i * 60000))
                .tickFormat(ms => `${Math.round(ms / 60000)}`)
            )
            .selectAll('text').attr('fill', '#aaa').attr('font-size', '1.5em');
        // Y axis (move to right)
        svg.append('g')
            .attr('transform', `translate(${width - margin.right},0)`)
            .call(d3.axisRight(y).ticks(5))
            .selectAll('text').attr('fill', '#aaa').attr('font-size', '1.5em');
        svg.selectAll('.domain, .tick line').attr('stroke', '#444');
    }, [data, width, windowMs]);

    return <svg ref={ref} style={{ width: "100%", height: "auto", display: "block" }} />;
}

let wakeLock = null;
export default function RuuviApp() {
    const [scanActive, setScanActive] = useState(false);
    const [debugMode, setDebugMode] = useState(false);
    const [sensor, setSensor] = useState({ temperature: null, humidity: null, apparentTemperature: null });
    const [error, setError] = useState(null);
    const [history, setHistory] = useState([]);
    const sensorRef = useRef(null);
    // Start/stop sensor
    async function startSensor(isDebug) {
        if (sensorRef.current) sensorRef.current.stop();
        setSensor({ temperature: null, humidity: null, apparentTemperature: null });
        setError(null);
        let s;
        if (isDebug) {
            s = createDebugSensor(update => setSensor(update));
        } else {
            s = createRealSensor(update => {
                if (update.error) setError(update.error);
                else setSensor(update);
            });
        }
        sensorRef.current = s;
        await s.start();
    }
    function stopSensor() {
        if (sensorRef.current) sensorRef.current.stop();
        setSensor({ temperature: null, humidity: null, apparentTemperature: null });
        setError(null);
    }
    // UI event handlers
    function handleDebugStop() {
        setDebugMode(false);
        stopSensor();
    }
    async function handleScanClick() {
        setDebugMode(false);
        setScanActive(v => {
            if (!v) startSensor(false);
            else stopSensor();
            return !v;
        });
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            console.debug("Wake lock", wakeLock)
        } catch (err) {
            console.error("Error getting screen wake lock")
        }

        
    }
    function handleFakeLoyly() {
        if (!debugMode) {
            setDebugMode(true);
            setScanActive(false);
            startSensor(true);
            // Do NOT trigger fakeLoyly on first press
            return;
        }
        if (sensorRef.current && sensorRef.current.fakeLoyly) sensorRef.current.fakeLoyly();
    }
    // Clean up on unmount
    useEffect(() => () => stopSensor(), []);

    // Update history when apparentTemperature changes
    useEffect(() => {
        // Always run on every update, not just when value changes
        setHistory(h => {
            const now = Date.now();
            const arr = [...h, { value: sensor.apparentTemperature, temperature: sensor.temperature, ts: now }];
            // Keep only the last WINDOW_MS milliseconds
            return arr.filter(d => now - d.ts <= WINDOW_MS);
        });
    }, [sensor]);

    let t = sensor.temperature !== null && sensor.temperature !== undefined ? sensor.temperature.toFixed(1) : '?';
    let rh = sensor.humidity !== null && sensor.humidity !== undefined ? sensor.humidity.toFixed(1) : '?';
    let at = sensor.apparentTemperature !== null && sensor.apparentTemperature !== undefined ? sensor.apparentTemperature.toFixed(1) : '?';
    let loylyColor = (at !== '?') ? getLoylyColor(at) : '#fff';
    return (
        <main style={{ width: '100%', maxWidth: 800, margin: '0 auto' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.5em', marginBottom: '2em', marginTop: '0.5em' }}>
                <div style={{ textAlign: 'center' }}>
                    <div className="loyly-label">Löyly</div>
                    <div className="loyly-value" style={{ color: loylyColor }}>{`${at}°L`}</div>

                </div>
                <div style={{ width: "100%", margin: "1.2em auto 0 auto" }}>
                        <TimeSeriesChart data={history} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'center', gap: '2.5em', width: '100%' }}>
                    <div style={{ textAlign: 'center', flex: 1 }}>
                        <div className="temp-label">Temperature</div>
                        <div className="temp-value">{`${t}°C`}</div>
                    </div>
                    <div style={{ textAlign: 'center', flex: 1 }}>
                        <div className="hum-label">Humidity</div>
                        <div className="hum-value">{`${rh}%`}</div>
                    </div>
                </div>
                {error && <div className="error-msg">{error}</div>}
            </div>
            <section className="debug-controls" style={{ marginTop: '2.5em', textAlign: 'center' }}>
                <button
                    id="scan"
                    onClick={handleScanClick}
                    className={scanActive ? 'contrast' : ''}
                    style={{ width: '100%', fontSize: '1.2em', marginTop: '2em' }}
                >
                    {scanActive ? 'Disconnect' : 'Connect'}
                </button>
                <div className="debug-links">
                    <a href="#" onClick={e => { e.preventDefault(); handleFakeLoyly(); }}>Fake löyly</a>
                </div>
            </section>
        </main>
    );
}
