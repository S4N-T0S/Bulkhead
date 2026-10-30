// A minimal SOCKS5 listener that genuinely connects out, so the suite can
// hold a working custom exit without a tunnel. No auth, CONNECT only; the
// runner binds it to 127.0.0.1, so nothing is exposed off the machine.
import net from 'node:net'

/** @param {Buffer} buf */
function parseConnect (buf) {
  if (buf.length < 7 || buf[0] !== 0x05) return null
  const atyp = buf[3]
  let host, off
  if (atyp === 0x01) {
    host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
    off = 8
  } else if (atyp === 0x03) {
    const len = buf[4]
    host = buf.subarray(5, 5 + len).toString('utf8')
    off = 5 + len
  } else {
    return null
  }
  if (buf.length < off + 2) return null
  return { host, port: buf.readUInt16BE(off) }
}

/**
 * @param {(target: { host: string, port: number }) => void} [onConnect] sees
 *   every destination this listener is asked to carry
 * @param {(target: { host: string, port: number }) => { host: string, port: number }} [resolve]
 *   where to really connect, for names that exist only in the test
 */
export function socksServer (onConnect, resolve = target => target) {
  /** @type {Set<net.Socket>} */
  const live = new Set()
  const server = net.createServer((sock) => {
    live.add(sock)
    sock.on('close', () => live.delete(sock))
    sock.on('error', () => {})
    sock.once('data', () => {
      sock.write(Buffer.from([0x05, 0x00]))
      sock.once('data', (req) => {
        const target = parseConnect(req)
        if (!target) {
          sock.end()
          return
        }
        if (onConnect) onConnect(target)
        const to = resolve(target)
        const up = net.connect(to.port, to.host, () => {
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          sock.pipe(up)
          up.pipe(sock)
        })
        up.on('error', () => sock.destroy())
        sock.on('close', () => up.destroy())
      })
    })
  })
  // Stop listening and drop every open connection, so the port refuses
  // outright instead of a kept-alive connection carrying on.
  return Object.assign(server, {
    kill () {
      server.close()
      for (const s of live) s.destroy()
    }
  })
}
