import dgram from 'node:dgram'
import dns from 'node:dns'
import net from 'node:net'

// Runtime detection: Check if running in Bun
const isBun = typeof process.versions.bun !== 'undefined'

// GELF over UDP has a max payload size of 8192 bytes (uncompressed)
const MAX_UDP_MESSAGE_BYTES = 8192

// Messages held while the Bun socket starts or while the kernel send buffer
// is full. When full, the oldest message is dropped.
const MAX_PENDING_MESSAGES = 1000

// How long a resolved host address is reused before it is looked up again.
// node:dgram would otherwise do a DNS lookup for every message, and Bun's UDP
// socket only sends to IP addresses.
const ADDRESS_REFRESH_MS = 60_000

// Type definitions for Bun's UDP API (connected socket)
interface BunUdpSocket {
  /** Returns false when the packet was not sent (send buffer full) */
  send(data: string | Uint8Array): boolean
  close(): void
}

interface BunGlobal {
  Bun?: {
    udpSocket: (opts: {
      // Sending through a connected socket skips the per-packet address
      // handling of send(data, port, address)
      connect: { hostname: string; port: number }
      socket: {
        // Typed by Bun as (socket, error), but Bun 1.4 passes only the error
        error?: (...args: unknown[]) => void
        drain?: (socket: BunUdpSocket) => void
      }
    }) => Promise<BunUdpSocket>
  }
}

export interface UdpClientOpts {
  host: string
  port: number
  onError?: (error: Error, context?: Record<string, unknown>) => void
}

/**
 * UDP client for sending GELF messages to Graylog.
 * UDP is connectionless and fire-and-forget - no delivery guarantee.
 *
 * Supports both Node.js (dgram) and Bun (Bun.udpSocket) runtimes.
 * Bun's native UDP socket is faster than node:dgram in Bun. It is created
 * asynchronously, so messages sent before it is ready are held in a small
 * buffer and sent as soon as it is.
 *
 * In Bun the socket is connected to the Graylog address, which makes each
 * send cheaper. Bun.udpSocket() only accepts IP addresses, so the host name is
 * resolved here (IPv4, like node:dgram's 'udp4') and looked up again every
 * ADDRESS_REFRESH_MS; when the address changes, a new socket replaces the old
 * one. If the socket cannot be set up, the client falls back to node:dgram.
 */
export class UdpClient {
  private nodeSocket: dgram.Socket | null = null
  private bunSocket: BunUdpSocket | null = null
  private bunSocketInitializing = false
  // IPv4 address the Bun socket is connected to
  private bunAddress = ''
  private bunSocketReplacing = false
  private addressRefreshTimer: NodeJS.Timeout | null = null
  // Cached lookup of `host` for node:dgram, shared by concurrent sends
  private cachedAddress: Promise<string> | null = null
  private cachedAddressExpires = 0
  private pending: string[] = []
  private droppedCount = 0
  // Incremented by close(), so a Bun socket that finishes starting after its
  // client was closed (or reconnected) is discarded
  private generation = 0
  private readonly host: string
  private readonly port: number
  private readonly handleError: (
    error: Error,
    context?: Record<string, unknown>,
  ) => void

  constructor(opts: UdpClientOpts) {
    this.host = opts.host
    this.port = opts.port
    this.handleError =
      opts.onError ??
      ((error, context) => {
        console.error('UDP client error:', error.message, context || {})
      })
  }

  /**
   * Initialize the UDP socket.
   * Uses Bun.udpSocket() if running in Bun, otherwise Node's dgram.
   */
  connect(): void {
    if (this.nodeSocket || this.bunSocket || this.bunSocketInitializing) return

    if (isBun && (globalThis as unknown as BunGlobal).Bun?.udpSocket) {
      this.connectBun()
    } else {
      this.connectNode()
    }
  }

  private connectNode(): void {
    this.nodeSocket = dgram.createSocket({
      type: 'udp4',
      // IP addresses need no lookup
      lookup: net.isIP(this.host) ? undefined : this.lookupCached,
    })

    this.nodeSocket.on('error', (err) => {
      this.handleError(err, {
        host: this.host,
        port: this.port,
        reason: 'UDP socket error',
      })
    })
  }

