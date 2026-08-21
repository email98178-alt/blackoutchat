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

// A API usa a rota canônica /api/v1/transactions. A função abaixo também
// aceita uma variável BLACKPAYMENTS_API_URL que já contenha /api ou /v1.
const BLACKPAYMENTS_API_URL = String(
  process.env.BLACKPAYMENTS_API_URL || 'https://api.blackpayments.pro'
).trim().replace(/\/+$/, '');

const BLACKPAYMENTS_PUBLIC_KEY = String(
  process.env.BLACKPAYMENTS_PUBLIC_KEY || ''
).trim();

const BLACKPAYMENTS_SECRET_KEY = String(
  process.env.BLACKPAYMENTS_SECRET_KEY || ''
).trim();

const PUBLIC_BASE_URL = String(
  process.env.PUBLIC_BASE_URL || ''
).trim().replace(/\/+$/, '');

const DEFAULT_CUSTOMER_EMAIL = String(
  process.env.PIX_CUSTOMER_EMAIL || 'email001989887@gmail.com'
).trim();

const DEFAULT_CUSTOMER_PHONE = onlyDigits(
  process.env.PIX_CUSTOMER_PHONE || '11987289871'
);

const PIX_EXPIRES_IN_DAYS = Math.max(
  1,
  Number.parseInt(process.env.PIX_EXPIRES_IN_DAYS || '1', 10)
);

const BLACKPAYMENTS_POSTBACK_URL = String(
  process.env.BLACKPAYMENTS_POSTBACK_URL ||
  process.env.PIX_POSTBACK_URL ||
  (PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/api/blackpayments/postback` : '')
).trim();

// Por padrão, exige postback porque esse campo faz parte do contrato de
// transação usado por essa API. Para contas que comprovadamente aceitam
// transações sem webhook, use BLACKPAYMENTS_REQUIRE_POSTBACK=false.
const REQUIRE_POSTBACK = String(
  process.env.BLACKPAYMENTS_REQUIRE_POSTBACK || 'true'
).toLowerCase() !== 'false';

function getTransactionsUrl() {
  if (/\/api\/v1$/i.test(BLACKPAYMENTS_API_URL)) {
    return `${BLACKPAYMENTS_API_URL}/transactions`;
  }

  if (/\/api$/i.test(BLACKPAYMENTS_API_URL)) {
    return `${BLACKPAYMENTS_API_URL}/v1/transactions`;
  }

  if (/\/v1$/i.test(BLACKPAYMENTS_API_URL)) {
    return `${BLACKPAYMENTS_API_URL}/transactions`;
  }

  return `${BLACKPAYMENTS_API_URL}/api/v1/transactions`;
}

const BLACKPAYMENTS_TRANSACTIONS_URL = getTransactionsUrl();

// Dados do usuário padrão. Eles continuam apenas como fallback de
// compatibilidade; em produção, prefira exigir os dados reais do comprador.
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

// Serve uploaded files.
app.use('/uploads', express.static(UPLOAD_DIR));

const server = http.createServer(app);
const io = new Server(server);

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeUserId(value) {
  const raw = String(value || 'anon');
  return raw.startsWith('user-') ? raw.replace(/^user-/, '') : raw;
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

  return calculateDigit(9) === Number(cpf[9]) &&
    calculateDigit(10) === Number(cpf[10]);
}

function normalizeEmail(value, cpf) {
  const email = String(value || '').trim().toLowerCase();
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (emailPattern.test(email)) return email.slice(0, 160);

  const [user, domain] = DEFAULT_CUSTOMER_EMAIL.split('@');
  if (user && domain && emailPattern.test(DEFAULT_CUSTOMER_EMAIL)) {
    return `${user}+${cpf}@${domain}`.slice(0, 160);
  }

  return `c${cpf}@cliente-pix.com.br`;
}

function getBlackPaymentsAuthorization() {
  if (!BLACKPAYMENTS_PUBLIC_KEY || !BLACKPAYMENTS_SECRET_KEY) return '';

  // Basic Auth da API: chave secreta primeiro e chave pública depois.
  // Formato: Basic base64(sk_userKey:pk_userKey)
  const credentials = `${BLACKPAYMENTS_SECRET_KEY}:${BLACKPAYMENTS_PUBLIC_KEY}`;
  return `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
}

function normalizeAmount(value) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100000000) {
    return null;
  }
  return amount;
}

