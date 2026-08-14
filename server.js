'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');
const OpenAI = require('openai');
const crypto = require('crypto');
const multer = require('multer');

dotenv.config();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT) || 3000;

const BLACKPAYMENTS_API_URL = String(process.env.BLACKPAYMENTS_API_URL || 'https://api.blackpayments.pro').replace(/\/+$/, '');
const BLACKPAYMENTS_PUBLIC_KEY = String(process.env.BLACKPAYMENTS_PUBLIC_KEY || '').trim();
const BLACKPAYMENTS_SECRET_KEY = String(process.env.BLACKPAYMENTS_SECRET_KEY || '').trim();
const DEFAULT_CUSTOMER_EMAIL = process.env.PIX_CUSTOMER_EMAIL || 'email001989887@gmail.com';
const DEFAULT_CUSTOMER_PHONE = onlyDigits(process.env.PIX_CUSTOMER_PHONE || '11987289871');
// Mantida por compatibilidade com a configuração anterior; o cronômetro visual do
// checkout usa sempre uma janela local de 15 minutos.
const PIX_EXPIRES_IN_DAYS = Math.max(1, Number.parseInt(process.env.PIX_EXPIRES_IN_DAYS || '1', 10));
const BLACKPAYMENTS_POSTBACK_URL = String(process.env.BLACKPAYMENTS_POSTBACK_URL || process.env.PIX_POSTBACK_URL || '').trim();

// Dados do Usuário Padrão (Fallback para evitar perda de vendas)
const FALLBACK_CPF = '53347866860';
const FALLBACK_SHIPPING = {
  street: 'Avenida Paulista',
  number: '1000',
  neighborhood: 'Bela Vista',
  city: 'São Paulo',
  state: 'SP',
  zipCode: '01310100'
};

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── MULTER: UPLOAD DE COMPROVANTES ──
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = `${Date.now()}-${crypto.randomUUID()}${ext}`;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/gif',
      'image/webp'
    ];
    const allowedExt = ['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(file.mimetype) && allowedExt.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de arquivo não permitido. Aceito: PDF, JPG, PNG, GIF, WEBP.'));
    }
  }
});

// Serve uploaded files
app.use('/uploads', express.static(UPLOAD_DIR));

const server = http.createServer(app);
const io = new Server(server);

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function isValidCpf(value) {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;

  const calculateDigit = length => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(cpf[index]) * (length + 1 - index);
    }
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };

  return calculateDigit(9) === Number(cpf[9]) && calculateDigit(10) === Number(cpf[10]);
}

function getBlackPaymentsAuthorization() {
  if (!BLACKPAYMENTS_PUBLIC_KEY || !BLACKPAYMENTS_SECRET_KEY) return '';
  return `Basic ${Buffer.from(`${BLACKPAYMENTS_PUBLIC_KEY}:${BLACKPAYMENTS_SECRET_KEY}`).toString('base64')}`;
}

function normalizeAmount(value) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100000000) return null;
  return amount;
}

function normalizeItems(items, amount) {
  if (!Array.isArray(items) || items.length === 0) {
    return [{ title: 'Venda Online', unitPrice: amount, quantity: 1, tangible: true }];
  }

  const normalized = items.slice(0, 20).map((item, index) => {
    const title = 'Venda Online';
    const unitPrice = Number(item && item.unitPrice);
    const quantity = Number(item && item.quantity);

    if (!title || !Number.isSafeInteger(unitPrice) || unitPrice <= 0 ||
        !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 100) {
      throw new Error('ITEM_INVALID');
    }

    return {
      title,
      unitPrice,
      quantity,
      tangible: true,
    };
  });

  const itemsTotal = normalized.reduce((total, item) => total + item.unitPrice * item.quantity, 0);
  if (itemsTotal !== amount) {
    return [{ title: 'Venda Online', unitPrice: amount, quantity: 1, tangible: true }];
  }

  return normalized;
}

