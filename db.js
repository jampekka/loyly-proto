import Dexie from "dexie";

export const db = new Dexie("LoylyProtoDB");
db.version(1).stores({
  samples: "++id,deviceName,deviceMac,measurement_sequence_number,ts,temperature,humidity,apparentTemperature"
});

export async function logSample(sample, deviceInfo) {
  let row = {...sample,
    deviceName: deviceInfo?.name ?? null,
    deviceMac: deviceInfo?.mac ?? null
  };
  await db.samples.add(row);
}
