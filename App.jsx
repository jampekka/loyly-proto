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
import TimeSeriesChart from "./TimeSeriesChart";

let wakeLock = null;
export default function RuuviApp() {
    const [connectionState, setConnectionState] = useState("idle"); // idle, connecting, connected, disconnecting
    const [debugMode, setDebugMode] = useState(false);
    const [sensor, setSensor] = useState({ temperature: null, humidity: null, apparentTemperature: null });
    const [error, setError] = useState(null);
    const [deviceInfo, setDeviceInfo] = useState({ name: null, mac: null });
    const sensorRef = useRef(null);
    const [now, setNow] = useState(Date.now());

    const history = useRecentSamples(WINDOW_MS);
    
    
    const prevSampleTime = history.length > 0 ? history[history.length - 1].ts : 0;
    let timeSincePrevSample = (now - prevSampleTime) / 1000
    let timeDecay = Math.exp(-timeSincePrevSample/10);
    let labelOpacity = Math.max(timeDecay, 0.5); // Ensure minimum opacity

    // Continuously update 'now' for smooth scrolling x axis
    useEffect(() => {
        let raf;
        function update() {
            let now = Date.now();
            

            //console.log(prevSampleTime, timeSincePrevSample, decay);
            setNow(now);
            raf = requestAnimationFrame(update);
        }
        raf = requestAnimationFrame(update);
        return () => raf && cancelAnimationFrame(raf);
    }, []);

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

    // Use last sample from history for label values, always show even when disconnected
    const lastSample = history.length > 0 ? history[history.length - 1] : null;
    let t = lastSample?.temperature ?? '?';
    let rh = lastSample?.humidity ?? '?';
    let at = lastSample?.apparentTemperature ?? '?';
    if (t !== '?') t = t.toFixed(1);
    if (rh !== '?') rh = rh.toFixed(1);
    if (at !== '?') at = at.toFixed(1);
    let loylyColor = (at !== '?') ? getLoylyColor(at) : '#fff';

    const buttonText = {
        idle: "Connect",
        connecting: "Connecting...",
        connected: "Disconnect",
        disconnecting: "Disconnecting...",
    }[connectionState];
    return (
        <main style={{ width: '100%', maxWidth: 800, margin: '0 auto' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2.5em', marginBottom: '2em', marginTop: '0.5em' }}>
                {/* Apparent Temperature (Löyly) */}
                <div style={{ width: '100%' }}>
                    <div className="display-block" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.2em' }}>
                        <div className="loyly-label" style={{ textAlign: 'left', flex: 1 }}>Löyly</div>
                        <div className="loyly-value" style={{ color: loylyColor, textAlign: 'right', flex: 1 }}>
                            <span style={{ opacity: labelOpacity }}>{at}</span><span>°L</span>
                        </div>
                    </div>
                    <TimeSeriesChart
                        data={history}
                        now={now}
                        valueKey="apparentTemperature"
                        lineColor="rgba(255, 255, 255, 0.8)"
                        fillColorFn={getLoylyColor}
                        heightRatio={1.3}
                    />
                </div>
                {/* Temperature */}
                <div style={{ width: '100%' }}>
                    <div className="display-block" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.2em' }}>
                        <div className="temp-label" style={{ textAlign: 'left', flex: 1 }}>Temperature</div>
                        <div className="temp-value" style={{ textAlign: 'right', flex: 1 }}>
                            <span style={{ opacity: labelOpacity }}>{t}</span><span>°C</span>
                        </div>
                    </div>
                    <TimeSeriesChart
                        data={history}
                        now={now}
                        valueKey="temperature"
                        lineColor="#fff"
                        heightRatio={1}
                    />
                </div>
                {/* Humidity */}
                <div style={{ width: '100%' }}>
                    <div className="display-block" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.2em' }}>
                        <div className="hum-label" style={{ textAlign: 'left', flex: 1 }}>Humidity</div>
                        <div className="hum-value" style={{ textAlign: 'right', flex: 1 }}>
                            <span style={{ opacity: labelOpacity }}>{rh}</span><span>%</span>
                        </div>
                    </div>
                    <TimeSeriesChart
                        data={history}
                        now={now}
                        valueKey="humidity"
                        lineColor="#7fd"
                        heightRatio={1}
                    />
                </div>
                {error && <div className="error-msg">{error}</div>}
            </div>
            <section className="debug-controls" style={{ textAlign: 'center' }}>
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
