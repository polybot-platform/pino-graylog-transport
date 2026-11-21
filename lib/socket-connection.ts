import net from 'node:net'
import tls from 'node:tls'

export interface SocketConnectionOpts {
  host: string
  port: number
  protocol: 'tcp' | 'tls' | 'udp'
  onConnect: () => void
  onError: (error: Error, context: Record<string, unknown>) => void
  onClose: () => void
}

/**
 * Creates a TCP or TLS socket connection.
 *
 * Bun implements node:net and node:tls natively, so the same code is used in
 * both runtimes. (Bun.connect() returns a Promise of a socket with a different
 * API, which this transport's net.Socket handling does not support.)
 */
export class SocketConnectionManager {
  createConnection(opts: SocketConnectionOpts): {
    socket: net.Socket
    cleanup: () => void
  } {
    let socket: net.Socket
    let connectionTimeout: NodeJS.Timeout

    const cleanup = () => {
      if (connectionTimeout) {
        clearTimeout(connectionTimeout)
      }
    }

    connectionTimeout = setTimeout(() => {
      const timeoutError = new Error('Graylog connection timeout')
      try {
        if (socket) {
          socket.destroy()
        }
      } catch (_e) {}
      opts.onError(timeoutError, { reason: 'Connection timeout' })
    }, 10000)

    if (opts.protocol === 'tcp') {
      socket = this.createNodeTcpConnection(opts, connectionTimeout)
    } else {
      socket = this.createTlsConnection(opts, connectionTimeout)
    }

    return { socket, cleanup }
  }

  private createNodeTcpConnection(
    opts: SocketConnectionOpts,
    connectionTimeout: NodeJS.Timeout,
  ): net.Socket {
    const socket = net.createConnection(
      { host: opts.host, port: opts.port },
      () => {
        clearTimeout(connectionTimeout)
        opts.onConnect()
      },
    )
    socket.setNoDelay(true)
    socket.setKeepAlive(true)
    this.attachSocketHandlers(socket, opts, connectionTimeout, 'TCP')
    return socket
  }

  private createTlsConnection(
    opts: SocketConnectionOpts,
    connectionTimeout: NodeJS.Timeout,
  ): net.Socket {
    const socket = tls.connect(
      { host: opts.host, port: opts.port, rejectUnauthorized: true },
      () => {
        clearTimeout(connectionTimeout)
        opts.onConnect()
      },
    )
    socket.setNoDelay(true)
    socket.setKeepAlive(true)
    this.attachSocketHandlers(socket, opts, connectionTimeout, 'TLS')
    return socket
  }

  private attachSocketHandlers(
    socket: net.Socket,
    opts: SocketConnectionOpts,
    connectionTimeout: NodeJS.Timeout,
    protocol: string,
  ): void {
    socket.on('error', (err: Error) => {
      clearTimeout(connectionTimeout)
      opts.onError(err, {
        host: opts.host,
        port: opts.port,
        reason: `${protocol} connection error`,
      })
    })

    socket.on('close', () => {
      clearTimeout(connectionTimeout)
      opts.onClose()
    })
  }
}
