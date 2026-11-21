import net from 'node:net'
import path from 'node:path'
import { expect } from 'chai'
import { pino, transport as pinoTransport } from 'pino'
import graylogTransport from '../../lib/graylog-transport'

/** A TCP server that collects the short_message of each GELF frame */
async function startReceiver(): Promise<{
  port: number
  messages: string[]
  close: () => void
}> {
  const messages: string[] = []
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (data) => {
      buffer += data
      const frames = buffer.split('\0')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        messages.push(JSON.parse(frame).short_message)
      }
    })
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as net.AddressInfo).port,
    messages,
    close: () => {
      for (const socket of sockets) socket.destroy()
      server.close()
    },
  }
}

const waitFor = async (condition: () => boolean, timeout = 3000) => {
  const start = Date.now()
  while (!condition() && Date.now() - start < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const line = (msg: string) => `${JSON.stringify({ level: 30, msg })}\n`

describe('Line Splitting', function () {
  this.timeout(10000)

  let receiver: Awaited<ReturnType<typeof startReceiver>>

  beforeEach(async () => {
    receiver = await startReceiver()
  })

  afterEach(() => {
    receiver.close()
  })

  const createStream = () =>
    graylogTransport({
      host: '127.0.0.1',
      port: receiver.port,
      protocol: 'tcp',
    })

  it('should send each line of a chunk as its own message', async () => {
    const stream = createStream()
    stream.write(line('a') + line('b') + line('c'))
    await waitFor(() => receiver.messages.length >= 3)
    expect(receiver.messages).to.deep.equal(['a', 'b', 'c'])
    stream.destroy()
  })

  it('should join a line split across chunks', async () => {
    const stream = createStream()
    const text = line('first') + line('second') + line('third')
    const cut = text.indexOf('second') + 3
    stream.write(text.slice(0, cut))
    stream.write(text.slice(cut))
    await waitFor(() => receiver.messages.length >= 3)
    expect(receiver.messages).to.deep.equal(['first', 'second', 'third'])
    stream.destroy()
  })

  it('should send a string written without a newline as one message', async () => {
    const stream = createStream()
    stream.write('plain text\nwith a line break')
    await waitFor(() => receiver.messages.length >= 1)
    expect(receiver.messages).to.deep.equal(['plain text\nwith a line break'])
    stream.destroy()
  })

  it('should send an unfinished last line when the stream ends', async () => {
    const stream = createStream()
    stream.write(line('complete'))
    stream.write(JSON.stringify({ level: 30, msg: 'no newline' }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(receiver.messages).to.deep.equal(['complete'])

    stream.end()
    await waitFor(() => receiver.messages.length >= 2)
    expect(receiver.messages).to.deep.equal(['complete', 'no newline'])
  })

  it('should send every log as its own message when run with pino.transport()', async () => {
    const logger = pino(
      pinoTransport({
        target: path.resolve(__dirname, '../../lib/index.ts'),
        options: { host: '127.0.0.1', port: receiver.port, protocol: 'tcp' },
      }),
    )

    for (let i = 0; i < 1000; i++) logger.info({ i }, `log ${i}`)
    await waitFor(() => receiver.messages.length >= 1000, 8000)

    expect(receiver.messages.length).to.equal(1000)
    expect(receiver.messages[0]).to.equal('log 0')
    expect(receiver.messages[999]).to.equal('log 999')
    await new Promise<void>((resolve) => logger.flush(() => resolve()))
  })
})
