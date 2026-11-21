import type net from 'node:net'
import os from 'node:os'
import { Writable } from 'node:stream'
import { FlushManager } from './flush-manager'
import { createGelfFormatter, type GelfFormatter } from './gelf-formatter'
import { MessageQueue } from './message-queue'
import { SocketConnectionManager } from './socket-connection'
import type { ErrorHandler, PinoGraylogTransportOptions } from './types'
import { UdpClient } from './udp-client'

// Re-export types for convenience
export type { PinoGraylogTransportOptions } from './types'

// Delay before reconnecting after a failed connection attempt: doubles after
// each failure, from MIN to MAX, with jitter.
const MIN_RECONNECT_DELAY_MS = 1000
const MAX_RECONNECT_DELAY_MS = 30_000

const noop = () => {}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * A Writable stream that sends logs to Graylog and exposes status methods.
 */
export class PinoGraylogTransport extends Writable {
  private socket: net.Socket | null = null
  // Socket currently corked by batchWrites(), uncorked at the end of the tick
  private corkedSocket: net.Socket | null = null
  private udpClient: UdpClient | null = null
  private connectionPromise: Promise<net.Socket> | null = null
  // Socket and cleanup of the connection attempt in progress, so that
  // _destroy() can stop it
  private connectingSocket: net.Socket | null = null
  private connectingCleanup: (() => void) | null = null
  private reconnectDelay = 0
  private nextConnectAt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private messageQueue: MessageQueue
  private flushManager: FlushManager
  private initializationAttempted = false
  private ready = false
  private closing = false
  private readonly socketManager = new SocketConnectionManager()

  private readonly host: string
  private readonly port: number
  private readonly protocol: 'tcp' | 'tls' | 'udp'
  private readonly formatGelf: GelfFormatter
  private readonly waitForDrain: boolean
  private readonly handleError: ErrorHandler
  private readonly onReady?: (success: boolean, error?: Error) => void

  constructor(opts: PinoGraylogTransportOptions) {
    super({ objectMode: true })

    this.host = opts.host ?? 'localhost'
    this.port = opts.port ?? 12201
    this.protocol = opts.protocol ?? 'tls'
    const hostname = opts.hostname ?? os.hostname()
    this.formatGelf = createGelfFormatter(
      hostname,
      opts.facility ?? hostname,
      opts.staticMeta ?? {},
    )
    this.waitForDrain =
      opts.waitForDrain === undefined ? true : Boolean(opts.waitForDrain)

    // Initialize error handler
    this.handleError =
      opts.onError ??
      ((error: Error, context?: Record<string, unknown>) => {
        console.error('Graylog transport error:', error.message, context || {})
      })
    this.onReady = opts.onReady

    // Initialize message queue
    this.messageQueue = new MessageQueue({
      maxSize: opts.maxQueueSize ?? 1000,
      dropWhenFull: opts.dropWhenFull ?? false,
      onDropped: (reason, count) => {
        this.handleError(
          new Error(
            opts.dropWhenFull
              ? 'Graylog message dropped due to full queue'
              : 'Graylog message queue overflow',
          ),
          {
            reason,
            queueSize: this.messageQueue.getMaxSize(),
            droppedCount: count,
          },
        )
      },
    })

    // Initialize flush manager
    this.flushManager = new FlushManager({
      getQueueSize: () => this.messageQueue.size(),
      isConnected: () => this.isConnected(),
      getSocket: () => this.socket,
      getConnectionPromise: () => this.connectionPromise,
      connect: () => this.connect(),
    })

    // Initialize based on protocol
    this.initializeConnection(opts.autoConnect)
  }

  // --- Public status methods ---

  /**
   * Returns true if the transport is ready to send messages.
   */
  isReady(): boolean {
    return this.ready
  }

  /**
   * Returns the number of messages currently queued.
   */
  getQueueSize(): number {
    return this.messageQueue.size()
  }

  /**
   * Returns true if the transport is connected to Graylog.
   */
  isConnected(): boolean {
    if (this.protocol === 'udp') {
      return this.udpClient?.isReady() ?? false
    }
    return this.socket !== null && !this.socket.destroyed
  }

  /**
   * Returns the number of messages that have been dropped.
   */
  getDroppedMessageCount(): number {
    return this.messageQueue.getDroppedCount()
  }

  /**
   * Returns the maximum queue size.
   */
  getMaxQueueSize(): number {
    return this.messageQueue.getMaxSize()
  }