  private connectBun(): void {
    const Bun = (globalThis as unknown as BunGlobal).Bun
    if (!Bun?.udpSocket) return

    this.bunSocketInitializing = true
    const generation = this.generation

    this.resolveHost()
      .then((address) => {
        this.bunAddress = address
        return this.createBunSocket(address)
      })
      .then((socket) => {
        // If client was closed while initializing, clean up immediately
        if (generation !== this.generation) {
          socket.close()
          return
        }
        this.bunSocketInitializing = false

        this.bunSocket = socket
        this.startAddressRefresh()
        this.sendPending()
      })
      .catch((err) => {
        if (generation !== this.generation) return
        this.bunSocketInitializing = false

        this.handleError(err, {
          host: this.host,
          port: this.port,
          reason: 'Failed to set up Bun UDP socket, using node:dgram',
        })

        // Fall back to node:dgram and send what was held
        this.connectNode()
        const held = this.pending
        this.pending = []
        for (const message of held) this.sendNode(message)
      })
  }

  private createBunSocket(address: string): Promise<BunUdpSocket> {
    const Bun = (globalThis as unknown as BunGlobal).Bun
    if (!Bun?.udpSocket) {
      return Promise.reject(new Error('Bun.udpSocket is not available'))
    }
    return Bun.udpSocket({
      connect: { hostname: address, port: this.port },
      socket: {
        error: (...args: unknown[]) => this.handleBunSocketError(args),
        // The kernel send buffer has room again
        drain: () => this.sendPending(),
      },
    })
  }

  /**
   * Connects a new Bun socket to `address` and swaps it in. Until it is
   * ready, messages keep going through the current socket.
   */
  private replaceBunSocket(address: string): void {
    if (this.bunSocketReplacing) return
    this.bunSocketReplacing = true
    const generation = this.generation
    this.createBunSocket(address)
      .then((socket) => {
        if (generation !== this.generation) {
          socket.close()
          return
        }
        const previous = this.bunSocket
        this.bunSocket = socket
        this.bunAddress = address
        previous?.close()
        this.sendPending()
      })
      .catch(() => {
        // Keep sending to the last known address
      })
      .finally(() => {
        if (generation === this.generation) this.bunSocketReplacing = false
      })
  }

