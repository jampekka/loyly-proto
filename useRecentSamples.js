import { useEffect, useState } from "react";
import { liveQuery } from "dexie";
import { db } from "./db";

export function useRecentSamples(windowMs) {
  const [samples, setSamples] = useState([]);
  useEffect(() => {
    const sub = liveQuery(async () => {
      const now = Date.now();
      return db.samples
        .where("ts")
        .above(now - windowMs)
        .toArray();
    }).subscribe({
      next: setSamples
    });
    return () => sub.unsubscribe();
  }, [windowMs]);
  return samples;
}