function normalizeItems(items, amount) {
  if (!Array.isArray(items) || items.length === 0) {
    return [{
      title: 'Venda Online',
      unitPrice: amount,
      quantity: 1,
      tangible: true
    }];
  }

  const normalized = items.slice(0, 20).map((item, index) => {
    const title = String(
      item && (item.title || item.name) || `Item ${index + 1}`
    ).trim().slice(0, 120);
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
      tangible: item && typeof item.tangible === 'boolean'
        ? item.tangible
        : true,
      ...(item && item.externalRef
        ? { externalRef: String(item.externalRef).slice(0, 120) }
        : {})
    };
  });

  const itemsTotal = normalized.reduce(
    (total, item) => total + item.unitPrice * item.quantity,
    0
  );

  // Se os itens não fecharem com o valor total, usa um item único para
  // impedir que o gateway rejeite a transação por divergência matemática.
  if (itemsTotal !== amount) {
    return [{
      title: 'Venda Online',
      unitPrice: amount,
      quantity: 1,
      tangible: true
    }];
  }

  return normalized;
}

function parseShippingAddress(rawAddress, rawZipCode) {
  const address = String(rawAddress || '')
    .replace(/,?\s*CEP:\s*\d{5}-?\d{3}\s*$/i, '')
    .trim();
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
    const stateMatch = parts[index].match(
      /^(.*?)\s*(?:\/|\-|–|—)\s*([A-Za-z]{2})$/
    );

    if (stateMatch) {
      city = stateMatch[1].trim();
      state = stateMatch[2].toUpperCase();
      cityIndex = index;
      break;
    }
  }

  if (!city || !state) throw new Error('SHIPPING_INVALID');

  const separateNeighborhood = cityIndex > 2 ? parts[cityIndex - 1] : '';
  const neighborhood = separateNeighborhood ||
    inlineDetails[inlineDetails.length - 1] || '';
  const complementParts = separateNeighborhood
    ? inlineDetails
    : inlineDetails.slice(0, -1);
  const complement = complementParts.join(' - ');

  if (!street || !neighborhood) throw new Error('SHIPPING_INVALID');

  return {
    street: street.slice(0, 120),
    number: streetNumber.slice(0, 20),
    neighborhood: neighborhood.slice(0, 80),
    city: city.slice(0, 80),
    state,
    zipCode,
    ...(complement ? { complement: complement.slice(0, 120) } : {})
  };
}

function extractPixCode(gatewayBody, transaction) {
  const pixData = transaction && transaction.pix
    ? transaction.pix
    : gatewayBody && gatewayBody.pix
      ? gatewayBody.pix
      : {};

  const candidates = [
    pixData.qrcodeText,
    pixData.qrCodeText,
    pixData.copyPaste,
    pixData.copypaste,
    pixData.payload,
    transaction && transaction.qrCodeText,
    transaction && transaction.copyPaste,
    gatewayBody && gatewayBody.qrCodeText,
    gatewayBody && gatewayBody.copyPaste,
    pixData.qrcode,
    pixData.qrCode,
    transaction && transaction.qrCode,
    gatewayBody && gatewayBody.qrCode
  ];

  const pixCode = candidates.find(value => {
    if (typeof value !== 'string') return false;
    const normalized = value.trim();
    return normalized.length > 0 && !/^data:image\//i.test(normalized);
  });

  return {
    pixData,
    pixCode: typeof pixCode === 'string' ? pixCode.trim() : null
  };
}

function extractGatewayError(error) {
  const responseData = error && error.response ? error.response.data : null;
  let message = '';

  if (typeof responseData === 'string') {
    message = responseData;
  } else if (responseData && typeof responseData === 'object') {
    message = responseData.message ||
      (responseData.error && responseData.error.message) ||
      responseData.error ||
      responseData.detail ||
      '';
  }

  return {
    status: error && error.response ? error.response.status : null,
    code: error && error.code ? error.code : null,
    message: String(message || (error && error.message) || 'Erro desconhecido')
      .slice(0, 500),
    data: responseData
  };
}

