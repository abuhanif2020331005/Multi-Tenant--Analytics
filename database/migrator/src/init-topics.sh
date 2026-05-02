#!/bin/sh
# Wait for Redpanda to be ready, then create required Kafka topics.
# Run this as a one-shot container or as part of the migrator startup.

BROKER="${KAFKA_BROKERS:-redpanda:9092}"
TOPICS="${KAFKA_TOPICS:-user-events,fraud-alerts,recommendation-updates}"
PARTITIONS="${KAFKA_PARTITIONS:-3}"
REPLICATION="${KAFKA_REPLICATION_FACTOR:-1}"
RETRIES=30

echo "Waiting for Redpanda broker at $BROKER..."
i=0
until rpk cluster info --brokers "$BROKER" > /dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge "$RETRIES" ]; then
    echo "Broker not ready after $RETRIES attempts. Exiting."
    exit 1
  fi
  echo "  attempt $i/$RETRIES – sleeping 2s"
  sleep 2
done

echo "Broker is ready. Creating topics..."
for TOPIC in $(echo "$TOPICS" | tr ',' ' '); do
  if rpk topic describe "$TOPIC" --brokers "$BROKER" > /dev/null 2>&1; then
    echo "  Topic '$TOPIC' already exists – skipping"
  else
    rpk topic create "$TOPIC" \
      --brokers "$BROKER" \
      --partitions "$PARTITIONS" \
      --replicas "$REPLICATION"
    echo "  Created topic '$TOPIC'"
  fi
done

echo "Topic initialization complete."
