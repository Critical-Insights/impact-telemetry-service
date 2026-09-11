// MQTT client (EMQX Cloud) — connects, subscribes, and routes incoming messages.
import mqtt, { type MqttClient } from 'mqtt';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { routeMessage } from '../handlers/router.js';

let client: MqttClient | null = null;
let sessionTakenOver = false;

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
      // A successful (re)connect means we hold the session again. Cleared here
      // so the health endpoint recovers once the other instance is stopped,
      // rather than staying red until restart.
      if (sessionTakenOver) {
        sessionTakenOver = false;
        logger.warn('mqtt session reclaimed after a takeover');
      }
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
      // MQTT 5 reason 142 is "session taken over": the broker accepted another
      // connection using OUR client id and evicted us. Because we connect with
      // clean:false to keep the QoS-1 queue across reconnects, the client id
      // must stay STABLE — so two instances of this service inevitably fight
      // over it, each evicting the other on every reconnect, and batches are
      // lost on both sides for as long as it lasts.
      //
      // It is silent by nature: each process logs a reconnect and looks fine.
      // Found exactly this way, running a verification instance while a
      // `pnpm dev` was already live. Loud, named, with the fix in the message.
      if (packet?.reasonCode === 142) {
        sessionTakenOver = true;
        logger.error(
          { reason: 142, client_id: config.MQTT_CLIENT_ID },
          'MQTT SESSION TAKEN OVER — another process connected with the same '
          + 'MQTT_CLIENT_ID. Both instances will now steal the subscription '
          + 'from each other and BOTH will drop batches. Stop one, or give it '
          + 'a distinct MQTT_CLIENT_ID.',
        );
        return;
      }
      logger.warn({ reason: packet?.reasonCode }, 'mqtt disconnect');
    });
  });
}

/**
 * Is the broker connection currently up?
 *
 * The health endpoint needs this as a SEPARATE signal from the ingest
 * counters. A dropped broker connection freezes the counters rather than
 * changing them, so "last landed 4s ago" stays true and healthy-looking for a
 * full stall window after the feed has actually gone. Asking the socket
 * directly makes a disconnect visible immediately instead of 60s later.
 */
export function isMqttConnected(): boolean {
  return client?.connected === true;
}

/**
 * Did the broker evict us because another process used our client id?
 *
 * Separate from the connected flag on purpose: after a takeover this client
 * reconnects and reports `connected` perfectly happily while the two
 * instances trade the subscription back and forth.
 */
export function wasSessionTakenOver(): boolean {
  return sessionTakenOver;
}

/** True once startMqtt() has created a client, regardless of socket state. */
export function isMqttStarted(): boolean {
  return client !== null;
}

export async function shutdownMqtt(): Promise<void> {
  sessionTakenOver = false;
  if (client) {
    await client.endAsync();
    client = null;
  }
}
