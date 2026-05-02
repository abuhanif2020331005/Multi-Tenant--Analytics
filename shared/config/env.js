function validateEnv(serviceName, requiredKeys) {
  const missingKeys = requiredKeys.filter((key) => {
    const value = process.env[key];
    return value === undefined || value === null || String(value).trim() === '';
  });

  if (missingKeys.length > 0) {
    const error = new Error(
      `[${serviceName}] Missing required environment variables: ${missingKeys.join(', ')}`
    );
    error.code = 'MISSING_ENV_VARS';
    throw error;
  }
}

module.exports = { validateEnv };
