// Drive ONE bed at 1 Hz for end-to-end acceptance verification.
//
// Publishing requires the PUBLISHER identity — `impact-subscriber` in .env is
// subscribe-only and the broker answers `Not authorized`. Pass the Jetson
// gateway credential as one-off overrides; do NOT put it in .env:
//
//   set -a; . ./.env; set +a; \
//   MQTT_USERNAME=<publisher> MQTT_PASSWORD=<...> \
//   node scripts/publish-bed01-1hz.mjs --seconds 120
//
// Flags:
//   --seconds N   how long to run            (default 60)
//   --hz N        publish rate               (default 1)
//   --bed NN      bed number, zero-padded    (default 01)
//   --zero        emit SpO2 0 and RR 0 instead of normal values, to prove a
//                 genuine zero survives the writer (`||` vs `??`). Apnea is
//                 literally rr === 0, so this is a clinical test, not a corner case.
//   --dry         print the payloads, publish nothing
import mqtt from 'mqtt';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const SECONDS = Number(flag('seconds', 60));
const HZ = Number(flag('hz', 1));
const BED = String(flag('bed', '01'));
const ZERO = has('zero');
const DRY = has('dry');

const HOSPITAL = 'bcch';
const UNIT = 'nicu';
const PHILIPS = `sim-${HOSPITAL}-bed-${BED}-philips-monitor`;
const TOPIC = `hospitals/${HOSPITAL}/devices/${PHILIPS}/observations`;

const obs = (metric_id, unit_id, value, quality = 'valid') => ({
  metric_id, vendor_metric_id: metric_id, instance_id: 0, unit_id, value, quality,
  device_time: null,
});

// presentation_time is the clock that becomes vital_signs.observed_at and (per
// Oscar's widen) physiological_data.recorded_at. It MUST advance per sample —
// a constant timestamp would be silently deduped by ON CONFLICT.
function batch(now) {
  return {
    schema_version: '1.0',
    message_type: 'DeviceObservationBatch',
    unique_device_identifier: PHILIPS,
    presentation_time: now.toISOString(),
    hospital_id: HOSPITAL,
    unit_id: UNIT,
    bed_id: `${HOSPITAL}-${UNIT}-bed-${BED}`,
    simulated: true,
    gateway_id: `jetson-${HOSPITAL}-01`,
    vendor: 'philips',
    protocol: 'intellivue_udp',
    observations: [
      obs('NOM_ECG_CARD_BEAT_RATE', 'NOM_DIM_BEAT_PER_MIN', ZERO ? 0 : 145 + Math.round(Math.random() * 10 - 5)),
      obs('NOM_PULS_OXIM_SAT_O2', 'NOM_DIM_PERCENT', ZERO ? 0 : 95 + Math.round(Math.random() * 4 - 2)),
      obs('NOM_RESP_RATE', 'NOM_DIM_RESP_PER_MIN', ZERO ? 0 : 46 + Math.round(Math.random() * 8 - 4)),
      obs('NOM_TEMP', 'NOM_DIM_DEGC', 36.8),
    ],
  };
}

const total = Math.max(1, Math.round(SECONDS * HZ));
console.log(
  `bed ${BED} -> ${TOPIC}\n` +
  `  ${HZ} Hz for ${SECONDS}s = ${total} batches` +
  `${ZERO ? '  [ZERO MODE: SpO2 0 / RR 0 / HR 0]' : ''}${DRY ? '  [DRY]' : ''}`,
);

if (DRY) {
  console.log(JSON.stringify(batch(new Date()), null, 2));
  process.exit(0);
}

const { MQTT_URL, MQTT_USERNAME, MQTT_PASSWORD } = process.env;
if (!MQTT_URL || !MQTT_USERNAME || !MQTT_PASSWORD) {
  console.error('MQTT_URL / MQTT_USERNAME / MQTT_PASSWORD required (publisher identity).');
  process.exit(1);
}

const client = mqtt.connect(MQTT_URL, {
  username: MQTT_USERNAME, password: MQTT_PASSWORD,
  clientId: `impact-bed${BED}-1hz-${process.pid}`, protocolVersion: 5,
});

let sent = 0;
let firstTs = null;
let lastTs = null;

client.on('error', (err) => {
  // `Not authorized` here means subscriber creds were used. See header.
  console.error('mqtt error:', err.message);
  client.end(true, () => process.exit(1));
});

client.on('connect', () => {
  console.log('connected; publishing…');
  const timer = setInterval(() => {
    if (sent >= total) {
      clearInterval(timer);
      // QoS 0 is fire-and-forget; let the socket flush before closing.
      setTimeout(() => client.end(false, () => {
        console.log(
          `\ndone: ${sent} batches (${sent * 4} observations)\n` +
          `  presentation_time window: ${firstTs} .. ${lastTs}\n` +
          `  now verify:  node scripts/verify-arrivals.mjs --since ${firstTs}` +
          `${ZERO ? ' --expect-zero' : ''}`,
        );
        process.exit(0);
      }), 500);
      return;
    }
    const now = new Date();
    const payload = batch(now);
    firstTs ??= payload.presentation_time;
    lastTs = payload.presentation_time;
    client.publish(TOPIC, JSON.stringify(payload), { qos: 0 }, (err) => {
      if (err) console.error('publish failed:', err.message);
    });
    sent += 1;
    if (sent % 10 === 0) process.stdout.write(`  ${sent}/${total}\r`);
  }, 1000 / HZ);
});