function parseShippingAddress(rawAddress, rawZipCode) {
  const address = String(rawAddress || '').replace(/,?\s*CEP:\s*\d{5}-?\d{3}\s*$/i, '').trim();
  const zipCode = onlyDigits(rawZipCode);
  const parts = address.split(',').map(part => part.trim()).filter(Boolean);

  if (!address || zipCode.length !== 8 || parts.length < 3) {
    throw new Error('SHIPPING_INVALID');
  }

  const street = parts[0];
  const numberAndDetails = parts[1] || '';
  const streetNumberMatch = numberAndDetails.match(/\d+[A-Za-z0-9-]*/);
  const streetNumber = streetNumberMatch ? streetNumberMatch[0] : 'S/N';
  const inlineDetails = numberAndDetails
    .replace(streetNumber, '')
    .replace(/^\s*[-–—]\s*/, '')
    .split(/\s+[-–—]\s+/)
    .map(part => part.trim())
    .filter(Boolean);

  let state = '';
  let city = '';
  let cityIndex = -1;
  for (let index = parts.length - 1; index >= 1; index -= 1) {
    const match = parts[index].match(/^(.*?)\s*(?:\/|\-|–|—)\s*([A-Za-z]{2})$/);
    if (match) {
      city = match[1].trim();
      state = match[2].toUpperCase();
      cityIndex = index;
      break;
    }
  }

  if (!city || !state) {
    throw new Error('SHIPPING_INVALID');
  }

  const separateNeighborhood = cityIndex > 2 ? parts[cityIndex - 1] : '';
  const neighborhood = separateNeighborhood || inlineDetails[inlineDetails.length - 1] || '';
  const complementParts = separateNeighborhood ? inlineDetails : inlineDetails.slice(0, -1);
  const complement = complementParts.join(' - ');
  if (!street || !neighborhood) throw new Error('SHIPPING_INVALID');

  return {
    street: street.slice(0, 120),
    number: streetNumber.slice(0, 20),
    neighborhood: neighborhood.slice(0, 80),
    city: city.slice(0, 80),
    state,
    zipCode,
    ...(complement ? { complement: complement.slice(0, 120) } : {}),
  };
}

const pixAttempts = new Map();
function limitPixRequests(req, res, next) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const recent = (pixAttempts.get(key) || []).filter(timestamp => now - timestamp < windowMs);

  if (recent.length >= 5) {
    return res.status(429).json({
      success: false,
      code: 'RATE_LIMITED',
      message: 'Muitas tentativas de geração de PIX. Aguarde alguns minutos e tente novamente.',
    });
  }

  recent.push(now);
  pixAttempts.set(key, recent);
  return next();
}

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'compra-checkout' });
});

// ── ENDPOINT DE UPLOAD DE COMPROVANTES ──
app.post('/api/upload-receipt', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Nenhum arquivo recebido.' });
    }

    // Normalize userId to prevent duplicates
    const rawUserId = req.body.userId || 'anon';
    const userId = rawUserId.startsWith('user-') ? rawUserId.replace(/^user-/, '') : rawUserId;
    const sender = req.body.sender || 'Cliente';
    const filename = req.file.filename;
    const mimetype = req.file.mimetype;
    const originalName = req.file.originalname;
    const size = req.file.size;
    const fileUrl = `/uploads/${filename}`;

    const attachment = {
      url: fileUrl,
      filename: originalName,
      mimetype,
      size,
      serverFilename: filename,
    };

    console.log(`Comprovante recebido de ${userId}: ${originalName} (${size} bytes)`);

    return res.json({
      success: true,
      attachment
    });
  } catch (err) {
    console.error('Erro no upload:', err.message);
    return res.status(500).json({ success: false, error: 'Erro ao processar o arquivo.' });
  }
});

app.post('/api/chat', async (req, res) => {
  const { message, context, userId, url } = req.body;
  // Normalize userId to prevent duplicates
  const normalizedId = userId.startsWith('user-') ? userId.replace(/^user-/, '') : userId;
  console.log(`Mensagem recebida de ${normalizedId}: ${message} (URL: ${url})`);

  const userMessage = { userId: normalizedId, sender: 'Usuário', text: message, timestamp: new Date().toISOString(), url };
  if (!chatHistory[normalizedId]) chatHistory[normalizedId] = [];
  chatHistory[normalizedId].push(userMessage);
  io.to('admins').emit('new_message_for_admin', userMessage);

  if (!openai) {
    return res.status(503).json({
      reply: 'O atendimento por IA está temporariamente indisponível.',
      code: 'OPENAI_NOT_CONFIGURED',
    });
  }

  try {
    const messagesForOpenAI = [];
    if (context) messagesForOpenAI.push({ role: 'system', content: context });
    messagesForOpenAI.push({ role: 'user', content: message });

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
      messages: messagesForOpenAI,
      max_tokens: 150,
      temperature: 0.7,
    });

    const agentReply = completion.choices[0].message.content;
    const agentMessage = { userId: normalizedId, sender: 'Mateus', text: agentReply, timestamp: new Date().toISOString() };
    if (!chatHistory[normalizedId]) chatHistory[normalizedId] = [];
    chatHistory[normalizedId].push(agentMessage);
    io.to('admins').emit('new_message_for_admin', agentMessage);
    return res.json({ reply: agentReply });
  } catch (error) {
    console.error('Erro ao chamar a API do OpenAI:', error.response ? error.response.data : error.message);
    return res.status(500).json({ error: 'Erro ao processar sua solicitação com a IA.' });
  }
});

