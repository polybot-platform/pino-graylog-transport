import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import type net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { expect } from 'chai'
import graylogTransport from '../../lib/graylog-transport'

/** Creates a self-signed certificate for localhost and 127.0.0.1 with openssl */
function createCertificate(): { cert: string; key: string } | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graylog-tls-test-'))
  const certPath = path.join(dir, 'cert.pem')
  const keyPath = path.join(dir, 'key.pem')
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout',
        keyPath,
        '-out',
        certPath,
      ],
      { stdio: 'ignore' },
    )
    return {
      cert: fs.readFileSync(certPath, 'utf8'),
      key: fs.readFileSync(keyPath, 'utf8'),
    }
  } catch {
    return null
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('TLS Options', function () {
  this.timeout(10000)

  let certificate: { cert: string; key: string } | null = null
  let server: tls.Server
  let port = 0
  let received: string[] = []

  before(async function () {
    certificate = createCertificate()
    if (!certificate) this.skip() // openssl not available

    server = tls.createServer(certificate, (socket) => {
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('data', (data) => {
        buffer += data
        const frames = buffer.split('\0')
        buffer = frames.pop() ?? ''
        received.push(...frames)
      })
      socket.on('error', () => {})
    })
    // A client that rejects the certificate resets the connection
    server.on('tlsClientError', () => {})
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as net.AddressInfo).port
  })

  after(() => {
    server?.close()
  })

  beforeEach(() => {
    received = []
  })

  it('should connect to a server whose certificate is signed by the given ca', async () => {
    const errors: Error[] = []
    const stream = graylogTransport({
      host: '127.0.0.1',
      port,
      protocol: 'tls',
      tls: { ca: certificate?.cert },
      onError: (error) => errors.push(error),
    })

    try {
      stream.write(JSON.stringify({ msg: 'over tls' }))
      await stream.flush(2000)
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(errors).to.deep.equal([])
      expect(received.map((m) => JSON.parse(m).short_message)).to.deep.equal([
        'over tls',
      ])
    } finally {
      stream.destroy()
    }
  })

  it('should still verify the certificate when tls options leave it out', async () => {
    const errors: Error[] = []
    const stream = graylogTransport({
      host: '127.0.0.1',
      port,
      protocol: 'tls',
      tls: { minVersion: 'TLSv1.2' },
      onError: (error) => errors.push(error),
    })

    try {
      stream.write(JSON.stringify({ msg: 'not sent' }))
      await new Promise((resolve) => setTimeout(resolve, 500))

      expect(received).to.deep.equal([])
      expect(errors.map((e) => e.message).join(' ')).to.match(/self[- ]signed/i)
    } finally {
      stream.destroy()
    }
  })
})
