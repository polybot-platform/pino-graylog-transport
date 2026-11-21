/**
 * Shared types for the pino-graylog-transport package.
 */

import type { ConnectionOptions } from 'node:tls'

/**
 * TLS settings for `protocol: 'tls'`, passed to `tls.connect()`. The host and
 * port come from the transport options.
 */
export type GraylogTlsOptions = Omit<
  ConnectionOptions,
  'host' | 'port' | 'socket' | 'path'
>

/**
 * Configuration options for the Graylog transport.
 */
export type PinoGraylogTransportOptions = {
  // Connection configuration
  /** Graylog server hostname (default: 'localhost') */
  host?: string
  /** Graylog server port (default: 12201) */
  port?: number
  /** Protocol to use for connection (default: 'tls') */
  protocol?: 'tcp' | 'tls' | 'udp'
  /**
   * TLS settings for protocol 'tls', passed to `tls.connect()`. For example
   * `ca` for an internal certificate authority, `cert` and `key` for client
   * certificates (mTLS), `servername`, or `minVersion`. The server
   * certificate is always verified unless this sets
   * `rejectUnauthorized: false`, which should only be done for testing.
   */
  tls?: GraylogTlsOptions

  // Static metadata sent with every log message (e.g., tokens, environment, tags)
  /** Static metadata to include with every log message */
  staticMeta?: Record<string, unknown>

  // Log metadata
  /** GELF facility field (default: hostname) */
  facility?: string
  /** GELF host field (default: os.hostname()) */
  hostname?: string

  // Callbacks
  /** Error handler callback */
  onError?: (error: Error, context?: Record<string, unknown>) => void
  /** Ready state callback, called when connection is established or fails */
  onReady?: (success: boolean, error?: Error) => void

  // Queue configuration
  /** Maximum number of messages to queue when disconnected (default: 1000) */
  maxQueueSize?: number
  /** If true, wait for socket 'drain' before signaling write completion (default: true) */
  waitForDrain?: boolean
  /** If true, drop new messages when internal queue is full; otherwise drop oldest (default: false) */
  dropWhenFull?: boolean
  /**
   * If false, do not attempt to connect automatically in constructor.
   * Only applies to TCP/TLS; UDP always initializes since it's connectionless.
   * (default: true)
   */
  autoConnect?: boolean
}

/**
 * Error handler function type.
 */
export type ErrorHandler = (
  error: Error,
  context?: Record<string, unknown>,
) => void