  /**
   * Returns the number of outstanding write operations that are either currently
   * in-flight or queued to be written.
   *
   * This value is computed as:
   *   pendingWrites + messageQueue.size()
   *
   * - `pendingWrites` counts socket writes that have been issued and are being
   *   tracked because a flush is in progress (i.e. one or more callers have
   *   requested a `flush()`); these represent write operations that have been
   *   handed to the socket but have not yet completed.
   * - `messageQueue.size()` counts messages that are still enqueued and have
   *   not yet been sent to the socket (for example, when the transport is not
   *   connected).
   *
   * When to call:
   * - Call this to observe how much work remains before the transport is
   *   fully flushed (useful for monitoring or graceful shutdown logic).
   * - Note that the number is a point-in-time snapshot and may change
   *   immediately after calling (concurrent writes or flushes can increase or
   *   decrease the returned value).
   *
   * Guarantees and caveats:
   * - The method is inexpensive and safe to call from application code.
   * - Because the value is not atomic with respect to async operations, it
   *   should be used for informational/decision-making purposes only; use
   *   `flush()` to actively wait for completion.
   */
  getPendingWriteCount(): number {
    return this.flushManager.getPendingWriteCount()
  }

  /**
   * Returns true if the stream is in the process of closing.
   */
  isClosing(): boolean {
    return this.closing
  }

  /**
   * Waits for all pending writes to complete and the queue to be flushed.
   * @param timeout Maximum time to wait in milliseconds (default: 5000)
   */
  async flush(timeout = 5000): Promise<void> {
    // Don't wait for the end of the tick: the flush below waits for the
    // socket's buffer to empty, which corked data would hold up.
    this.releaseCork()
    return this.flushManager.flush(timeout)
  }

  // --- Writable implementation ---

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    // Errors are reported through onError and never passed to the stream
    // callback: that would destroy the stream, and crash the process if
    // nothing listens for 'error'. One bad record must not stop logging.
    let gelfStr: string
    try {
      gelfStr = this.formatGelf(chunk)
    } catch (err) {
      this.handleError(toError(err), {
        reason: 'Failed to format log record as GELF',
      })
      callback()
      return
    }

    // UDP: Send directly without null terminator (not required for UDP GELF)
    if (this.protocol === 'udp' && this.udpClient) {
      // UdpClient reports send errors (such as oversized messages) itself
      this.udpClient.send(gelfStr, () => callback())
      return
    }

    // TCP/TLS: Append null terminator as message delimiter
    const message = `${gelfStr}\0`