const pixAttempts = new Map();

function limitPixRequests(req, res, next) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const recent = (pixAttempts.get(key) || [])
    .filter(timestamp => now - timestamp < windowMs);

  if (recent.length >= 5) {
    return res.status(429).json({
      success: false,
      code: 'RATE_LIMITED',
      message: 'Muitas tentativas de geração de PIX. Aguarde alguns minutos e tente novamente.'
    });
  }

  recent.push(now);
  pixAttempts.set(key, recent);
  return next();
}

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const users = {};
const chatHistory = {};

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'compra-checkout',
    blackpaymentsConfigured: Boolean(
      BLACKPAYMENTS_PUBLIC_KEY && BLACKPAYMENTS_SECRET_KEY
    ),
    blackpaymentsUrl: BLACKPAYMENTS_TRANSACTIONS_URL
  });
});

// ── ENDPOINT DE POSTBACK DO BLACKPAYMENTS ──
// Configure BLACKPAYMENTS_POSTBACK_URL com a URL pública deste endpoint.
app.post('/api/blackpayments/postback', (req, res) => {
  const body = req.body || {};
  const transaction = body.data || body;
  const transactionId = transaction && (transaction.id || transaction.transactionId);
  const status = transaction && transaction.status;

  console.log('[BlackPayments postback]', {
    transactionId: transactionId || null,
    status: status || null
  });

  io.to('admins').emit('blackpayments_status', {
    transactionId: transactionId ? String(transactionId) : null,
    status: status ? String(status) : null,
    payload: body
  });

  return res.sendStatus(200);
});

// ── ENDPOINT DE UPLOAD DE COMPROVANTES ──
app.post('/api/upload-receipt', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Nenhum arquivo recebido.'
      });
    }

    const rawUserId = req.body.userId || 'anon';
    const userId = normalizeUserId(rawUserId);
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
      serverFilename: filename
    };

    console.log(`Comprovante recebido de ${userId}: ${originalName} (${size} bytes)`);

    return res.json({
      success: true,
      attachment
    });
  } catch (err) {
    console.error('Erro no upload:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Erro ao processar o arquivo.'
    });
  }
});

app.post('/api/chat', async (req, res) => {
  const body = req.body || {};
  const message = String(body.message || '');
  const context = body.context;
  const normalizedId = normalizeUserId(body.userId);
  const url = body.url;

  console.log(`Mensagem recebida de ${normalizedId}: ${message} (URL: ${url || ''})`);

  const userMessage = {
    userId: normalizedId,
    sender: 'Usuário',
    text: message,
    timestamp: new Date().toISOString(),
    url
  };

  if (!chatHistory[normalizedId]) chatHistory[normalizedId] = [];
  chatHistory[normalizedId].push(userMessage);
  io.to('admins').emit('new_message_for_admin', userMessage);

  if (!openai) {
    return res.status(503).json({
      reply: 'O atendimento por IA está temporariamente indisponível.',
      code: 'OPENAI_NOT_CONFIGURED'
    });
  }

  try {
    const messagesForOpenAI = [];
    if (context) messagesForOpenAI.push({ role: 'system', content: String(context) });
    messagesForOpenAI.push({ role: 'user', content: message });

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
      messages: messagesForOpenAI,
      max_tokens: 150,
      temperature: 0.7
    });

    const agentReply = completion.choices[0].message.content;
    const agentMessage = {
      userId: normalizedId,
      sender: 'Mateus',
      text: agentReply,
      timestamp: new Date().toISOString()
    };

    if (!chatHistory[normalizedId]) chatHistory[normalizedId] = [];
    chatHistory[normalizedId].push(agentMessage);
    io.to('admins').emit('new_message_for_admin', agentMessage);
    return res.json({ reply: agentReply });
  } catch (error) {
    console.error(
      'Erro ao chamar a API do OpenAI:',
      error.response ? error.response.data : error.message
    );
    return res.status(500).json({
      error: 'Erro ao processar sua solicitação com a IA.'
    });
  }
});

