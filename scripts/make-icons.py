"""Gera os ícones PNG da extensão (seta de download sobre círculo azul) sem dependências."""
import struct, zlib, sys, os

def render(size, ss=4):
    n = size * ss
    px = []
    c = n / 2
    for y in range(size):
        row = bytearray()
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    X, Y = (x * ss + sx + .5) / n, (y * ss + sy + .5) / n
                    col = None
                    if (X - .5) ** 2 + (Y - .5) ** 2 <= .25:
                        col = (37, 99, 235)
                        shaft = abs(X - .5) <= .07 and .2 <= Y <= .55
                        head = .45 <= Y <= .68 and abs(X - .5) <= (.68 - Y) * 1.1
                        bar = abs(X - .5) <= .22 and .74 <= Y <= .8
                        if shaft or head or bar:
                            col = (255, 255, 255)
                    if col:
                        acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; acc[3] += 255
            k = ss * ss
            a = acc[3] / k
            row += bytes([int(acc[0] / (acc[3] / 255)) if acc[3] else 0,
                          int(acc[1] / (acc[3] / 255)) if acc[3] else 0,
                          int(acc[2] / (acc[3] / 255)) if acc[3] else 0, int(a)])
        px.append(b'\x00' + bytes(row))
    raw = b''.join(px)
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

out = sys.argv[1]
for s in (16, 32, 48, 128):
    with open(os.path.join(out, f'icon-{s}.png'), 'wb') as f:
        f.write(render(s))
