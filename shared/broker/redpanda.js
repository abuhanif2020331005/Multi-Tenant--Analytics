const { createRequire } = require('module');
const { withRetry } = require('../utils/retry');

function resolveKafkaJs() {
  try {
    return require('kafkajs');
  } catch (localError) {
    try {
      const serviceRequire = createRequire(`${process.cwd()}/package.json`);
      return serviceRequire('kafkajs');
    } catch (serviceError) {
      return null;
    }
  }
}

function splitBrokers(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function createDisabledBroker(reason) {
  return {
    enabled: false,
    reason,
    async connectProducer() {},
    async publishBatch() {
      return { published: 0 };
    },
    async startConsumer() {},
    async disconnect() {},
  };
}

function createRedpandaBroker(options) {
  const {
    clientId,
    logger,
    brokers = splitBrokers(process.env.KAFKA_BROKERS || process.env.REDPANDA_BROKERS || 'redpanda:9092'),
    topic = process.env.KAFKA_TOPIC || 'user-events',
    groupId = process.env.KAFKA_CONSUMER_GROUP || `${clientId}-group`,
    enabled = String(process.env.BROKER_ENABLED || 'false').toLowerCase() === 'true',
  } = options || {};

  if (!enabled) {
    return createDisabledBroker('BROKER_ENABLED is false');
  }

  const KafkaJs = resolveKafkaJs();
  if (!KafkaJs) {
    return createDisabledBroker('kafkajs dependency is not installed');
  }

  const { Kafka, logLevel } = KafkaJs;
  const kafka = new Kafka({
    clientId,
    brokers,
    logLevel: logLevel.NOTHING,
  });

  const producer = kafka.producer();
  const consumer = kafka.consumer({ groupId });
  let producerConnected = false;
  let consumerConnected = false;

  return {
    enabled: true,
    topic,
    brokers,
    groupId,
    async connectProducer() {
      if (!producerConnected) {
        await producer.connect();
        producerConnected = true;
        logger?.info('broker_producer_connected', { brokers, topic });
      }
    },
    async publishBatch(messages) {
      if (!messages || messages.length === 0) {
        return { published: 0 };
      }

      await this.connectProducer();
      await withRetry(
        () => producer.send({
          topic,
          messages: messages.map((message) => ({
            key: message.key,
            value: JSON.stringify(message.value),
            headers: message.headers,
          })),
        }),
        {
          attempts: 3,
          baseDelayMs: 300,
          operationName: 'broker_publish',
          logger,
          shouldRetry: (err) => !err.message?.includes('unknown topic'),
        }
      );

      return { published: messages.length };
    },
    async startConsumer(onMessage) {
      if (consumerConnected) {
        return;
      }

      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: false });
      consumerConnected = true;
      logger?.info('broker_consumer_connected', { brokers, topic, groupId });

      await consumer.run({
        eachMessage: async ({ topic: currentTopic, partition, message }) => {
          let payload = null;
          try {
            payload = JSON.parse(message.value?.toString('utf8') || '{}');
          } catch (error) {
            logger?.error('broker_message_parse_failed', {
              topic: currentTopic,
              partition,
              offset: message.offset,
              error: {
                message: error.message,
              },
            });
            return;
          }

          await onMessage({
            topic: currentTopic,
            partition,
            offset: message.offset,
            key: message.key?.toString('utf8') || null,
            headers: message.headers || {},
            value: payload,
          });
        },
      });
    },
    async disconnect() {
      const actions = [];

      if (producerConnected) {
        actions.push(producer.disconnect());
        producerConnected = false;
      }

      if (consumerConnected) {
        actions.push(consumer.disconnect());
        consumerConnected = false;
      }

      await Promise.all(actions);
    },
  };
}

module.exports = {
  createRedpandaBroker,
};