  /**
   * dns.lookup() replacement for node:dgram that resolves `host` at most once
   * per ADDRESS_REFRESH_MS instead of once per message.
   */
  private readonly lookupCached = (
    hostname: string,
    _options: unknown,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string,
      family: number,
    ) => void,
  ): void => {
    if (hostname !== this.host) {
      dns.lookup(hostname, { family: 4 }, callback)
      return
    }

    const now = Date.now()
    if (!this.cachedAddress || now >= this.cachedAddressExpires) {
      const lookup = this.resolveHost()
      this.cachedAddress = lookup
      this.cachedAddressExpires = now + ADDRESS_REFRESH_MS
      // Don't cache failures: the next message looks the host up again
      lookup.catch(() => {
        if (this.cachedAddress === lookup) this.cachedAddress = null
      })
    }

    this.cachedAddress.then(
      (address) => callback(null, address, 4),
      (err) => callback(err, '', 4),
    )
  }

  private handleBunSocketError(args: unknown[]): void {
    const error =
      args.find((arg): arg is Error => arg instanceof Error) ??
      new Error('Unknown UDP socket error (Bun)')

    // Bun reports ICMP "port unreachable" for every packet sent while nothing
    // listens on the Graylog port. node:dgram ignores these for unconnected
    // sockets, and UDP is fire-and-forget, so ignore them too rather than
    // reporting an error for every log line.
    if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') return

    this.handleError(error, {
      host: this.host,
      port: this.port,
      reason: 'UDP socket error (Bun)',
    })
  }

  private async resolveHost(): Promise<string> {
    if (net.isIPv4(this.host)) return this.host
    const { address } = await dns.promises.lookup(this.host, { family: 4 })
    return address
  }

  private startAddressRefresh(): void {
    if (net.isIPv4(this.host)) return
    const generation = this.generation
    this.addressRefreshTimer = setInterval(() => {
      this.resolveHost()
        .then((address) => {
          if (generation === this.generation && address !== this.bunAddress) {
            this.replaceBunSocket(address)
          }
        })
        .catch(() => {
          // Keep sending to the last known address
        })
    }, ADDRESS_REFRESH_MS)
    // Don't keep the process alive just to refresh the address
    this.addressRefreshTimer.unref()
  }

  /**
   * Send a message via UDP.
   * UDP is fire-and-forget - no guarantee of delivery.
   */
  send(message: string, callback?: (error?: Error | null) => void): void {
    if (!this.nodeSocket && !this.bunSocket && !this.bunSocketInitializing) {
      this.connect()
    }

    // Reject oversized messages to prevent truncation/rejection by Graylog
    // TODO: Implement GELF chunking for messages > 8192 bytes
    // UTF-8 needs at most 3 bytes per UTF-16 code unit, so shorter messages
    // fit without counting their bytes.
    const size =
      message.length * 3 <= MAX_UDP_MESSAGE_BYTES
        ? 0
        : Buffer.byteLength(message)
    if (size > MAX_UDP_MESSAGE_BYTES) {
      const error = new Error(
        `GELF UDP message exceeds ${MAX_UDP_MESSAGE_BYTES} bytes (${size}). Message rejected. Consider using TCP/TLS for large messages or implement chunking.`,
      )
      this.handleError(error, {
        messageSize: size,
        maxSize: MAX_UDP_MESSAGE_BYTES,
      })
      callback?.(error)
      return
    }

    if (this.bunSocket || this.bunSocketInitializing) {
      this.sendBun(message, callback)
      return
    }

    this.sendNode(message, callback)
  }

  private sendBun(
    message: string,
    callback?: (error?: Error | null) => void,
  ): void {
    // Keep order: only send directly when nothing is waiting
    if (this.bunSocket && this.pending.length === 0) {
      try {
        if (this.bunSocket.send(message)) {
          callback?.(null)
          return
        }
        // Send buffer full: hold the message until drain
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        this.handleError(error, {
          host: this.host,
          port: this.port,
          reason: 'UDP send error (Bun)',
        })
        callback?.(error)
        return
      }
    }

    this.hold(message)
    // Fire-and-forget: the caller does not wait for a held message
    callback?.(null)
  }

  private hold(message: string): void {
    if (this.pending.length >= MAX_PENDING_MESSAGES) {
      this.pending.shift()
      this.droppedCount++
      if (this.droppedCount % 100 === 1) {
        this.handleError(
          new Error('UDP send buffer full, dropping oldest messages'),
          {
            host: this.host,
            port: this.port,
            droppedCount: this.droppedCount,
          },
        )
      }
    }
    this.pending.push(message)
  }

  private sendPending(): void {
    const socket = this.bunSocket
    if (!socket || this.pending.length === 0) return

    let sent = 0
    try {
      while (sent < this.pending.length && socket.send(this.pending[sent])) {
        sent++
      }
    } catch (err) {
      // Drop the message that failed so it cannot block the rest
      sent++
      this.handleError(err instanceof Error ? err : new Error(String(err)), {
        host: this.host,
        port: this.port,
        reason: 'UDP send error (Bun)',
      })
    }
    this.pending.splice(0, sent)
  }

  private sendNode(
    message: string,
    callback?: (error?: Error | null) => void,
  ): void {
    if (!this.nodeSocket) {
      callback?.()
      return
    }
    this.nodeSocket.send(message, this.port, this.host, (err) => {
      if (err) {
        this.handleError(err, {
          host: this.host,
          port: this.port,
          reason: 'UDP send error',
        })
      }
      callback?.(err)
    })
  }

  /**
   * Check if the UDP client can accept messages.
   * UDP is connectionless, so this is true once a socket exists or is being
   * created (messages are held until it is ready).
   */
  isReady(): boolean {
    return (
      this.nodeSocket !== null ||
      this.bunSocket !== null ||
      this.bunSocketInitializing
    )
  }

  /**
   * Close the UDP socket. Messages still held for the Bun socket are dropped.
   */
  close(): void {
    this.generation++
    this.bunSocketInitializing = false
    this.bunSocketReplacing = false
    this.pending = []
    if (this.addressRefreshTimer) {
      clearInterval(this.addressRefreshTimer)
      this.addressRefreshTimer = null
    }

    if (this.nodeSocket) {
      this.nodeSocket.close()
      this.nodeSocket = null
    }
    if (this.bunSocket) {
      this.bunSocket.close()
      this.bunSocket = null
    }
  }
}
