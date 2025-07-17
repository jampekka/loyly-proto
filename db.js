import Dexie from "dexie";

export const db = new Dexie("LoylyProtoDB");
db.version(1).stores({
  samples: "++id,name,mac,measurement_sequence_number,ts,temperature,humidity,apparentTemperature"
});

export async function logSample(sample) {
  await db.samples.add(sample);
}
