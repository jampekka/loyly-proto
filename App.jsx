import React, { useState, useRef, useEffect } from "react";
import * as d3 from "d3";
import "./App.css";
import {
  decodeRuuviDF5,
  apparentTemperature,
  createBleScanSensor,
  createRuuviNusSensor,
  createDebugSensor,
  getLoylyColor,
  WINDOW_MS
} from "./ruuvi";
import { db, logSample } from "./db";
import { useRecentSamples } from "./useRecentSamples";

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
        // Remove garbage samples: both apparentTemperature and temperature null/NaN
        filtered = filtered.filter(d => (
            (d.apparentTemperature !== null && typeof d.apparentTemperature === 'number' && !isNaN(d.apparentTemperature)) ||
            (d.temperature !== null && typeof d.temperature === 'number' && !isNaN(d.temperature))
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
                    d3.min(filtered, d => d.apparentTemperature),
                    d3.min(filtered, d => d.temperature)
                ) - 2,
                Math.max(
                    d3.max(filtered, d => d.apparentTemperature),
                    d3.max(filtered, d => d.temperature)
                ) + 2
            ])
            .range([height - margin.bottom, margin.top]);
        // Area path
        const areaPath = d3.area()
            .defined(d => d.apparentTemperature !== null && typeof d.apparentTemperature === 'number' && !isNaN(d.apparentTemperature))
            .x(d => x(now - d.ts))
            .y0(height - margin.bottom)
            .y1(d => y(d.apparentTemperature));
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
            const color = getLoylyColor(curr.apparentTemperature);
            svg.append('line')
                .attr('x1', x0)
                .attr('y1', y(prev.apparentTemperature))
                .attr('x2', x1)
                .attr('y2', y(curr.apparentTemperature))
                .attr('stroke', color)
                .attr('stroke-width', 2)
                .attr('fill', 'none');
        }
        // --- Add temperature line ---
        if (filtered[0] && filtered[0].temperature !== undefined) {
            const tempLine = d3.line()
                .defined(d => d.temperature !== null && typeof d.temperature === 'number' && !isNaN(d.temperature))
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
    const [connectionState, setConnectionState] = useState("idle"); // idle, connecting, connected, disconnecting
    const [debugMode, setDebugMode] = useState(false);
    const [sensor, setSensor] = useState({ temperature: null, humidity: null, apparentTemperature: null });
    const [error, setError] = useState(null);
    const [deviceInfo, setDeviceInfo] = useState({ name: null, mac: null });
    const sensorRef = useRef(null);

    // Use liveQuery for samples from the past WINDOW_MS
    const history = useRecentSamples(WINDOW_MS);

    // Start/stop sensor
    async function startSensor(isDebug) {
        if (sensorRef.current) {
            await sensorRef.current.stop();
        }
        setSensor({ temperature: null, humidity: null, apparentTemperature: null });
        setError(null);
        setDeviceInfo({ name: null, mac: null });

        let s;
        if (isDebug) {
            s = createDebugSensor(update => setSensor(update));
        } else {
            s = createBleScanSensor((update, meta) => {
                if (update.error) {
                    setError(update.error);
                    // If there's an error during connection, revert state
                    if (connectionState === "connecting") {
                        setConnectionState("idle");
                    }
                } else {
                    setSensor(update);
                    if (meta && (meta.name || meta.mac)) {
                        setDeviceInfo({ name: meta.name ?? null, mac: meta.mac ?? null });
                    }
                }
            });
        }
        sensorRef.current = s;
        await s.start();
        // If we are in debug mode, we are instantly connected.
        // Otherwise, the connection is established when we get the first data.
        if (isDebug) {
            setConnectionState("connected");
        }
    }

    async function stopSensor() {
        if (sensorRef.current) {
            await sensorRef.current.stop();
            sensorRef.current = null;
        }
        setSensor({ temperature: null, humidity: null, apparentTemperature: null });
        setError(null);
        setConnectionState("idle");
    }

    // UI event handlers
    function handleDebugStop() {
        setDebugMode(false);
        stopSensor();
    }

    async function handleScanClick() {
        if (connectionState === "connected") {
            setConnectionState("disconnecting");
            await stopSensor();
            if (wakeLock) {
                wakeLock.release();
                wakeLock = null;
            }
            return;
        }

        if (connectionState === "idle") {
            setDebugMode(false);
            setConnectionState("connecting");
            try {
                await startSensor(false);
                // The state will be set to 'connected' by the effect hook when data arrives
                wakeLock = await navigator.wakeLock.request('screen');
                console.debug("Wake lock", wakeLock);
            } catch (err) {
                console.error("Error during connection setup:", err);
                setError(err.message || "Connection failed. Please try again.");
                setConnectionState("idle");
                if (sensorRef.current) {
                    await sensorRef.current.stop();
                    sensorRef.current = null;
                }
            }
        }
    }

    async function handleFakeLoyly() {
        if (!debugMode) {
            setDebugMode(true);
            setConnectionState("connecting");
            await startSensor(true);
            // Do NOT trigger fakeLoyly on first press
            return;
        }
        if (sensorRef.current && sensorRef.current.fakeLoyly) {
            sensorRef.current.fakeLoyly();
        }
    }

    // Clean up on unmount
    useEffect(() => {
        return () => {
            if (sensorRef.current) {
                sensorRef.current.stop();
            }
            if (wakeLock) {
                wakeLock.release();
            }
        };
    }, []);

    // Update history and log sample when new sensor data arrives
    useEffect(() => {
        if (sensor.apparentTemperature === null && sensor.temperature === null) {
            return;
        }

        // If we were connecting and we received data, we are now connected.
        if (connectionState === "connecting") {
            setConnectionState("connected");
        }

        const now = Date.now();
        const sample = {
            ...sensor,
            ts: now
        };
        logSample(sample, deviceInfo);
    }, [sensor, connectionState, deviceInfo]);

    let t = sensor.temperature !== null && sensor.temperature !== undefined ? sensor.temperature.toFixed(1) : '?';
    let rh = sensor.humidity !== null && sensor.humidity !== undefined ? sensor.humidity.toFixed(1) : '?';
    let at = sensor.apparentTemperature !== null && sensor.apparentTemperature !== undefined ? sensor.apparentTemperature.toFixed(1) : '?';
    let loylyColor = (at !== '?') ? getLoylyColor(at) : '#fff';

    const buttonText = {
        idle: "Connect",
        connecting: "Connecting...",
        connected: "Disconnect",
        disconnecting: "Disconnecting...",
    }[connectionState];
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
                    disabled={connectionState === "connecting" || connectionState === "disconnecting"}
                    className={connectionState === 'connected' ? 'contrast' : ''}
                    style={{ width: '100%', fontSize: '1.2em', marginTop: '2em' }}
                >
                    {buttonText}
                </button>
                <div className="debug-links">
                    <a href="#" onClick={e => { e.preventDefault(); handleFakeLoyly(); }}>Fake löyly</a>
                </div>
            </section>
        </main>
    );
}
