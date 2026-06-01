// Canonical telemetry message schemas (validated at runtime with zod).
import { z } from 'zod';

export const QualityEnum = z.enum([
  'valid',
  'artifact',
  'lead_off',
  'out_of_range',
  'calibrating',
]);
export type Quality = z.infer<typeof QualityEnum>;

export const ConnectivityStateEnum = z.enum([
  'Connected',
  'Disconnected',
  'Error',
]);
export type ConnectivityState = z.infer<typeof ConnectivityStateEnum>;

// A single metric reading inside a DeviceObservationBatch.
// Note: an observation's `unit_id` is the MDC measurement unit code
// (e.g. NOM_DIM_PERCENT) — distinct from the batch's hospital `unit_id` ("nicu").
export const ObservationSchema = z.object({
  metric_id: z.string(),
  vendor_metric_id: z.string().nullish(),
  instance_id: z.number().int().default(0),
  unit_id: z.string(),
  value: z.number().nullable(),
  quality: QualityEnum,
  device_time: z.string().nullish(),
});
export type Observation = z.infer<typeof ObservationSchema>;

export const DeviceObservationBatchSchema = z.object({
  message_type: z.literal('DeviceObservationBatch'),
  schema_version: z.string(),
  unique_device_identifier: z.string(),
  presentation_time: z.string(),
  hospital_id: z.string().nullish(),
  unit_id: z.string().nullish(), // hospital unit, e.g. "nicu"
  bed_id: z.string().nullish(),
  simulated: z.boolean().default(false),
  gateway_id: z.string().nullish(),
  vendor: z.string().nullish(),
  protocol: z.string().nullish(),
  observations: z.array(ObservationSchema).min(1),
});
export type DeviceObservationBatch = z.infer<
  typeof DeviceObservationBatchSchema
>;

export const DeviceIdentityMessageSchema = z.object({
  message_type: z.literal('DeviceIdentity'),
  schema_version: z.string(),
  unique_device_identifier: z.string(),
  presentation_time: z.string(),
  manufacturer: z.string().nullish(),
  model: z.string().nullish(),
  serial_number: z.string().nullish(),
  firmware_revision: z.string().nullish(),
  gateway_id: z.string().nullish(),
  vendor: z.string().nullish(),
  protocol: z.string().nullish(),
  // New top-level fields (optional — older retained messages may lack them).
  hospital_id: z.string().nullish(),
  unit_id: z.string().nullish(),
  bed_id: z.string().nullish(),
  simulated: z.boolean().nullish(),
});
export type DeviceIdentityMessage = z.infer<typeof DeviceIdentityMessageSchema>;

export const DeviceConnectivityMessageSchema = z.object({
  message_type: z.literal('DeviceConnectivity'),
  schema_version: z.string(),
  unique_device_identifier: z.string(),
  presentation_time: z.string(),
  state: ConnectivityStateEnum,
  type: z.string().nullish(),
  info: z.string().nullish(),
  gateway_id: z.string().nullish(),
  vendor: z.string().nullish(),
  protocol: z.string().nullish(),
  // New top-level fields (optional — older retained messages may lack them).
  hospital_id: z.string().nullish(),
  unit_id: z.string().nullish(),
  bed_id: z.string().nullish(),
  simulated: z.boolean().nullish(),
});
export type DeviceConnectivityMessage = z.infer<
  typeof DeviceConnectivityMessageSchema
>;

export const TelemetryMessageSchema = z.discriminatedUnion('message_type', [
  DeviceObservationBatchSchema,
  DeviceIdentityMessageSchema,
  DeviceConnectivityMessageSchema,
]);
export type TelemetryMessage = z.infer<typeof TelemetryMessageSchema>;
