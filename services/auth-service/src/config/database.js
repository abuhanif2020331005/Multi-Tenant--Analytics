const { Pool } = require('pg');
const { createPgPool } = require('../../../../shared/config/database');

module.exports = createPgPool(Pool, 'auth-service');
