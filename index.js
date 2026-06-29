const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const { createClient } = require('@supabase/supabase-js')
const express = require('express')
const QRCode = require('qrcode')
const pino = require('pino')
const ws = require('ws')
const https = require('https')
const http = require('http')

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY
const PORT = process.env.PORT || 3000
const SESSION_PATH = process.env.SESSION_PATH || './session'

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Faltan SUPABASE_URL y SUPABASE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { transport: ws }
})

const app = express()
app.use(express.json())

// CORS — permite cualquier origen
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Content-Security-Policy', '')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

let sock = null
let lastQR = null
let isConnected = false
let reconnectTimer = null

const PALABRAS_SI = ['si', 'sí', 'yes', '1', 'confirmo', 'ahi estare', 'ahí estaré', 'voy', 'asistire', 'asistiré', 'claro', 'por supuesto', '✅']
const PALABRAS_NO = ['no', '2', 'no podre', 'no podré', 'no puedo', 'no asistire', '❌']

const detectar = (texto) => {
  const t = texto.toLowerCase().trim()
  if (PALABRAS_SI.some(p => t.includes(p))) return 'confirmado'
  if (PALABRAS_NO.some(p => t.includes(p))) return 'no_asiste'
  return null
}

const delay = (ms) => new Promise(r => setTimeout(r, ms))

async function connectWA() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH)
    const { version } = await fetchLatestBaileysVersion()

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Bot Confirmaciones', 'Chrome', '1.0.0'],
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        lastQR = qr
        isConnected = false
        console.log('📱 QR listo — visita /qr')
      }
      if (connection === 'open') {
        lastQR = null
        isConnected = true
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
        console.log('✓ WhatsApp conectado como', sock.user?.name || sock.user?.id)
      }
      if (connection === 'close') {
        isConnected = false
        const code = lastDisconnect?.error?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          console.log('⚠️ Sesión cerrada — visita /qr')
        } else {
          console.log('Reconectando en 5s...')
          reconnectTimer = setTimeout(connectWA, 5000)
        }
      }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        try {
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
        } catch (e) {
          console.error('Error procesando mensaje:', e.message)
        }
      }
    })

  } catch (e) {
    console.error('Error conectando WhatsApp:', e.message)
    setTimeout(connectWA, 10000)
  }
}

// ─── ENDPOINTS ────────────────────────────────────────────
app.get('/', (_, res) => {
  res.json({ status: 'ok', whatsapp: isConnected ? 'connected' : lastQR ? 'qr_pending' : 'connecting' })
})

app.get('/qr', async (_, res) => {
  if (isConnected) {
    return res.send(`<html><body style="background:#111;color:#4ade80;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column"><div style="font-size:48px">✓</div><h2>WhatsApp conectado</h2></body></html>`)
  }
  if (!lastQR) {
    return res.send(`<html><head><meta http-equiv="refresh" content="3"></head><body style="background:#111;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column"><h2>⏳ Generando QR...</h2><p style="color:#888">Esta página se recarga automáticamente</p></body></html>`)
  }
  const img = await QRCode.toDataURL(lastQR, { width: 300 })
  res.send(`<html><body style="background:#111;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0"><p style="color:#fff;font-family:sans-serif;margin-bottom:16px">📱 WhatsApp → Dispositivos vinculados → Vincular dispositivo</p><img src="${img}" style="border-radius:12px"/><p style="color:#666;font-family:sans-serif;margin-top:12px;font-size:13px">El QR expira en ~20s. Si expira, recarga.</p></body></html>`)
})

app.post('/blast', async (req, res) => {
  if (!isConnected) return res.status(503).json({ error: 'WhatsApp no conectado. Visita /qr primero.' })
  const { tipo } = req.body
  if (!tipo) return res.status(400).json({ error: 'Falta tipo' })
  res.json({ ok: true })

  ;(async () => {
    try {
      const { data: msg } = await supabase.from('mensajes').select('*').eq('tipo', tipo).maybeSingle()
     if (!msg) {
      console.error('❌ No hay mensaje para', tipo)
      const { data: todos } = await supabase.from('mensajes').select('*')
      console.log('Mensajes en DB:', JSON.stringify(todos))
      return
      }

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
          console.log(`  ✓ ${i+1}/${invitados.length} — ${inv.nombre}`)
        } catch (e) {
          console.error(`  ✗ ${inv.nombre}:`, e.message)
        }
        if (i < invitados.length - 1) await delay(3500)
      }
      console.log(`✅ Blast ${tipo} completado`)
    } catch (e) {
      console.error('Error en blast:', e.message)
    }
  })()
})

// Servidor HTTP para mantener vivo en Render
const server = http.createServer(app)
server.listen(PORT, () => console.log(`✓ API en puerto ${PORT}`))
connectWA()
