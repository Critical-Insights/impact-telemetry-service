// MDC (ISO/IEEE 11073) metric_id -> IMPACT vital_readings field translation.
//
// This is a pure library. It is NOT yet wired into the running subscriber —
// wiring happens when the IMPACT HTTP poster is built (gated on IMPACT-team work).
import type { DeviceObservationBatch } from '../types/canonical.js';

// IMPACT's vital_readings short field names.
export type ImpactVitalField =
  | 'heart_rate'
  | 'spo2'
  | 'rr'
  | 'temperature'
  | 'fio2'
  | 'bp_systolic'
  | 'bp_diastolic'
  | 'bp_mean';

// Conservative mapping — only metrics we have confirmed evidence for. Unmapped
// metrics (waveforms, unsupported parameters, anything we can't yet translate)
// are reported in FlattenResult.unmapped rather than silently dropped.
export const mdcToImpactField: Record<string, ImpactVitalField> = {
  NOM_ECG_CARD_BEAT_RATE: 'heart_rate',
  NOM_PULS_OXIM_SAT_O2: 'spo2',
  NOM_RESP_RATE: 'rr',
  NOM_TEMP: 'temperature',
  NOM_VENT_CONC_AWAY_O2: 'fio2',

  // Likely future additions, kept as comments until we have device evidence:
  // NOM_PRESS_BLD_NONINV_SYS: 'bp_systolic',
  // NOM_PRESS_BLD_NONINV_DIA: 'bp_diastolic',
  // NOM_PRESS_BLD_NONINV_MEAN: 'bp_mean',
};

export function mdcToImpact(metricId: string): ImpactVitalField | null {
  return mdcToImpactField[metricId] ?? null;
}

export type ImpactVitalRecord = {
  device_id: string;
  bed_id: string | null;
  presentation_time: string;
  heart_rate?: number | null;
  spo2?: number | null;
  rr?: number | null;
  temperature?: number | null;
  fio2?: number | null;
  bp_systolic?: number | null;
  bp_diastolic?: number | null;
  bp_mean?: number | null;
  // patient_id is intentionally absent — resolved by a separate upstream step
  // that depends on Supabase access we don't have yet.
};

export type UnmappedEntry = { metric_id: string; reason: string };

export type FlattenResult = {
  record: ImpactVitalRecord;
  unmapped: UnmappedEntry[];
};

export function flattenBatchToImpactRecord(
  batch: DeviceObservationBatch,
  deviceIdOverride?: string,
): FlattenResult {
  const record: ImpactVitalRecord = {
    device_id: deviceIdOverride ?? batch.unique_device_identifier,
    bed_id: batch.bed_id ?? null,
    presentation_time: batch.presentation_time,
  };
  const unmapped: UnmappedEntry[] = [];

  // Group mapped observations by their target IMPACT field so we can resolve
  // duplicates (e.g. two instance_ids of NOM_TEMP) deterministically.
  const byField = new Map<ImpactVitalField, typeof batch.observations>();

  for (const obs of batch.observations) {
    const field = mdcToImpact(obs.metric_id);
    if (field === null) {
      unmapped.push({ metric_id: obs.metric_id, reason: 'no MDC→IMPACT mapping' });
      continue;
    }
    const group = byField.get(field) ?? [];
    group.push(obs);
    byField.set(field, group);
  }

  for (const [field, group] of byField) {
    // On duplicates, the instance_id=0 reading wins; the rest are reported.
    let winner = group[0]!;
    if (group.length > 1) {
      winner = group.find((o) => o.instance_id === 0) ?? group[0]!;
      for (const o of group) {
        if (o !== winner) {
          unmapped.push({
            metric_id: o.metric_id,
            reason: `duplicate field (instance_id ${o.instance_id})`,
          });
        }
      }
    }

    if (winner.quality === 'valid') {
      record[field] = winner.value;
    } else {
      // IMPACT has no quality concept; a non-valid reading must not look like a
      // real number. Null is the safest signal.
      record[field] = null;
      unmapped.push({
        metric_id: winner.metric_id,
        reason: `non-valid quality: ${winner.quality}`,
      });
    }
  }

  return { record, unmapped };
}
