const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const { createClient } = require('@supabase/supabase-js')
const express = require('express')
const qrcode = require('qrcode-terminal')
const QRCode = require('qrcode')
const pino = require('pino')
const ws = require('ws')

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY
const PORT = process.env.PORT || 3000

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { transport: ws }
})

const app = express()
app.use(express.json())

let sock = null
let lastQR = null

const PALABRAS_SI = ['si', 'sí', 'yes', '1', 'confirmo', 'ahi estare', 'ahí estaré', 'voy', 'asistiré', 'asistire', 'claro', 'por supuesto', '✅']
const PALABRAS_NO = ['no', '2', 'no podre', 'no podré', 'no puedo', '❌']

const detectar = (texto) => {
  const t = texto.toLowerCase().trim()
  if (PALABRAS_SI.some(p => t.includes(p))) return 'confirmado'
  if (PALABRAS_NO.some(p => t.includes(p))) return 'no_asiste'
  return null
}

const delay = (ms) => new Promise(r => setTimeout(r, ms))

async function connectWA() {
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      lastQR = qr
      console.log('QR listo — visita /qr en tu navegador')
      qrcode.generate(qr, { small: true })
    }
    if (connection === 'open') {
      lastQR = null
      console.log('✓ WhatsApp conectado')
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code !== DisconnectReason.loggedOut) {
        console.log('Reconectando...')
        setTimeout(connectWA, 3000)
      } else {
        console.log('Sesión cerrada. Visita /qr para reconectar.')
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (msg.key.fromMe || msg.key.remoteJid?.includes('@g.us')) continue
      const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
      if (!texto) continue
      const numero = msg.key.remoteJid.replace('@s.whatsapp.net', '')
      console.log(`📩 ${numero}: "${texto}"`)

      const { data: inv } = await supabase.from('invitados').select('*').eq('telefono', numero).maybeSingle()
      if (!inv || !inv.mensaje2_enviado || inv.estado !== 'pendiente') continue

      const estado = detectar(texto)
      if (!estado) continue

      await supabase.from('invitados').update({ estado }).eq('id', inv.id)
      console.log(`  ✓ ${inv.nombre} → ${estado}`)

      const respuesta = estado === 'confirmado'
        ? `¡Perfecto ${inv.nombre}! 🎉 Tu asistencia ha sido confirmada. ¡Te esperamos!`
        : `Entendido ${inv.nombre}, lamentamos que no puedas asistir. ¡Gracias por avisarnos!`

      await sock.sendMessage(msg.key.remoteJid, { text: respuesta })
    }
  })
}

// ─── ENDPOINTS ───────────────────────────────────────────
app.get('/', (_, res) => res.json({
  status: 'ok',
  whatsapp: sock?.user ? 'connected' : 'connecting'
}))

app.get('/qr', async (_, res) => {
  if (!lastQR) return res.send('<html><body style="background:#111;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h2>✓ Ya conectado o esperando QR...</h2></body></html>')
  const img = await QRCode.toDataURL(lastQR)
  res.send(`<html><body style="background:#111;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0"><p style="color:#fff;font-family:sans-serif;margin-bottom:16px">Escanea con WhatsApp → Dispositivos vinculados</p><img src="${img}" style="border-radius:12px"/></body></html>`)
})

app.post('/blast', async (req, res) => {
  const { tipo } = req.body
  if (!tipo) return res.status(400).json({ error: 'Falta tipo' })
  res.json({ ok: true })

  ;(async () => {
    const { data: msg } = await supabase.from('mensajes').select('*').eq('tipo', tipo).maybeSingle()
    if (!msg) return console.error('No hay mensaje para', tipo)

    const campo = tipo === 'mensaje1' ? 'mensaje1_enviado' : 'mensaje2_enviado'
    const { data: invitados } = await supabase.from('invitados').select('*').eq(campo, false).order('nombre')
    if (!invitados?.length) return console.log('Sin pendientes')

    console.log(`📤 Blast ${tipo} → ${invitados.length} invitados`)

    for (let i = 0; i < invitados.length; i++) {
      const inv = invitados[i]
      const texto = msg.texto.replace(/\{nombre\}/g, inv.nombre)
      const jid = `${inv.telefono}@s.whatsapp.net`

      try {
        if (msg.imagen_url && tipo === 'mensaje1') {
          await sock.sendMessage(jid, { image: { url: msg.imagen_url }, caption: texto })
        } else {
          const textoFinal = tipo === 'mensaje2' ? `${texto}\n\n${msg.boton_si}\n${msg.boton_no}` : texto
          await sock.sendMessage(jid, { text: textoFinal })
        }
        await supabase.from('invitados').update({ [campo]: true }).eq('id', inv.id)
        console.log(`  ✓ ${i+1}/${invitados.length} ${inv.nombre}`)
      } catch (e) {
        console.error(`  ✗ ${inv.nombre}:`, e.message)
      }

      if (i < invitados.length - 1) await delay(3000)
    }
    console.log(`✓ Blast ${tipo} completado`)
  })()
})

app.listen(PORT, () => console.log(`✓ API en puerto ${PORT}`))
connectWA()
