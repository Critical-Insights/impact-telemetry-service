// MQTT client (EMQX Cloud) — connects, subscribes, and routes incoming messages.
import mqtt, { type MqttClient } from 'mqtt';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { routeMessage } from '../handlers/router.js';

let client: MqttClient | null = null;

export async function startMqtt(): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = mqtt.connect(config.MQTT_URL, {
      username: config.MQTT_USERNAME,
      password: config.MQTT_PASSWORD,
      clientId: config.MQTT_CLIENT_ID,
      protocolVersion: 5,
      clean: false, // resume the broker session so retained/queued state survives reconnects
      reconnectPeriod: 2000,
    });
    client = c;

    let settled = false;

    c.on('connect', () => {
      logger.info('connected to mqtt');
      c.subscribe(config.MQTT_TOPIC_FILTER, { qos: 1 }, (err) => {
        if (err) {
          logger.error({ err }, 'failed to subscribe');
          if (!settled) {
            settled = true;
            reject(err);
          }
          return;
        }
        logger.info({ filter: config.MQTT_TOPIC_FILTER }, 'subscribed');
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });

    c.on('message', (topic, payload) => {
      void routeMessage(topic, payload);
    });

    c.on('error', (err) => {
      logger.error({ err }, 'mqtt error');
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    c.on('reconnect', () => {
      logger.warn('mqtt reconnecting');
    });

    c.on('close', () => {
      logger.warn('mqtt connection closed');
    });

    c.on('disconnect', (packet) => {
      logger.warn({ reason: packet?.reasonCode }, 'mqtt disconnect');
    });
  });
}

export async function shutdownMqtt(): Promise<void> {
  if (client) {
    await client.endAsync();
    client = null;
  }
}
