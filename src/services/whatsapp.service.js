const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const logger = require('../utils/logger');
const campaignService = require('./campaign.service');
const rateLimitService = require('./ratelimit.service');
const conversationService = require('./conversation.service');
const messageService = require('./message.service');

class WhatsAppService {
    constructor() {
        this.client = null;
        this.qrCodeData = null;
        this.isReady = false;
        this.isInitializing = false;
        this.currentRole = null;
        this.currentPermissions = [];
        this.botPhoneNumber = null;
        this.initializationPromise = null; 
    }

    /**
     * Inicializa el cliente de WhatsApp (con protección contra llamadas múltiples)
     * @param {string} role - Rol del usuario
     * @param {Array} permissions - Permisos del usuario
     * @returns {Promise<void>}
     */
    async initialize(role = 'user', permissions = []) {
        // ✅ PROTECCIÓN: Si ya se está inicializando, retornar la promesa existente
        if (this.initializationPromise) {
            logger.warn('[WHATSAPP] Ya hay una inicialización en curso, esperando...');
            return this.initializationPromise;
        }

        // ✅ PROTECCIÓN: Si ya está inicializado, no hacer nada
        if (this.client && this.isReady) {
            logger.warn('[WHATSAPP] El cliente ya está inicializado y listo');
            return Promise.resolve();
        }

        // Crear una promesa de inicialización única
        this.initializationPromise = this._doInitialize(role, permissions);
        
        try {
            await this.initializationPromise;
        } finally {
            this.initializationPromise = null;
        }
    }

    /**
     * Método interno de inicialización
     * @private
     */
    async _doInitialize(role, permissions) {
        try {
            this.isInitializing = true;
            this.currentRole = role;
            this.currentPermissions = permissions;
            this.qrCodeData = null;

            logger.info(`[WHATSAPP] Inicializando cliente con rol: ${role}`);

            // Crear cliente con LocalAuth
            this.client = new Client({
                authStrategy: new LocalAuth({
                    dataPath: './.wwebjs_auth'
                }),
                puppeteer: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--disable-gpu',
                        '--disable-software-rasterizer',
                        '--disable-extensions'
                    ],
                    timeout: 90000
                },
                webVersionCache: {
                    type: 'remote',
                    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
                },
                qrMaxRetries: 5
            });

            this.setupEventHandlers();

            // Inicializar cliente
            await this.client.initialize();

