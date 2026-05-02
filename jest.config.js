/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/'],
  collectCoverageFrom: [
    'shared/**/*.js',
    'services/*/src/**/*.js',
    '!**/*.test.js',
  ],
  coverageReporters: ['text', 'lcov'],
  clearMocks: true,
};
