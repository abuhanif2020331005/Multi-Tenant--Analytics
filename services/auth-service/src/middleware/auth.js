const jwt = require('jsonwebtoken');
const { authenticateRequest } = require('../../../../shared/middleware/auth');

module.exports = authenticateRequest(jwt);