            logger.info('[WHATSAPP] Cliente inicializado correctamente');

        } catch (error) {
            this.isInitializing = false;
            logger.error('[WHATSAPP] Error inicializando cliente:', error);
            throw error;
        }
    }

    /**
     * Configura los event handlers del cliente (SIN DUPLICADOS)
     */
    setupEventHandlers() {
        // ✅ Remover todos los listeners anteriores si existen
        this.client.removeAllListeners();

        // Evento: QR Code generado
        this.client.once('qr', async (qr) => { // ← CAMBIO: once en vez de on
            try {
                logger.info('[WHATSAPP] QR Code generado');
                this.qrCodeData = await qrcode.toDataURL(qr);
                logger.info('[WHATSAPP] QR Code convertido a base64, listo para mostrar');
            } catch (error) {
                logger.error('[WHATSAPP] Error generando QR Code:', error);
            }
        });

        // Evento: Cliente listo (SOLO UNA VEZ)
        this.client.once('ready', async () => { // ← CAMBIO: once en vez de on
            if (this.isReady) {
                logger.warn('[WHATSAPP] Evento ready ya procesado, ignorando duplicado');
                return;
            }

            this.isReady = true;
            this.isInitializing = false;
            this.qrCodeData = null;
            
            const info = this.client.info;
            this.botPhoneNumber = info.wid.user;
            
            logger.info(`[WHATSAPP] ✅ Cliente conectado exitosamente`);
            logger.info(`[WHATSAPP] Número: ${this.botPhoneNumber}`);
            logger.info(`[WHATSAPP] Nombre: ${info.pushname}`);
        });

        // Evento: Autenticación exitosa
        this.client.on('authenticated', () => {
            logger.info('[WHATSAPP] Autenticación exitosa');
        });

        // Evento: Fallo de autenticación
        this.client.on('auth_failure', (msg) => {
            this.isReady = false;
            this.isInitializing = false;
            logger.error('[WHATSAPP] ❌ Fallo de autenticación:', msg);
        });

        // Evento: Cliente desconectado
        this.client.on('disconnected', async (reason) => {
            this.isReady = false;
            this.qrCodeData = null;
            this.botPhoneNumber = null;
            
            logger.warn(`[WHATSAPP] Cliente desconectado: ${reason}`);
            
            // NO reconectar automáticamente en LOGOUT
            if (reason === 'LOGOUT') {
                logger.info('[WHATSAPP] Logout detectado, no se intentará reconectar automáticamente');
                return;
            }
        });

        // Evento: Mensaje recibido
        this.client.on('message', async (message) => {
            await this.handleIncomingMessage(message);
        });

        // Evento: Error
        this.client.on('error', (error) => {
            logger.error('[WHATSAPP] Error en el cliente:', error);
        });

        // Evento: Cargando
        this.client.on('loading_screen', (percent, message) => {
            logger.info(`[WHATSAPP] Cargando: ${percent}% - ${message}`);
        });
    }

    /**
     * Maneja mensajes entrantes
     */
    async handleIncomingMessage(message) {
        try {
            if (message.fromMe) return;
            if (message.from.includes('@g.us')) {
                logger.debug('[WHATSAPP] Mensaje de grupo ignorado');
                return;
            }

            const userPhone = message.from;
            const messageText = message.body;

            if (!messageText || messageText.trim().length === 0) return;

            const contact = await message.getContact();
            const userName = contact.pushname || contact.name || 'Usuario';

            logger.info(`[WHATSAPP] 📨 Mensaje recibido de ${userPhone} (${userName}): "${messageText}"`);

            const activeConversation = await conversationService.getActiveConversation(userPhone);
            if (activeConversation) {
                logger.info(`[WHATSAPP] Usuario ${userPhone} tiene conversación activa (ID: ${activeConversation.id}), ignorando mensaje`);
                return;
            }

            const rateLimitCheck = await rateLimitService.checkRateLimit(userPhone);
            if (!rateLimitCheck.allowed) {
                logger.warn(`[WHATSAPP] Rate limit excedido para ${userPhone}: ${rateLimitCheck.reason}`);
                return;
            }

            const campaignMatch = await campaignService.detectCampaign(messageText);
            if (!campaignMatch) {
                logger.info(`[WHATSAPP] No se detectó ninguna campaña para el mensaje: "${messageText}"`);
                return;
            }

            logger.info(`[WHATSAPP] 🎯 Campaña detectada: "${campaignMatch.campaignName}" (ID: ${campaignMatch.campaignId})`);

            await rateLimitService.updateRateLimit(userPhone);

            const conversationId = await conversationService.createConversation({
                userPhone,
                userName,
                campaignId: campaignMatch.campaignId,
                triggerMessage: messageText,
                matchedKeyword: campaignMatch.matchedKeyword,
                matchType: campaignMatch.matchType,
                corse: this.botPhoneNumber
            });

            logger.info(`[WHATSAPP] 💬 Conversación creada: ID ${conversationId} - Bot: ${this.botPhoneNumber}`);

            const messages = await messageService.getCampaignMessages(campaignMatch.campaignId);
            
            if (messages.length === 0) {
                logger.warn(`[WHATSAPP] La campaña ${campaignMatch.campaignId} no tiene mensajes configurados`);
                await conversationService.failConversation(conversationId, 'Sin mensajes configurados');
                return;
            }

            logger.info(`[WHATSAPP] 📤 Iniciando envío de ${messages.length} mensajes a ${userPhone}`);

            const variables = { nombre: userName, telefono: userPhone };
            const result = await messageService.sendSequentialMessages(
                this.client,
                userPhone,
                conversationId,
                messages,
                variables
            );

            if (result.sent === messages.length) {
                await conversationService.completeConversation(conversationId);
                logger.info(`[WHATSAPP] ✅ Conversación ${conversationId} completada: ${result.sent}/${result.total}`);
            } else if (result.failed === messages.length) {
                await conversationService.failConversation(conversationId, 'Todos los mensajes fallaron');
                logger.error(`[WHATSAPP] ❌ Conversación ${conversationId} fallida: ${result.failed}/${result.total}`);
            } else {
                await conversationService.completeConversation(conversationId);
                logger.warn(`[WHATSAPP] ⚠️ Conversación ${conversationId} completada con errores: ${result.sent}/${result.total}`);
            }

        } catch (error) {
            logger.error('[WHATSAPP] Error procesando mensaje:', error);
        }
    }

    getStatus() {
        return {
            isReady: this.isReady,
            isInitializing: this.isInitializing,
            hasQR: this.qrCodeData !== null,
            role: this.currentRole,
            botNumber: this.botPhoneNumber
        };
    }

    getQRCode() {
        return this.qrCodeData;
    }

    getBotPhoneNumber() {
        return this.botPhoneNumber;
    }

    async destroy() {
        try {
            if (this.client) {
                logger.info('[WHATSAPP] Destruyendo cliente...');
                this.client.removeAllListeners(); // ← NUEVO: Limpiar listeners
                await this.client.destroy();
                this.client = null;
                this.isReady = false;
                this.isInitializing = false;
                this.qrCodeData = null;
                this.botPhoneNumber = null;
                this.initializationPromise = null;
                logger.info('[WHATSAPP] Cliente destruido exitosamente');
            }
        } catch (error) {
            logger.error('[WHATSAPP] Error destruyendo cliente:', error);
            throw error;
        }
    }

    isClientReady() {
        return this.isReady && this.client !== null;
    }
}

module.exports = new WhatsAppService();