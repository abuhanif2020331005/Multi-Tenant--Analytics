/**
 * Lightweight gRPC client factory using @grpc/grpc-js + @grpc/proto-loader.
 *
 * Falls back gracefully when grpc packages are not installed.
 * Services that need gRPC must add @grpc/grpc-js and @grpc/proto-loader
 * to their own package.json.
 *
 * Usage:
 *   const { createGrpcClient } = require('../../../shared/grpc/client');
 *   const authClient = createGrpcClient('AuthService', 'auth-service:9001');
 *   const { valid, claims } = await authClient.call('ValidateToken', { token });
 */

const path = require('path');

const PROTO_PATH = path.join(__dirname, 'platform.proto');

function resolveGrpc() {
  try {
    return {
      grpc: require('@grpc/grpc-js'),
      protoLoader: require('@grpc/proto-loader'),
    };
  } catch {
    return null;
  }
}

let _packageDef = null;
let _grpcObj = null;

function loadProto() {
  if (_packageDef) return { packageDef: _packageDef, grpcObj: _grpcObj };

  const deps = resolveGrpc();
  if (!deps) return null;

  const { grpc, protoLoader } = deps;

  _packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  _grpcObj = grpc.loadPackageDefinition(_packageDef).platform;
  return { packageDef: _packageDef, grpcObj: _grpcObj, grpc };
}

function createGrpcClient(serviceName, address, options = {}) {
  const proto = loadProto();

  if (!proto) {
    return {
      enabled: false,
      reason: '@grpc/grpc-js or @grpc/proto-loader not installed',
      async call() {
        throw new Error(`gRPC client for ${serviceName} is not available (packages not installed)`);
      },
    };
  }

  const { grpcObj, grpc } = proto;
  const ServiceClass = grpcObj[serviceName];

  if (!ServiceClass) {
    return {
      enabled: false,
      reason: `Service ${serviceName} not found in proto`,
      async call() {
        throw new Error(`gRPC service ${serviceName} not defined in platform.proto`);
      },
    };
  }

  const credentials = options.tls
    ? grpc.credentials.createSsl(
        options.tls.rootCert || null,
        options.tls.privateKey || null,
        options.tls.certChain || null
      )
    : grpc.credentials.createInsecure();

  const client = new ServiceClass(address, credentials, {
    'grpc.keepalive_time_ms': 30_000,
    'grpc.keepalive_timeout_ms': 5_000,
    'grpc.max_reconnect_backoff_ms': 10_000,
    ...(options.channelOptions || {}),
  });

  const deadlineMs = options.deadlineMs || 10_000;

  function call(method, request) {
    return new Promise((resolve, reject) => {
      const deadline = new Date(Date.now() + deadlineMs);
      client[method](request, { deadline }, (error, response) => {
        if (error) return reject(error);
        resolve(response);
      });
    });
  }

  function close() {
    client.close();
  }

  return { enabled: true, call, close, address, serviceName };
}

/**
 * Create a gRPC server for a given service definition.
 * handlers: { MethodName: async (call) => responseObject }
 */
function createGrpcServer(serviceName, handlers, options = {}) {
  const proto = loadProto();

  if (!proto) {
    return {
      enabled: false,
      reason: '@grpc/grpc-js or @grpc/proto-loader not installed',
      start() {},
      stop() {},
    };
  }

  const { grpcObj, grpc } = proto;
  const ServiceClass = grpcObj[serviceName];

  if (!ServiceClass) {
    return {
      enabled: false,
      reason: `Service ${serviceName} not found in proto`,
      start() {},
      stop() {},
    };
  }

  const server = new grpc.Server();

  // Wrap async handlers into gRPC callback style
  const wrappedHandlers = {};
  for (const [method, fn] of Object.entries(handlers)) {
    wrappedHandlers[method] = async (call, callback) => {
      try {
        const result = await fn(call.request, call.metadata);
        callback(null, result);
      } catch (error) {
        callback({
          code: grpc.status.INTERNAL,
          message: error.message,
        });
      }
    };
  }

  server.addService(ServiceClass.service, wrappedHandlers);

  const port = options.port || 9000;
  const credentials = options.tls
    ? grpc.ServerCredentials.createSsl(
        options.tls.rootCert || null,
        [{ private_key: options.tls.privateKey, cert_chain: options.tls.certChain }]
      )
    : grpc.ServerCredentials.createInsecure();

  function start() {
    return new Promise((resolve, reject) => {
      server.bindAsync(`0.0.0.0:${port}`, credentials, (error, boundPort) => {
        if (error) return reject(error);
        server.start();
        resolve(boundPort);
      });
    });
  }

  function stop() {
    return new Promise((resolve) => server.tryShutdown(resolve));
  }

  return { enabled: true, start, stop, port };
}

module.exports = { createGrpcClient, createGrpcServer };
