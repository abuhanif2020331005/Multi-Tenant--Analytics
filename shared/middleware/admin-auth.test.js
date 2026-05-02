const { extractAdminToken, isAdminAuthorized } = require('./admin-auth');

describe('admin auth helper', () => {
  test('allows requests when no admin token is configured', () => {
    expect(isAdminAuthorized({ headers: {} }, '')).toBe(true);
  });

  test('accepts x-admin-token header', () => {
    const req = { headers: { 'x-admin-token': 'secret' } };

    expect(extractAdminToken(req)).toBe('secret');
    expect(isAdminAuthorized(req, 'secret')).toBe(true);
  });

  test('accepts bearer token header', () => {
    const req = { headers: { authorization: 'Bearer secret' } };

    expect(extractAdminToken(req)).toBe('secret');
    expect(isAdminAuthorized(req, 'secret')).toBe(true);
  });

  test('rejects mismatched tokens', () => {
    expect(isAdminAuthorized({ headers: { 'x-admin-token': 'wrong' } }, 'secret')).toBe(false);
  });
});