app.post('/api/pix', limitPixRequests, async (req, res) => {
  const requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);

  try {
    const body = req.body || {};
    let payerName = String(body.payer_name || '')
      .trim()
      .replace(/\s+/g, ' ');
    let payerCpf = onlyDigits(body.payer_cpf);
    const amount = normalizeAmount(body.amount);

    if (payerName.length < 3 || payerName.length > 120) {
      payerName = 'Cliente Online';
    }

    if (!isValidCpf(payerCpf)) {
      console.warn(`[${requestId}] CPF inválido. Usando CPF fallback.`);
      payerCpf = FALLBACK_CPF;
    }

    if (!amount) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_AMOUNT',
        message: 'Valor do pagamento inválido. Envie o valor em centavos.'
      });
    }

    const authorization = getBlackPaymentsAuthorization();
    if (!authorization) {
      console.error(`[${requestId}] Chaves do BlackPayments ausentes.`);
      return res.status(503).json({
        success: false,
        code: 'PAYMENT_NOT_CONFIGURED',
        message: 'Pagamento temporariamente indisponível.'
      });
    }

    if (REQUIRE_POSTBACK && !BLACKPAYMENTS_POSTBACK_URL) {
      console.error(`[${requestId}] BLACKPAYMENTS_POSTBACK_URL ausente.`);
      return res.status(503).json({
        success: false,
        code: 'POSTBACK_NOT_CONFIGURED',
        message: 'O pagamento está temporariamente indisponível.'
      });
    }

    let items;
    let shippingAddress;

    try {
      items = normalizeItems(body.items, amount);
      shippingAddress = parseShippingAddress(
        body.shipping && body.shipping.address,
        body.shipping && body.shipping.zipCode
      );
    } catch (validationError) {
      if (validationError.message === 'ITEM_INVALID') {
        return res.status(400).json({
          success: false,
          code: 'INVALID_ITEMS',
          message: 'Dados dos produtos inválidos.'
        });
      }

      console.warn(`[${requestId}] Endereço inválido. Usando endereço padrão.`);
      shippingAddress = FALLBACK_SHIPPING;
    }

    const customerEmail = normalizeEmail(body.payer_email, payerCpf);
    const externalRef = `compra-${requestId}`;

    const payload = {
      amount,
      paymentMethod: 'pix',
      pix: {
        expiresInDays: PIX_EXPIRES_IN_DAYS
      },
      items: items.map(item => ({
        title: item.title,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        tangible: item.tangible,
        ...(item.externalRef ? { externalRef: item.externalRef } : {})
      })),
      customer: {
        name: payerName,
        email: customerEmail,
        phone: DEFAULT_CUSTOMER_PHONE,
        document: {
          type: 'cpf',
          number: payerCpf
        }
      },
      shipping: {
        fee: 0,
        address: {
          street: shippingAddress.street,
          streetNumber: shippingAddress.number,
          ...(shippingAddress.complement
            ? { complement: shippingAddress.complement }
            : {}),
          zipCode: shippingAddress.zipCode,
          neighborhood: shippingAddress.neighborhood,
          city: shippingAddress.city,
          state: shippingAddress.state,
          country: 'BR'
        }
      },
      ...(BLACKPAYMENTS_POSTBACK_URL
        ? { postbackUrl: BLACKPAYMENTS_POSTBACK_URL }
        : {}),
      traceable: false,
      metadata: JSON.stringify({
        source: 'compra-checkout',
        requestId
      }),
      externalRef,
      ...(req.ip ? { ip: req.ip } : {})
    };

    console.log(`[${requestId}] Enviando PIX ao BlackPayments`, {
      url: BLACKPAYMENTS_TRANSACTIONS_URL,
      amount,
      externalRef,
      itemCount: payload.items.length,
      hasPostbackUrl: Boolean(BLACKPAYMENTS_POSTBACK_URL)
    });

    const gatewayResponse = await axios.post(
      BLACKPAYMENTS_TRANSACTIONS_URL,
      payload,
      {
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        timeout: 20000,
        validateStatus: status => status >= 200 && status < 300
      }
    );

    const gatewayBody = gatewayResponse.data || {};
    const transaction = gatewayBody && gatewayBody.data &&
      typeof gatewayBody.data === 'object'
      ? gatewayBody.data
      : gatewayBody;
    const { pixData, pixCode } = extractPixCode(gatewayBody, transaction);

    if (!pixCode) {
      console.error(`[${requestId}] Gateway sem código PIX copia-e-cola.`, {
        status: gatewayResponse.status,
        transactionId: transaction && (
          transaction.id ||
          transaction.objectId ||
          gatewayBody.objectId
        ),
        pixFields: Object.keys(pixData || {}),
        responseFields: Object.keys(gatewayBody || {})
      });

      return res.status(502).json({
        success: false,
        code: 'INVALID_GATEWAY_RESPONSE',
        message: 'O provedor não retornou um código PIX válido.'
      });
    }

    const transactionId = transaction && (
      transaction.id ||
      transaction.objectId ||
      gatewayBody.objectId ||
      externalRef
    );

    return res.json({
      success: true,
      transactionId: String(transactionId),
      pixCode,
      expiresAt: pixData.expirationDate || null
    });
  } catch (error) {
    const gatewayError = extractGatewayError(error);

    console.error(`[${requestId}] Erro ao gerar PIX no BlackPayments`, {
      url: BLACKPAYMENTS_TRANSACTIONS_URL,
      status: gatewayError.status,
      code: gatewayError.code,
      message: gatewayError.message,
      response: gatewayError.data
    });

    return res.status(502).json({
      success: false,
      code: 'PIX_GATEWAY_ERROR',
      message: 'Não foi possível gerar o PIX agora. Tente novamente em instantes.'
    });
  }
});

