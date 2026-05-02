function createLogger(service) {
  function emit(level, event, fields = {}) {
    const payload = {
      timestamp: new Date().toISOString(),
      level,
      service,
      event,
      ...fields,
    };

    const line = JSON.stringify(payload);
    if (level === 'error') {
      console.error(line);
      return;
    }

    console.log(line);
  }

  return {
    info(event, fields) {
      emit('info', event, fields);
    },
    warn(event, fields) {
      emit('warn', event, fields);
    },
    error(event, fields) {
      emit('error', event, fields);
    },
  };
}

function serializeError(error) {
  if (!error) {
    return null;
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

module.exports = {
  createLogger,
  serializeError,
};