    const socket = this.socket
    if (socket && !socket.destroyed) {
      this.writeToSocket(socket, message, callback)
    } else {
      this.queueMessage(message, callback)
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.closing = true

    const finishClose = () => {
      if (this.socket && !this.socket.destroyed) {
        this.socket.end()
      }
      callback()
    }

    // Keep flushing until no more pending writes or queue items
    // This handles the case where new writes arrive during flush
    const maxRetries = 10
    const flushUntilDone = async (retries = 0): Promise<void> => {
      await this.flush()

      // Check if more writes came in during the flush. Don't retry while
      // Graylog is unreachable: each retry would wait for a connection again.
      if (
        this.getPendingWriteCount() > 0 &&
        this.isConnected() &&
        retries < maxRetries
      ) {
        return flushUntilDone(retries + 1)
      }
    }

    flushUntilDone().finally(finishClose)
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy()
    }
    // Stop a connection attempt in progress and its timeout
    this.connectingCleanup?.()
    this.connectingSocket?.destroy()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.udpClient) {
      this.udpClient.close()
    }
    callback(error)
  }

  // --- Private methods ---

  private initializeConnection(autoConnect?: boolean): void {
    if (this.protocol === 'udp') {
      // UDP is connectionless - always initialize regardless of autoConnect
      this.udpClient = new UdpClient({
        host: this.host,
        port: this.port,
        onError: this.handleError,
      })
      this.udpClient.connect()
      this.ready = true
      this.initializationAttempted = true
      if (this.onReady) {
        this.onReady(true)
      }
    } else if (autoConnect !== false) {
      // TCP/TLS: Establish initial connection unless explicitly disabled
      this.connect()
        .then(() => {
          // Connection successful
        })
        .catch((err) => {
          this.handleError(err, { reason: 'Initial Graylog connection failed' })
          if (!this.initializationAttempted && this.onReady) {
            this.initializationAttempted = true
            this.onReady(false, err)
          }
          this.ready = false
        })
    }
  }

  private writeToSocket(
    socket: net.Socket,
    message: string,
    callback: (error?: Error | null) => void,
  ): void {
    let canContinue: boolean

    this.batchWrites(socket)

    // Only track pending writes when flush is in progress (avoids overhead in normal operation)
    if (this.flushManager.trackWrite()) {
      canContinue = socket.write(message, () => {
        this.flushManager.writeComplete()
      })
    } else {
      canContinue = socket.write(message)
    }

    // Call callback immediately (fire-and-forget) unless waitForDrain is enabled
    // When socket.write() returns false, the internal buffer is full and we should wait for drain
    if (this.waitForDrain && !canContinue) {
      this.waitUntilWritable(socket, callback)
      return
    }
    callback()
  }

  /**
   * Calls callback once the socket drains, or closes or fails first. Without
   * the close and error cases, a socket lost while full would never call
   * back, and the stream would buffer every later log line without limit.
   */
  private waitUntilWritable(
    socket: net.Socket,
    callback: (error?: Error | null) => void,
  ): void {
    const done = () => {
      socket.removeListener('drain', done)
      socket.removeListener('close', done)
      socket.removeListener('error', done)
      callback()
    }
    socket.once('drain', done)
    socket.once('close', done)
    socket.once('error', done)
  }

  private queueMessage(
    message: string,
    callback: (error?: Error | null) => void,
  ): void {
    this.messageQueue.enqueue(message)
    this.scheduleConnect()
    callback()
  }

  /**
   * Connects now, or after the reconnect delay if the last attempt failed.
   * Connection errors are reported once, by connect(), not once per message.
   */
  private scheduleConnect(): void {
    if (this.connectionPromise || this.reconnectTimer || this.destroyed) {
      return
    }
    const wait = this.nextConnectAt - Date.now()
    if (wait <= 0) {
      this.connect().catch(noop)
      return
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.messageQueue.size() > 0 && !this.destroyed) {
        this.connect().catch(noop)
      }
    }, wait)
    // Don't keep the process alive just to retry
    this.reconnectTimer.unref()
  }

  private connectionFailed(): void {
    this.reconnectDelay = Math.min(
      Math.max(MIN_RECONNECT_DELAY_MS, this.reconnectDelay * 2),
      MAX_RECONNECT_DELAY_MS,
    )
    // Jitter: wait between 50% and 100% of the delay
    this.nextConnectAt =
      Date.now() + this.reconnectDelay * (0.5 + Math.random() * 0.5)
  }

  private connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) {
      return Promise.resolve(this.socket)
    }

    if (this.connectionPromise) {
      return this.connectionPromise
    }

    const attempt = new Promise<net.Socket>((resolve, reject) => {
      let cleanupFn: (() => void) | null = null
      let connected = false
      let failed = false
      // 'close' usually follows 'error': count each failed attempt once
      const fail = (error: Error) => {
        if (connected || failed) return
        failed = true
        this.connectionFailed()
        reject(error)
      }

      // Only the latest attempt may clear the shared connection state: a late
      // event from an older socket must not drop a newer connection.
      const endAttempt = () => {
        if (cleanupFn) cleanupFn()
        if (this.connectingSocket === socket) {
          this.connectingSocket = null
          this.connectingCleanup = null
        }
        if (this.connectionPromise === attempt) this.connectionPromise = null
      }

      const { socket, cleanup } = this.socketManager.createConnection({
        host: this.host,
        port: this.port,
        protocol: this.protocol,
        onConnect: () => {
          connected = true
          endAttempt()
          this.socket = socket
          this.ready = true
          this.reconnectDelay = 0
          this.nextConnectAt = 0

          if (!this.initializationAttempted && this.onReady) {
            this.initializationAttempted = true
            this.onReady(true)
          }

          // Flush queued messages
          this.flushQueuedMessages()

          resolve(socket)
        },
        onError: (error, context) => {
          endAttempt()
          this.handleError(error, context)
          if (this.socket === socket) this.socket = null
          fail(error)
        },
        onClose: () => {
          endAttempt()
          if (this.socket === socket) this.socket = null
          // Closed without an error before connecting: settle the attempt so
          // that flush() and other callers waiting for it don't hang
          fail(new Error('Graylog connection closed before it was ready'))
        },
      })

      cleanupFn = cleanup
      this.connectingSocket = socket
      this.connectingCleanup = cleanup
    })

    this.connectionPromise = attempt
    return attempt
  }

  /**
   * Corks the socket until the end of the current tick, so every message
   * logged in the same tick goes out in one system call instead of one each.
   */
  private batchWrites(socket: net.Socket): void {
    if (this.corkedSocket === socket) return
    this.corkedSocket = socket
    socket.cork()
    process.nextTick(() => {
      if (this.corkedSocket === socket) this.releaseCork()
    })
  }

  /** Sends anything batchWrites() is holding now instead of at the end of the tick. */
  private releaseCork(): void {
    const socket = this.corkedSocket
    if (!socket) return
    this.corkedSocket = null
    socket.uncork()
  }

  private flushQueuedMessages(): void {
    const messagesToFlush = this.messageQueue.flush()
    if (this.socket && messagesToFlush.length > 0) {
      this.batchWrites(this.socket)
    }
    for (const msg of messagesToFlush) {
      if (this.socket && !this.socket.destroyed) {
        if (this.flushManager.trackWrite()) {
          this.socket.write(msg, () => {
            this.flushManager.writeComplete()
          })
        } else {
          this.socket.write(msg)
        }
      }
    }
  }
}

/**
 * Factory function for creating a GraylogWritable transport.
 *
 * @param opts Options for configuring the Graylog transport.
 * @returns A GraylogWritable stream compatible with Pino's transport interface.
 */
export default function graylogTransport(
  opts: PinoGraylogTransportOptions = {},
): PinoGraylogTransport {
  return new PinoGraylogTransport(opts)
}