io.on('connection', socket => {
  console.log(`Usuário conectado: ${socket.id}`);

  socket.on('join', data => {
    const joinData = data || {};
    const normalizedId = normalizeUserId(joinData.userId);
    const isAdmin = Boolean(joinData.isAdmin);

    socket.userId = normalizedId;

    if (isAdmin) {
      socket.join('admins');
      const normalizedHistory = Object.entries(chatHistory).flatMap(
        ([uid, messages]) => {
          const normalizedHistoryId = normalizeUserId(uid);
          return messages.map(message => ({
            ...message,
            userId: normalizedHistoryId
          }));
        }
      );
      socket.emit('chat_history', normalizedHistory);
    } else {
      socket.join(normalizedId);
    }

    users[normalizedId] = socket.id;
    console.log(`${isAdmin ? 'Admin' : 'Usuário'} ${normalizedId} entrou.`);
  });

  socket.on('send_message', data => {
    const messageData = data || {};
    const normalizedId = normalizeUserId(messageData.userId);
    const text = String(messageData.text || '');
    const sender = String(messageData.sender || 'Usuário');
    const message = {
      userId: normalizedId,
      text,
      sender,
      timestamp: new Date().toISOString()
    };

    if (messageData.attachment) {
      message.attachment = messageData.attachment;
    }

    if (!chatHistory[normalizedId]) chatHistory[normalizedId] = [];
    chatHistory[normalizedId].push(message);

    console.log(
      `Mensagem de ${sender} (${normalizedId}): ${text}` +
      `${messageData.attachment ? ' (com anexo)' : ''}`
    );

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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Erros de API desconhecida devem continuar sendo JSON, e não index.html.
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    code: 'API_ROUTE_NOT_FOUND',
    message: 'Rota de API não encontrada.'
  });
});

// Catch-all para servir index.html para qualquer outra rota não definida.
app.get('/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Servidor unificado rodando na porta ${PORT}`);
  console.log(`Endpoint PIX: ${BLACKPAYMENTS_TRANSACTIONS_URL}`);

  if (!BLACKPAYMENTS_PUBLIC_KEY || !BLACKPAYMENTS_SECRET_KEY) {
    console.warn('BLACKPAYMENTS_PUBLIC_KEY/BLACKPAYMENTS_SECRET_KEY não configuradas.');
  }

  if (!BLACKPAYMENTS_POSTBACK_URL) {
    console.warn(
      'BLACKPAYMENTS_POSTBACK_URL não configurada. ' +
      'Defina PUBLIC_BASE_URL ou BLACKPAYMENTS_REQUIRE_POSTBACK=false.'
    );
  }
});
