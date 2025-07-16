// ruuvi.js
// Ruuvi Data Format 5 decoder (binary, 24 bytes)
export function decodeRuuviDF5(dataView) {
    if (!(dataView instanceof DataView)&& dataView.getUint8(0) !== 0x05) return null;
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
        //const mac = Array.from({length: 6}, (_, i) => dataView.getUint8(18 + i).toString(16).padStart(2, '0')).join(":");
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
            //mac
        };
    } catch (e) {
        return null;
    }
}

export function apparentTemperature(T, RH) {
    if (T == null || RH == null) return null;
    const e = (RH / 100) * 6.105 * Math.exp(17.27 * T / (237.7 + T));
    const AT = T + 0.33 * e - 4.00;
    return AT;
}

export function createBleScanSensor(onUpdate) {
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

export function createDebugSensor(onUpdate) {
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
                if (trueRH > BASELINE_RH) {
                    trueRH -= Math.max((trueRH - BASELINE_RH) * 0.08, 0.05);
                    if (trueRH < BASELINE_RH) trueRH = BASELINE_RH;
                }
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

export function getLoylyColor(val) {
    let mintemp = 20;
    let maxtemp = 150;
    let t = Math.max(mintemp, Math.min(maxtemp, Number(val)));
    let norm = (t - mintemp) / (maxtemp - mintemp);
    norm = 1 - norm;
    norm = norm * norm;
    let hue = norm * 180;
    return `hsl(${hue}, 100%, 50%)`;
}

export function createRuuviNusSensor(onUpdate) {
    let device = null;
    let server = null;
    let nusService = null;
    let nusChar = null;
    let notificationHandler = null;
    return {
        async start() {
            try {
                device = await navigator.bluetooth.requestDevice({
                    filters: [
                        { namePrefix: "Ruuvi" },
                        { services: ["6e400001-b5a3-f393-e0a9-e50e24dcca9e"] } // NUS UUID is required
                    ]
                });
                server = await device.gatt.connect();
                nusService = await server.getPrimaryService("6e400001-b5a3-f393-e0a9-e50e24dcca9e");
                nusChar = await nusService.getCharacteristic("6e400003-b5a3-f393-e0a9-e50e24dcca9e"); // RX characteristic (notify)
                notificationHandler = async (event) => {
                    const value = event.target.value;
                    // Always try to parse as Ruuvi DF5
                    const decoded = decodeRuuviDF5(value);
                    if (decoded) {
                        const at = apparentTemperature(decoded.temperature, decoded.humidity);
                        onUpdate({
                            temperature: decoded.temperature,
                            humidity: decoded.humidity,
                            apparentTemperature: at
                        });
                    }
                };
                await nusChar.startNotifications();
                nusChar.addEventListener('characteristicvaluechanged', notificationHandler);
                
                
            } catch (error) {
                onUpdate({ temperature: null, humidity: null, apparentTemperature: null, error: error.toString() });
            }
        },
        stop() {
            if (nusChar && notificationHandler) {
                nusChar.removeEventListener('characteristicvaluechanged', notificationHandler);
            }
            if (server && server.connected) {
                server.disconnect();
            }
            device = null;
            server = null;
            nusService = null;
            nusChar = null;
            notificationHandler = null;
        }
    };
}

export const WINDOW_MS = 5 * 60 * 1000;
