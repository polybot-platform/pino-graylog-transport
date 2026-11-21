import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import { expect } from 'chai'
import { FlushManager } from '../../lib/flush-manager'
import { formatGelfMessage } from '../../lib/gelf-formatter'
import graylogTransport from '../../lib/graylog-transport'
import { MessageQueue } from '../../lib/message-queue'

/** A local port that nothing listens on */
async function closedPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('Error Handling', () => {
  describe('Stream stays usable', () => {
    it('should not destroy the stream when a UDP message is too large', async () => {
      const receiver = dgram.createSocket('udp4')
      const received: string[] = []
      receiver.on('message', (msg) => received.push(msg.toString()))
      await new Promise<void>((resolve) =>
        receiver.bind(0, '127.0.0.1', resolve),
      )

      const errors: Error[] = []
      const stream = graylogTransport({
        host: '127.0.0.1',
        port: receiver.address().port,
        protocol: 'udp',
        onError: (error) => errors.push(error),
      })
      let streamError: Error | null = null
      stream.on('error', (err) => {
        streamError = err
      })

      try {
        stream.write(JSON.stringify({ msg: 'x'.repeat(10_000) }))
        stream.write(JSON.stringify({ msg: 'after' }))
        await wait(200)

        expect(streamError).to.equal(null)
        expect(stream.destroyed).to.equal(false)
        expect(errors.some((e) => e.message.includes('exceeds 8192'))).to.equal(
          true,
        )
        expect(received.some((m) => m.includes('"after"'))).to.equal(true)
      } finally {
        stream.destroy()
        receiver.close()
      }
    })

    it('should report a record that cannot be formatted instead of throwing', async () => {
      const errors: Error[] = []
      const stream = graylogTransport({
        autoConnect: false,
        protocol: 'tcp',
        port: await closedPort(),
        onError: (error) => errors.push(error),
      })

      // No message field, so the whole (circular) record would be stringified
      const record: Record<string, unknown> = { a: 1 }
      record.self = record

      try {
        expect(() => stream.write(record)).to.not.throw()
        await wait(10)
        expect(stream.destroyed).to.equal(false)
        expect(errors.length).to.be.greaterThan(0)
      } finally {
        stream.destroy()
      }
    })
  })

  describe('waitForDrain', () => {
    it('should call back when the socket closes before draining', () => {
      const stream = graylogTransport({ autoConnect: false, protocol: 'tcp' })
      const socket = Object.assign(new EventEmitter(), {
        write: () => false, // buffer full
        cork: () => {},
        uncork: () => {},
      })

      let called = 0
      // biome-ignore lint/suspicious/noExplicitAny: testing a private method
      ;(stream as any).writeToSocket(socket, 'msg\0', () => called++)
      expect(called).to.equal(0)

      socket.emit('close')
      expect(called).to.equal(1)
      // All three listeners are removed, so a later event does nothing
      socket.emit('drain')
      expect(called).to.equal(1)
      expect(socket.listenerCount('drain')).to.equal(0)
      expect(socket.listenerCount('error')).to.equal(0)
      stream.destroy()
    })
  })

  describe('Unreachable Graylog', () => {
    it('should report a failed connection once, not once per queued message', async () => {
      const errors: Error[] = []
      const stream = graylogTransport({
        host: '127.0.0.1',
        port: await closedPort(),
        protocol: 'tcp',
        autoConnect: false,
        onError: (error) => errors.push(error),
      })

      try {
        for (let i = 0; i < 50; i++) stream.write(JSON.stringify({ msg: i }))
        await wait(200)
        expect(errors.length).to.equal(1)

        // Within the reconnect delay, new messages don't reconnect
        for (let i = 0; i < 50; i++) stream.write(JSON.stringify({ msg: i }))
        await wait(200)
        expect(errors.length).to.equal(1)
        expect(stream.getQueueSize()).to.equal(100)
      } finally {
        stream.destroy()
      }
    })

    it('should end flush() at its timeout while a connection never completes', async () => {
      const manager = new FlushManager({
        getQueueSize: () => 1,
        isConnected: () => false,
        getSocket: () => null,
        getConnectionPromise: () => null,
        connect: () => new Promise(() => {}),
      })

      const start = Date.now()
      await manager.flush(100)
      expect(Date.now() - start).to.be.lessThan(1000)
    })
  })

  describe('GELF formatting', () => {
    it('should send a JSON array as one message, not as numbered fields', () => {
      const gelf = JSON.parse(formatGelfMessage('[1,2,3]', 'host', 'app'))
      expect(gelf.short_message).to.equal('[1,2,3]')
      expect(gelf).to.not.have.property('_0')
    })

    it('should skip a field that cannot be serialized and keep the rest', () => {
      const circular: Record<string, unknown> = {}
      circular.self = circular
      const gelf = JSON.parse(
        formatGelfMessage(
          { msg: 'hi', bad: circular, big: BigInt(1), ok: 1 },
          'host',
          'app',
        ),
      )
      expect(gelf.short_message).to.equal('hi')
      expect(gelf._ok).to.equal(1)
      expect(gelf).to.not.have.property('_bad')
      expect(gelf).to.not.have.property('_big')
    })
  })

  describe('MessageQueue', () => {
    it('should hold nothing when the queue size is 0', () => {
      const queue = new MessageQueue({
        maxSize: 0,
        dropWhenFull: false,
        onDropped: () => {},
      })
      expect(queue.enqueue('a')).to.equal(false)
      expect(queue.size()).to.equal(0)
    })
  })
})
