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

dotenv.config();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = path.join(__dirname, 'messages.json');
const BLACKPAYMENTS_API_URL = process.env.BLACKPAYMENTS_API_URL || 'https://api.blackpayments.pro/v1';
const BLACKPAYMENTS_PUBLIC_KEY = String(process.env.BLACKPAYMENTS_PUBLIC_KEY || '').trim();
const BLACKPAYMENTS_SECRET_KEY = String(process.env.BLACKPAYMENTS_SECRET_KEY || '').trim();
const DEFAULT_CUSTOMER_EMAIL = process.env.PIX_CUSTOMER_EMAIL || 'email001989887@gmail.com';
const DEFAULT_CUSTOMER_PHONE = onlyDigits(process.env.PIX_CUSTOMER_PHONE || '11987289871');
const PIX_EXPIRES_IN_DAYS = Math.max(1, Number.parseInt(process.env.PIX_EXPIRES_IN_DAYS || '1', 10));
const PIX_POSTBACK_URL = process.env.PIX_POSTBACK_URL || '';

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

let messages = [];
if (fs.existsSync(DATA_FILE)) {
  try {
    messages = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.log(`Carregadas ${messages.length} mensagens do arquivo.`);
  } catch (error) {
    console.error('Erro ao carregar mensagens:', error.message);
    messages = [];
  }
}

function saveMessages() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(messages, null, 2));
  } catch (error) {
    console.error('Erro ao salvar mensagens:', error.message);
  }
}

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

function getBasicAuthorizationHeader() {
  if (!BLACKPAYMENTS_PUBLIC_KEY || !BLACKPAYMENTS_SECRET_KEY) return '';
  const credentials = `${BLACKPAYMENTS_PUBLIC_KEY}:${BLACKPAYMENTS_SECRET_KEY}`;
  return `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
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
      externalRef: String(item.externalRef || `item-${index + 1}`).slice(0, 80),
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
    streetNumber: streetNumber.slice(0, 20),
    neighborhood: neighborhood.slice(0, 80),
    city: city.slice(0, 80),
    state,
    zipCode,
    country: 'BR',
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
  res.json({ ok: true, service: 'diskgas-checkout' });
});

app.post('/api/chat', async (req, res) => {
  const { message, context } = req.body;

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

    return res.json({ reply: completion.choices[0].message.content });
  } catch (error) {
    console.error('Erro ao chamar a API do OpenAI:', error.response ? error.response.data : error.message);
    return res.status(500).json({ error: 'Erro ao processar sua solicitação com a IA.' });
  }
});

app.post('/api/pix', limitPixRequests, async (req, res) => {
  const requestId = crypto.randomUUID();

  try {
    const payerName = String(req.body.payer_name || '').trim().replace(/\s+/g, ' ');
    const payerCpf = onlyDigits(req.body.payer_cpf);
    const amount = normalizeAmount(req.body.amount);

    if (payerName.length < 3 || payerName.length > 120) {
      return res.status(400).json({ success: false, code: 'INVALID_NAME', message: 'Nome do pagador inválido.' });
    }
    if (!isValidCpf(payerCpf)) {
      return res.status(400).json({ success: false, code: 'INVALID_CPF', message: 'CPF do pagador inválido.' });
    }
    if (!amount) {
      return res.status(400).json({ success: false, code: 'INVALID_AMOUNT', message: 'Valor do pagamento inválido.' });
    }

    const authorization = getBasicAuthorizationHeader();
    if (!authorization) {
      console.error(`[${requestId}] Public Key ou Secret Key da BlackPayments ausente.`);
      return res.status(503).json({ success: false, code: 'PAYMENT_NOT_CONFIGURED', message: 'Pagamento temporariamente indisponível.' });
    }

    let items;
    let shippingAddress;
    try {
      items = normalizeItems(req.body.items, amount);
      shippingAddress = parseShippingAddress(req.body.shipping && req.body.shipping.address, req.body.shipping && req.body.shipping.zipCode);
    } catch (validationError) {
      const isItemError = validationError.message === 'ITEM_INVALID';
      return res.status(400).json({
        success: false,
        code: isItemError ? 'INVALID_ITEMS' : 'INVALID_SHIPPING',
        message: isItemError ? 'Dados dos produtos inválidos.' : 'Endereço de entrega incompleto ou inválido.',
      });
    }

    const externalRef = `diskgas-${requestId}`;
    const payload = {
      amount,
      paymentMethod: 'pix',
      pix: { expiresInDays: PIX_EXPIRES_IN_DAYS },
      items,
      shipping: {
        fee: 0,
        address: shippingAddress,
      },
      customer: {
        name: payerName,
        email: DEFAULT_CUSTOMER_EMAIL,
        phone: DEFAULT_CUSTOMER_PHONE,
        document: {
          number: payerCpf,
          type: 'cpf',
        },
      },
      externalRef,
      metadata: JSON.stringify({ source: 'diskgas-checkout', requestId }),
      ...(PIX_POSTBACK_URL ? { postbackUrl: PIX_POSTBACK_URL } : {}),
    };

    const gatewayResponse = await axios.post(`${BLACKPAYMENTS_API_URL}/transactions`, payload, {
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 20000,
    });

    const transaction = gatewayResponse.data && gatewayResponse.data.data
      ? gatewayResponse.data.data
      : gatewayResponse.data;
    const pixCode = transaction && transaction.pix && transaction.pix.qrcode;

    if (!pixCode || typeof pixCode !== 'string') {
      console.error(`[${requestId}] Resposta sem pix.qrcode.`, {
        status: gatewayResponse.status,
        transactionId: transaction && transaction.id,
      });
      return res.status(502).json({
        success: false,
        code: 'INVALID_GATEWAY_RESPONSE',
        message: 'O provedor não retornou um código PIX válido.',
      });
    }

    return res.json({
      success: true,
      transactionId: String(transaction.id || externalRef),
      pixCode,
      expiresAt: transaction.pix.expirationDate || null,
    });
  } catch (error) {
    const gatewayStatus = error.response && error.response.status;
    const gatewayMessage = error.response && error.response.data && error.response.data.message
      ? String(error.response.data.message).slice(0, 300)
      : error.message;

    console.error(`[${requestId}] Erro ao gerar PIX na BlackPayments (${gatewayStatus || 'sem status'}): ${gatewayMessage}`);

    return res.status(502).json({
      success: false,
      code: 'PIX_GATEWAY_ERROR',
      message: 'Não foi possível gerar o PIX agora. Tente novamente em instantes.',
    });
  }
});

const users = {};
io.on('connection', socket => {
  console.log(`Usuário conectado: ${socket.id}`);

  socket.on('join', ({ userId, isAdmin }) => {
    users[userId] = socket.id;
    socket.join(userId);
    console.log(`${isAdmin ? 'Admin' : 'Usuário'} ${userId} entrou.`);

    if (isAdmin) {
      socket.join('admins');
      socket.emit('chat_history', messages);
    }
  });

  socket.on('send_message', data => {
    const { userId, text, sender } = data;
    const message = { userId, text, sender, timestamp: new Date().toISOString() };
    messages.push(message);
    saveMessages();

    console.log(`Mensagem de ${sender} (${userId}): ${text}`);
    socket.to(userId).emit('receive_message', message);
    socket.to('admins').emit('new_message_for_admin', message);
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Servidor unificado rodando na porta ${PORT}`);
});
