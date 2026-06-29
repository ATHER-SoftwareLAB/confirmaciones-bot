const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js')
const qrcode = require('qrcode-terminal')
const { createClient } = require('@supabase/supabase-js')
const express = require('express')

// ─── CONFIG ───────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY
const PORT = process.env.PORT || 3000

const ws = require('ws')
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {realtime: { transport: ws }})
const app = express()
app.use(express.json())

// ─── WHATSAPP CLIENT ──────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './session' }),
  puppeteer: {
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  }
})

// ─── QR ───────────────────────────────────────────────────
client.on('qr', (qr) => {
  console.log('\n══════════════════════════════════')
  console.log('  Escanea este QR con WhatsApp')
  console.log('══════════════════════════════════\n')
  qrcode.generate(qr, { small: true })
  // También disponible via HTTP para verlo en Railway logs
})

client.on('authenticated', () => console.log('✓ WhatsApp autenticado'))
client.on('auth_failure', () => console.log('✗ Error de autenticación'))
client.on('ready', () => {
  console.log('✓ Bot activo y escuchando mensajes')
})

// ─── DETECTAR RESPUESTAS ──────────────────────────────────
const PALABRAS_SI = ['si', 'sí', 'yes', '1', 'confirmo', 'ahi estare', 'ahí estaré', 'voy', 'asistiré', 'asistire', 'claro', 'por supuesto', '✅']
const PALABRAS_NO = ['no', '2', 'no podre', 'no podré', 'no asistiré', 'no asistire', 'no puedo', '❌']

const detectarRespuesta = (texto) => {
  const t = texto.toLowerCase().trim()
  if (PALABRAS_SI.some(p => t.includes(p))) return 'confirmado'
  if (PALABRAS_NO.some(p => t.includes(p))) return 'no_asiste'
  return null
}

client.on('message', async (msg) => {
  try {
    // Solo mensajes de texto entrantes, no de grupos
    if (msg.fromMe || msg.from.includes('@g.us')) return

    const numero = msg.from.replace('@c.us', '')
    const texto = msg.body

    console.log(`📩 Mensaje de ${numero}: "${texto}"`)

    // Buscar invitado por teléfono
    const { data: invitado } = await supabase
      .from('invitados')
      .select('*')
      .eq('telefono', numero)
      .maybeSingle()

    if (!invitado) {
      console.log(`  → Número ${numero} no está en la lista de invitados`)
      return
    }

    // Solo procesar si ya se envió el mensaje 2 y sigue pendiente
    if (!invitado.mensaje2_enviado || invitado.estado !== 'pendiente') {
      console.log(`  → ${invitado.nombre}: ya tiene estado "${invitado.estado}" o no se ha enviado msg2`)
      return
    }

    const estado = detectarRespuesta(texto)
    if (!estado) {
      console.log(`  → No se detectó respuesta clara de ${invitado.nombre}`)
      return
    }

    // Actualizar estado en Supabase
    await supabase
      .from('invitados')
      .update({ estado, updated_at: new Date().toISOString() })
      .eq('id', invitado.id)

    console.log(`  ✓ ${invitado.nombre} → ${estado}`)

    // Respuesta automática de confirmación
    const respuesta = estado === 'confirmado'
      ? `¡Perfecto ${invitado.nombre}! 🎉 Tu asistencia ha sido confirmada. ¡Te esperamos!`
      : `Entendido ${invitado.nombre}, lamentamos que no puedas asistir. ¡Gracias por avisarnos!`

    await msg.reply(respuesta)

  } catch (err) {
    console.error('Error procesando mensaje:', err)
  }
})

// ─── API REST PARA ENVÍOS DESDE EL PANEL ─────────────────
// El panel React llama a estos endpoints para enviar mensajes

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', whatsapp: client.info ? 'connected' : 'connecting' })
})

// Enviar mensaje de texto
app.post('/send/text', async (req, res) => {
  const { telefono, mensaje } = req.body
  if (!telefono || !mensaje) return res.status(400).json({ error: 'Faltan datos' })
  try {
    await client.sendMessage(`${telefono}@c.us`, mensaje)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Enviar imagen + texto
app.post('/send/image', async (req, res) => {
  const { telefono, imagen_url, caption } = req.body
  if (!telefono || !imagen_url) return res.status(400).json({ error: 'Faltan datos' })
  try {
    const media = await MessageMedia.fromUrl(imagen_url, { unsafeMime: true })
    await client.sendMessage(`${telefono}@c.us`, media, { caption: caption || '' })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Enviar blast completo (mensaje 1 o 2) a todos los invitados pendientes
app.post('/blast', async (req, res) => {
  const { tipo } = req.body // 'mensaje1' o 'mensaje2'
  if (!tipo) return res.status(400).json({ error: 'Falta tipo' })

  res.json({ ok: true, message: 'Blast iniciado en background' })

  // Ejecutar en background
  ;(async () => {
    try {
      // Obtener configuración del mensaje
      const { data: msg } = await supabase.from('mensajes').select('*').eq('tipo', tipo).maybeSingle()
      if (!msg) return console.error('No hay mensaje configurado para', tipo)

      // Obtener invitados pendientes
      const campo = tipo === 'mensaje1' ? 'mensaje1_enviado' : 'mensaje2_enviado'
      const { data: invitados } = await supabase
        .from('invitados')
        .select('*')
        .eq(campo, false)
        .order('nombre')

      if (!invitados || invitados.length === 0) return console.log('No hay invitados pendientes para', tipo)

      console.log(`📤 Iniciando blast ${tipo} → ${invitados.length} invitados`)

      for (let i = 0; i < invitados.length; i++) {
        const inv = invitados[i]
        const texto = msg.texto.replace(/\{nombre\}/g, inv.nombre)

        try {
          // Enviar imagen si existe (solo mensaje 1 típicamente)
          if (msg.imagen_url) {
            const media = await MessageMedia.fromUrl(msg.imagen_url, { unsafeMime: true })
            await client.sendMessage(`${inv.telefono}@c.us`, media, { caption: texto })
          } else {
            // Mensaje 2: texto + opciones
            const textoFinal = tipo === 'mensaje2'
              ? `${texto}\n\n${msg.boton_si}\n${msg.boton_no}`
              : texto
            await client.sendMessage(`${inv.telefono}@c.us`, textoFinal)
          }

          // Marcar como enviado en Supabase
          await supabase.from('invitados').update({ [campo]: true }).eq('id', inv.id)
          console.log(`  ✓ ${i + 1}/${invitados.length} ${inv.nombre}`)

        } catch (e) {
          console.error(`  ✗ Error con ${inv.nombre}:`, e.message)
        }

        // Esperar 3 segundos entre mensajes
        if (i < invitados.length - 1) {
          await new Promise(r => setTimeout(r, 3000))
        }
      }

      console.log(`✓ Blast ${tipo} completado`)
    } catch (e) {
      console.error('Error en blast:', e)
    }
  })()
})

// ─── ARRANCAR ─────────────────────────────────────────────
app.listen(PORT, () => console.log(`✓ API escuchando en puerto ${PORT}`))
client.initialize()