app.post('/api/pix', limitPixRequests, async (req, res) => {
  const requestId = crypto.randomUUID();

  try {
    let payerName = String(req.body.payer_name || '').trim().replace(/\s+/g, ' ');
    let payerCpf = onlyDigits(req.body.payer_cpf);
    const amount = normalizeAmount(req.body.amount);
    const payerEmail = req.body.payer_email;

    // Fallback para Nome e CPF se forem inválidos
    if (payerName.length < 3 || payerName.length > 120) {
      payerName = 'Cliente Online';
    }
    
    if (!isValidCpf(payerCpf)) {
      console.warn(`[${requestId}] CPF inválido (${payerCpf}). Usando CPF padrão.`);
      payerCpf = FALLBACK_CPF;
    }

    if (!amount) {
      return res.status(400).json({ success: false, code: 'INVALID_AMOUNT', message: 'Valor do pagamento inválido.' });
    }

    const authorization = getBlackPaymentsAuthorization();
    if (!authorization) {
      console.error(`[${requestId}] Chaves pública/secreta do BlackPayments ausentes.`);
      return res.status(503).json({ success: false, code: 'PAYMENT_NOT_CONFIGURED', message: 'Pagamento temporariamente indisponível.' });
    }

    let items;
    let shippingAddress;
    try {
      items = normalizeItems(req.body.items, amount);
      shippingAddress = parseShippingAddress(req.body.shipping && req.body.shipping.address, req.body.shipping && req.body.shipping.zipCode);
    } catch (validationError) {
      const isItemError = validationError.message === 'ITEM_INVALID';
      
      if (isItemError) {
        return res.status(400).json({ success: false, code: 'INVALID_ITEMS', message: 'Dados dos produtos inválidos.' });
      }

      // Fallback para Endereço se for inválido
      console.warn(`[${requestId}] Endereço inválido. Usando endereço padrão.`);
      shippingAddress = FALLBACK_SHIPPING;
    }

    // Lógica para gerar e-mail dinâmico e único por cliente (CPF)
    let customerEmail = payerEmail;
    if (!customerEmail) {
      const [user, domain] = DEFAULT_CUSTOMER_EMAIL.split('@');
      if (user && domain) {
        customerEmail = `${user}+${payerCpf}@${domain}`;
      } else {
        customerEmail = `c${payerCpf}@cliente-pix.com.br`;
      }
    }

    const externalRef = `compra-${requestId}`;
    const payload = {
      amount,
      paymentMethod: 'pix',
      pix: {
        expiresInDays: PIX_EXPIRES_IN_DAYS,
      },
      items: items.map(item => ({
        title: item.title,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        tangible: item.tangible,
      })),
      customer: {
        name: payerName,
        email: customerEmail,
        phone: DEFAULT_CUSTOMER_PHONE,
        document: {
          type: 'cpf',
          number: payerCpf,
        },
      },
      shipping: {
        fee: 0,
        address: {
          street: shippingAddress.street,
          streetNumber: shippingAddress.number,
          ...(shippingAddress.complement ? { complement: shippingAddress.complement } : {}),
          zipCode: shippingAddress.zipCode,
          neighborhood: shippingAddress.neighborhood,
          city: shippingAddress.city,
          state: shippingAddress.state,
          country: 'BR',
        },
      },
      ...(BLACKPAYMENTS_POSTBACK_URL ? { postbackUrl: BLACKPAYMENTS_POSTBACK_URL } : {}),
      metadata: JSON.stringify({ source: 'compra-checkout', requestId }),
      externalRef,
      ...(req.ip ? { ip: req.ip } : {}),
    };

    const gatewayResponse = await axios.post(`${BLACKPAYMENTS_API_URL}/v1/transactions`, payload, {
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 20000,
    });

    const gatewayBody = gatewayResponse.data || {};
    const transaction = gatewayBody && gatewayBody.data ? gatewayBody.data : gatewayBody;
    const pixData = transaction && transaction.pix ? transaction.pix : {};
    const pixCode = pixData.qrcode || pixData.qrCode || pixData.copyPaste || pixData.copypaste;

    if (!pixCode || typeof pixCode !== 'string') {
      console.error(`[${requestId}] Resposta do BlackPayments sem data.pix.qrcode.`, {
        status: gatewayResponse.status,
        transactionId: transaction && (transaction.id || gatewayBody.objectId),
      });
      return res.status(502).json({
        success: false,
        code: 'INVALID_GATEWAY_RESPONSE',
        message: 'O provedor não retornou um código PIX válido.',
      });
    }

    return res.json({
      success: true,
      transactionId: String(transaction.id || gatewayBody.objectId || externalRef),
      pixCode,
      expiresAt: pixData.expirationDate || null,
    });
  } catch (error) {
    const gatewayStatus = error.response && error.response.status;
    const gatewayMessage = error.response && error.response.data && error.response.data.message
      ? String(error.response.data.message).slice(0, 300)
      : error.message;

    console.error(`[${requestId}] Erro ao gerar PIX no BlackPayments (${gatewayStatus || 'sem status'}): ${gatewayMessage}`);

    return res.status(502).json({
      success: false,
      code: 'PIX_GATEWAY_ERROR',
      message: 'Não foi possível gerar o PIX agora. Tente novamente em instantes.',
    });
  }
});

