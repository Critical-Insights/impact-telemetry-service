// One-off: publish DeviceObservationBatch messages (one per device) for
// end-to-end verification. Reads MQTT_* from the environment. Publishing
// requires the publisher identity (the subscriber creds are subscribe-only):
//   set -a; . ./.env; set +a; \
//   MQTT_USERNAME=<publisher> MQTT_PASSWORD=<...> node scripts/publish-test-batch.mjs
import mqtt from 'mqtt';

const { MQTT_URL, MQTT_USERNAME, MQTT_PASSWORD } = process.env;

const HOSPITAL = 'bcch';
const BED = 'bcch-nicu-bed-01';
const UNIT = 'nicu';
const now = new Date().toISOString();

const PHILIPS = 'sim-bcch-bed-01-philips-monitor';
const DRAGER = 'sim-bcch-bed-01-drager-ventilator';

function envelope(device_id, vendor, protocol, observations) {
  return {
    schema_version: '1.0',
    message_type: 'DeviceObservationBatch',
    unique_device_identifier: device_id,
    presentation_time: now,
    hospital_id: HOSPITAL,
    unit_id: UNIT,
    bed_id: BED,
    simulated: true,
    gateway_id: 'jetson-bcch-01',
    vendor,
    protocol,
    observations,
  };
}

function obs(metric_id, unit_id, value, quality = 'valid') {
  return {
    metric_id,
    vendor_metric_id: metric_id,
    instance_id: 0,
    unit_id,
    value,
    quality,
    device_time: null,
  };
}

const batches = [
  {
    topic: `hospitals/${HOSPITAL}/devices/${PHILIPS}/observations`,
    payload: envelope(PHILIPS, 'philips', 'intellivue_udp', [
      obs('NOM_ECG_CARD_BEAT_RATE', 'NOM_DIM_BEAT_PER_MIN', 145.0),
      obs('NOM_PULS_OXIM_SAT_O2', 'NOM_DIM_PERCENT', 96.0),
      obs('NOM_RESP_RATE', 'NOM_DIM_RESP_PER_MIN', 46.0),
      obs('NOM_TEMP', 'NOM_DIM_DEGC', 36.8),
      // lead_off test: value null, quality lead_off
      obs('NOM_ECG_ELEC_POTL_II', 'NOM_DIM_MILLI_VOLT', null, 'lead_off'),
    ]),
  },
  {
    topic: `hospitals/${HOSPITAL}/devices/${DRAGER}/observations`,
    payload: envelope(DRAGER, 'drager', 'drager_sim', [
      obs('NOM_VENT_CONC_AWAY_O2', 'NOM_DIM_PERCENT', 28.0),
    ]),
  },
];

const client = mqtt.connect(MQTT_URL, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  clientId: 'impact-test-publisher',
  protocolVersion: 5,
});

client.on('connect', async () => {
  try {
    for (const { topic, payload } of batches) {
      await new Promise((resolve, reject) => {
        // observations are QoS 0, not retained
        client.publish(topic, JSON.stringify(payload), { qos: 0 }, (err) =>
          err ? reject(err) : resolve(),
        );
      });
      console.log(
        `published ${payload.observations.length} observations to ${topic}`,
      );
    }
    // QoS 0 is fire-and-forget; give the packets time to flush to the broker
    // before closing the socket, otherwise a fast end() can drop the last one.
    await new Promise((r) => setTimeout(r, 500));
    client.end(false, () => process.exit(0));
  } catch (err) {
    console.error('publish failed:', err.message);
    client.end(true, () => process.exit(1));
  }
});

client.on('error', (err) => {
  console.error('mqtt error:', err.message);
  client.end(true, () => process.exit(1));
});
