# pino-graylog-transport

A Pino transport module that sends log messages to Graylog using the GELF (Graylog Extended Log Format) protocol over TCP, TLS, or UDP.

Built and maintained by the team behind [Polybot](https://polybotplatform.com), a platform for building virtual assistants that perform tasks, answer questions, and connect to your tools.

## Features

- 🚀 Full support for Pino transports API
- 📦 GELF (Graylog Extended Log Format) message formatting
- 🔒 TLS, TCP, and UDP protocol support (TLS secure by default)
- 🔧 Configurable facility, host, and port
- 📊 Automatic log level conversion (Pino → Syslog)
- 🏷️ Custom field support with GELF underscore prefix
- ⚡ High-performance async message sending with buffering and reconnection logic

## Installation

```bash
npm install pino-graylog-transport pino
```

## Quick Start

```javascript
const pino = require('pino');
const transport = require('pino-graylog-transport');

const transportInstance = transport({
  host: 'graylog.example.com',
  port: 12201,
  // TLS is the default for secure transmission over networks
  // Use protocol: 'tcp' only for local development (localhost)
  protocol: 'tls',
  facility: 'my-app',
  staticMeta: {
    environment: 'production',
    service: 'api',
    version: '1.0.0'
  }
});

const logger = pino(transportInstance);

logger.info('Hello Graylog!');
```

### Running in a Worker Thread

Pino can run the transport in a worker thread with `pino.transport()`. Formatting and sending then happen outside your application's main thread:

```javascript
const pino = require('pino');

const logger = pino(pino.transport({
  target: 'pino-graylog-transport',
  options: {
    host: 'graylog.example.com',
    port: 12201,
    facility: 'my-app',
  },
}));
```

The options are copied to the worker, so they cannot contain functions: `onError` and `onReady` are only available when the transport runs in the main thread, as in the Quick Start.

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | string | `'localhost'` | Graylog server hostname |
| `port` | number | `12201` | Graylog GELF input port (standard GELF TCP port) |
| `protocol` | string | `'tls'` | Protocol to use (`'tcp'`, `'tls'`, or `'udp'`). **Default is `'tls'` for security** - uses encrypted connection to prevent exposure of sensitive data. Use `'tcp'` only for local development. Use `'udp'` for high-throughput scenarios where delivery guarantees are not required. |
| `tls` | object | `undefined` | TLS settings for `protocol: 'tls'`, passed to Node's [`tls.connect()`](https://nodejs.org/api/tls.html#tlsconnectoptions-callback): for example `ca`, `cert` and `key`, `servername`, or `minVersion`. The server certificate is always verified unless you set `rejectUnauthorized: false`. See [Using a Private Certificate Authority](#using-a-private-certificate-authority). |
| `facility` | string | `hostname` | **Application/service identifier** sent with every message. Used to categorize logs by application in Graylog (e.g., `'api-gateway'`, `'auth-service'`). Sent as `_facility` additional field per [GELF spec](https://go2docs.graylog.org/current/getting_in_log_data/gelf.html). |
| `hostname` | string | `os.hostname()` | Host field in GELF messages (the machine/server name) |
| `staticMeta` | object | `{}` | Static fields included in **every** log message (e.g., auth tokens, environment, datacenter). These are sent as GELF custom fields with underscore prefix. |
| `maxQueueSize` | number | `1000` | Max messages to queue when disconnected. While Graylog cannot be reached, the transport retries the connection after about 1 second, doubling the delay up to 30 seconds. |
| `onError` | function | `console.error` | Custom error handler. Every error is reported here: connection failures, UDP messages over 8192 bytes, and records that cannot be formatted. The stream never emits them as `'error'` events, so one failure does not stop logging. |
| `onReady` | function | `undefined` | Callback when connection is established |
| `autoConnect` | boolean | `true` | If `false`, don't establish connection on initialization. Only applies to TCP/TLS; UDP always initializes immediately since it's connectionless. |

### ⚠️ Security Note

The default protocol is **`tls`** to ensure logs are transmitted securely over encrypted connections. This is important when:
- Sending logs over untrusted networks (internet, shared corporate networks)
- Including authentication tokens in `staticMeta` (e.g., `'X-OVH-TOKEN'`)
- Logging sensitive data (PII, API keys, internal URLs)

Only use `protocol: 'tcp'` for local development when Graylog is running on `localhost`.

### Using a Private Certificate Authority

If your Graylog server uses a certificate from an internal certificate authority, pass that CA in `tls.ca`. Don't set `NODE_TLS_REJECT_UNAUTHORIZED=0`: it turns off certificate checks for every connection in the process.

```javascript
const fs = require('node:fs');
const transport = require('pino-graylog-transport');

const transportInstance = transport({
  host: 'graylog.internal.example.com',
  port: 12201,
  protocol: 'tls',
  tls: {
    ca: fs.readFileSync('/etc/ssl/internal-ca.pem'),
    // For client certificate authentication (mTLS):
    // cert: fs.readFileSync('/etc/ssl/client.pem'),
    // key: fs.readFileSync('/etc/ssl/client-key.pem'),
  },
});
```

## Using with Authentication Tokens

Some Graylog services require authentication tokens to be sent with every log message. Use `staticMeta` to include these tokens and any other metadata that should be sent with **all** log messages:

```javascript
const transport = require('pino-graylog-transport');

// Example: OVH Logs Data Platform
const stream = transport({
  host: 'bhs1.logs.ovh.com',
  port: 12202,
  protocol: 'tls',
  staticMeta: {
    'X-OVH-TOKEN': 'your-ovh-token-here'
  }
});

// Example: Generic cloud provider with token
const stream = transport({
  host: 'graylog.example.com',
  port: 12201,
  protocol: 'tls',
  staticMeta: {
    token: 'your-auth-token',
    environment: 'production',
    datacenter: 'us-east-1'
  }
});
```

All fields in `staticMeta` will be included in every GELF message with an underscore prefix (e.g., `_X-OVH-TOKEN`, `_token`, `_environment`).

## Understanding Configuration Fields

### `facility` vs `hostname` vs `staticMeta`

These three configuration options serve different purposes:

| Field | Purpose | Example | GELF Field | When to Use |
|-------|---------|---------|------------|-------------|
| `facility` | **Application/service identifier** | `'api-gateway'`, `'auth-service'` | `_facility` | Identify which application/microservice sent the log |
| `hostname` | **Machine/server identifier** | `'web-server-01'`, `'us-east-1a'` | `host` | Identify which machine/container/pod sent the log |
| `staticMeta` | **Context metadata** | `{ token: 'abc', env: 'prod' }` | `_token`, `_env` | Add authentication tokens or contextual info |

### Example: Microservices Architecture

```javascript
// API Gateway service running on server 1
transport({
  facility: 'api-gateway',        // What service?
  hostname: 'web-server-01',      // Which machine?
  staticMeta: {
    environment: 'production',    // Extra context
    region: 'us-east-1',
    version: '2.1.0'
  }
});

// Auth Service running on server 2
transport({
  facility: 'auth-service',       // What service?
  hostname: 'web-server-02',      // Which machine?
  staticMeta: {
    environment: 'production',
    region: 'us-east-1',
    version: '1.5.3'
  }
});
```

In Graylog, you can then:
- Filter by `_facility:api-gateway` to see all API gateway logs
- Filter by `host:web-server-01` to see all logs from that server
- Filter by `_environment:production` to see production logs across all services

## Local Development with Docker

This repository includes a Docker Compose configuration to run Graylog locally for testing.

### Start Graylog

```bash
npm run docker:up
# or
docker compose up -d
```

Wait about 30 seconds for Graylog to fully start, then run the setup script to create the GELF inputs:

```bash
npm run docker:setup
```

Then access the web interface at:
- URL: http://localhost:9005
- Username: `admin`
- Password: `admin`

### Stop Graylog

```bash
npm run docker:down
# or
docker compose down
```

## Usage Examples

### Basic Logging

```javascript
const pino = require('pino');
const transport = require('pino-graylog-transport');

// For local development (localhost)
const logger = pino(transport({
  host: 'localhost',
  port: 12201,
  protocol: 'tcp'  // Safe to use TCP for localhost
}));

logger.info('Application started');
logger.warn('Warning message');
logger.error('Error message');
```

### Logging with Custom Fields

```javascript
logger.info({
  userId: 123,
  action: 'login',
  ip: '192.168.1.1'
}, 'User logged in');

// In Graylog, these will appear as: _userId, _action, _ip
```

### Error Logging with Stack Traces

```javascript
try {
  throw new Error('Something went wrong!');
} catch (err) {
  logger.error({ err }, 'An error occurred');
  // Stack trace will be sent as full_message in GELF
}
```

### TCP Protocol

```javascript
const logger = pino(await transport({
  host: 'localhost',
  port: 12201,
  protocol: 'tcp'  // Use TCP instead of TLS
}));
```

### UDP Protocol

```javascript
const logger = pino(await transport({
  host: 'localhost',
  port: 12201,
  protocol: 'udp'  // Use UDP for high-throughput, fire-and-forget logging
}));
```

**Note:** UDP is connectionless and does not guarantee message delivery. Use it when:
- You need maximum throughput
- Occasional message loss is acceptable
- You're logging to a local Graylog instance
- Network reliability is high

**UDP Limitations:**
- Messages are limited to **8KB (8192 bytes)** per GELF UDP specification
- Messages exceeding this size are **rejected** (not sent)
- For large messages, use TCP or TLS protocols instead
- No delivery guarantees (fire-and-forget)

**Bun Runtime:** When running under [Bun](https://bun.sh/), the UDP transport automatically uses Bun's native `Bun.udpSocket()` API, connected to the Graylog address, for better performance. The host name is resolved once and refreshed every 60 seconds, because `Bun.udpSocket()` only sends to IP addresses; if the address changes, a new socket replaces the old one. If the Bun socket cannot be created, the transport falls back to Node's `dgram` module.

### Run the Example

```bash
# Start Graylog first
npm run docker:up

# Run the example (after installing dependencies)
npm install
node examples/basic.js

# View logs at http://localhost:9005
```

## Testing

### Install Dependencies

```bash
npm install
```

### Unit Tests

Run the library functionality tests (no external dependencies required):

```bash
npm test
# or
npm run test:unit
```

### Integration Tests

Integration tests require a running Graylog instance:

```bash
# Start Graylog first
npm run docker:up
npm run docker:setup

# Run integration tests
npm run test:integration
```

### Run All Tests

Run both unit and integration tests:

```bash
npm run test:all
```

### Load Tests with k6

Load tests use [k6](https://k6.io) to simulate high-volume logging scenarios.

#### Install k6

```bash
# macOS
brew install k6
```
```bash
# Linux
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

```bash
# Windows
choco install k6
```

#### Run Load Tests

```bash
# Start Graylog
npm run docker:up

# Setup Graylog inputs (wait for Graylog to be ready first)
npm run docker:setup

# Start the load test server
npm run start:load-server

# In another terminal, run the k6 load test
npm run test:load

# Or run a quick smoke test (20 seconds)
npm run test:smoke
```

The load test will:
- Ramp up from 0 to 50 virtual users
- Send thousands of log messages
- Measure throughput and latency
- Verify 95% success rate

## Project Structure

```
pino-graylog-transport/
├── lib/                    # Source code
│   ├── index.ts           # Main transport entry point
│   ├── gelf-formatter.ts  # GELF message formatter
│   └── graylog-transport.ts # TCP/TLS transport
├── test/                  # Tests
│   ├── unit/             # Unit tests
│   │   ├── gelf-formatter.test.ts
│   │   ├── graylog-transport.test.ts
│   │   └── integration.test.ts
│   ├── load/             # Load tests
│   │   ├── load-test.ts  # k6 load test script
│   │   ├── smoke-test.ts # k6 smoke test script
│   │   └── server.ts     # Test server for load testing
│   └── benchmark/        # Performance benchmarks
│       ├── benchmark.ts            # Microbenchmark (formatting)
│       ├── comparison-server.ts    # Server for pino vs winston test
│       └── comparison-load-test.ts # k6 comparison load test
├── examples/             # Usage examples
│   └── basic.js
├── docker-compose.yml    # Graylog local setup
└── package.json
```

## Log Level Mapping

Pino log levels are automatically converted to Syslog severity levels for Graylog:

| Pino Level | Numeric | Syslog Level | Numeric |
|------------|---------|--------------|---------|
| fatal      | 60      | Critical     | 2       |
| error      | 50      | Error        | 3       |
| warn       | 40      | Warning      | 4       |
| info       | 30      | Informational| 6       |
| debug      | 20      | Debug        | 7       |
| trace      | 10      | Debug        | 7       |

## GELF Message Format

The transport converts Pino log objects to GELF format:

- `short_message`: The log message
- `full_message`: Stack trace (if present)
- `level`: Syslog severity level
- `timestamp`: Unix timestamp
- `host`: Hostname
- `facility`: Application/service name
- `_*`: Custom fields (all Pino log object properties)

## Performance

### Load Test Results (November 2026)

The comparison load test sends HTTP requests to a server that logs one record per request, and measures how many requests per second the server handles. Each log record has about 100 fields.

- **Setup:** local machine with 18 cores, k6 with 100 virtual users, 15 seconds per scenario, scenarios run one after the other.
- **Versions:** Node.js 24.12, Bun 1.4.5, pino-graylog-transport 1.3.2.
- **Results:** the average of three runs, after one run to warm up Graylog. Every message that pino logged arrived in Graylog.

**Sending to Graylog**, which runs on the same machine:

| Logger | Node.js 24 | Bun 1.4.5 |
|--------|------------|-----------|
| No logging (baseline) | ~9,240 req/s (100%) | ~9,230 req/s (100%) |
| **Pino Graylog, worker thread (`pino.transport()`)** | **~5,900 req/s (64%)** | **~6,300 req/s (68%)** |
| Pino Graylog, main thread | ~4,750 req/s (51%) | ~4,900 req/s (53%) |
| Winston (log2gelf) | ~4,200 req/s (46%) | ~5,250 req/s (57%) |

These results include the CPU that Graylog uses to receive and index the logs on the same machine, and they vary with Graylog's load.

**Sending to a local TCP server that discards the logs:** this shows the cost of the logger alone.

| Logger | Node.js 24 | Bun 1.4.5 |
|--------|------------|-----------|
| **Pino Graylog, worker thread** | **96%** | **98%** |
| Pino Graylog, main thread | 93% | 91% |
| Winston (log2gelf) | 75% | 94% |

**Main points:**

- **Run the transport in a worker thread** (see [Running in a Worker Thread](#running-in-a-worker-thread)). Formatting and sending then happen outside the thread that handles requests.
- **Large log records cost the most.** Pino writes each record as JSON, and the transport parses it and encodes each field again as GELF. With small records (about 5 fields), the transport adds about 4 to 5 µs per log line.

### Formatting Microbenchmark

This benchmark measures only the conversion of one Pino log record (8 fields) to GELF, without network I/O. It uses [mitata](https://github.com/evanwashere/mitata).

| Benchmark | Node.js 24 | Bun 1.4.5 |
|-----------|------------|-----------|
| `JSON.stringify` of the record (for comparison) | 587 ns | 298 ns |
| **pino-graylog-transport formatter** | **1.15 µs** | **587 ns** |
| Simple GELF formatter (object, then `JSON.stringify`) | 2.33 µs | 900 ns |

### Run Benchmarks

```bash
# Run formatting microbenchmark (no network)
npm run benchmark
```

### Comparison Load Test (pino vs winston)

This test compares `pino-graylog-transport` with `winston + winston-log2gelf`:

```bash
# Start Graylog
npm run docker:up
npm run docker:setup

# Start the comparison server (in one terminal)
npm run start:comparison-server
# or, to test with Bun:
npm run start:comparison-server:bun

# Run the comparison load test (in another terminal)
npm run benchmark:load
```

The test runs four scenarios, one after the other:
- **Baseline**: No logging (measures pure HTTP overhead)
- **Pino**: pino-graylog-transport in the main thread
- **Winston**: winston + winston-log2gelf
- **Pino worker**: pino-graylog-transport in a worker thread (`pino.transport()`)

k6 reports each `*_requests` rate over the whole test, not over the scenario's 15 seconds. To get the requests per second of a scenario, divide its request count by 15. The percentages compared to the baseline are the same either way.

## License

MIT — see the [LICENSE](./LICENSE) file for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Requirements

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)

This package requires Node.js >= 22 (declared in package.json `engines`). The CI and release workflows prefer the latest Node LTS. If your local Node version is older, upgrade Node (for example, using nvm):

```bash
# Install nvm (if not present)
# https://github.com/nvm-sh/nvm#installing-and-updating

# Use latest LTS
nvm install --lts
nvm use --lts
```