const users = {};
const chatHistory = {}; // Armazenamento em memória para o histórico de chat

io.on('connection', socket => {
  console.log(`Usuário conectado: ${socket.id}`);

  socket.on('join', ({ userId, isAdmin }) => {
    // Normalize userId: remove "user-" prefix if present to avoid duplicates
    const normalizedId = userId.startsWith('user-') ? userId.replace(/^user-/, '') : userId;
    socket.userId = normalizedId;
    if (isAdmin) {
      socket.join('admins');
      // Normalize all userIds in chatHistory to prevent duplicates in admin
      const normalizedHistory = Object.entries(chatHistory).flatMap(([uid, msgs]) => {
        const normalizedId = uid.startsWith('user-') ? uid.replace(/^user-/, '') : uid;
        return msgs.map(m => ({ ...m, userId: normalizedId }));
      });
      socket.emit('chat_history', normalizedHistory);
    } else {
      socket.join(normalizedId);
    }
    users[normalizedId] = socket.id;
    console.log(`${isAdmin ? 'Admin' : 'Usuário'} ${normalizedId} entrou.`);
  });

  socket.on('send_message', data => {
    const { userId, text, sender, isAuto, attachment } = data;
    // Normalize userId to prevent duplicates
    const normalizedId = userId.startsWith('user-') ? userId.replace(/^user-/, '') : userId;
    const message = { userId: normalizedId, text, sender, timestamp: new Date().toISOString() };
    // Passa attachment se existir
    if (attachment) message.attachment = attachment;
    if (!chatHistory[normalizedId]) chatHistory[normalizedId] = [];
    chatHistory[normalizedId].push(message);

    console.log(`Mensagem de ${sender} (${normalizedId}): ${text}${attachment ? ' (com anexo)' : ''}`);
    
    // Envia para todos os admins conectados
    io.to('admins').emit('new_message_for_admin', message);
  });

  socket.on('disconnect', () => {
    console.log(`Usuário desconectado: ${socket.id}`);
    for (const userId in users) {
      if (users[userId] === socket.id) {
        delete users[userId];
        break;
      }
    }
  });
});

app.get("/",(req,res)=>{res.sendFile(path.join(__dirname,"index.html"));});

app.get("/admin",(req,res)=>{res.sendFile(path.join(__dirname,"admin.html"));});

// Catch-all para servir index.html para qualquer outra rota não definida
app.get("/*",(req,res)=>{res.sendFile(path.join(__dirname,"index.html"));});

server.listen(PORT, () => {
  console.log(`Servidor unificado rodando na porta ${PORT}`);
});
