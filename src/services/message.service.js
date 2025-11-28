const db = require('../config/database2');
const config = require('../config/config2');
const logger = require('../utils/logger');
const { sleep, replaceVariables } = require('../utils/helpers');
const axios = require('axios');
const { MessageMedia } = require('whatsapp-web.js');

/**
 * Obtiene todos los mensajes de una campaña ordenados
 * @param {number} campaignId - ID de la campaña
 * @returns {Promise<Array>}
 */
async function getCampaignMessages(campaignId) {
    try {
        const [messages] = await db.query(
            `SELECT 
                m.id,
                m.campaign_id,
                m.message_type_id,
                mt.type_code,
                m.content,
                m.sort_order,
                m.delay_seconds,
                m.is_active
            FROM messages m
            INNER JOIN message_types mt ON m.message_type_id = mt.id
            WHERE m.campaign_id = ?
                AND m.is_active = TRUE
                AND m.deleted_at IS NULL
            ORDER BY m.sort_order ASC`,
            [campaignId]
        );
        
        logger.info(`[MESSAGE] Obtenidos ${messages.length} mensajes para campaña ${campaignId}`);
        
        return messages;
        
    } catch (error) {
        logger.error(`[MESSAGE] Error obteniendo mensajes de campaña ${campaignId}:`, error);
        throw error;
    }
}

/**
 * Obtiene los archivos multimedia de un mensaje
 * @param {number} messageId - ID del mensaje
 * @returns {Promise<Array>}
 */
async function getMessageMedia(messageId) {
    try {
        const [mediaFiles] = await db.query(
            `SELECT 
                id,
                message_id,
                media_type,
                file_path,
                file_name,
                sort_order,
                mime_type
            FROM message_media
            WHERE message_id = ?
                AND deleted_at IS NULL
            ORDER BY sort_order ASC`,
            [messageId]
        );
        
        return mediaFiles;
        
    } catch (error) {
        logger.error(`[MESSAGE] Error obteniendo media del mensaje ${messageId}:`, error);
        throw error;
    }
}

/**
 * Descarga un archivo desde el frontend y lo convierte en MessageMedia
 * @param {string} fileUrl - URL completa del archivo
 * @param {string} mimeType - Tipo MIME del archivo
 * @returns {Promise<MessageMedia>}
 */
async function downloadMediaFromUrl(fileUrl, mimeType, filename = 'file') {
    try {
        logger.info(`[MESSAGE] Descargando media desde: ${fileUrl}`);
        
        const response = await axios.get(fileUrl, {
            responseType: 'arraybuffer',
            timeout: 30000 // 30 segundos
        });
        
        // Convertir a base64
        const base64Data = Buffer.from(response.data, 'binary').toString('base64');
        
        // Crear MessageMedia con el nombre del archivo
        const media = new MessageMedia(mimeType, base64Data, filename);
        
        logger.info(`[MESSAGE] Media descargado exitosamente: ${fileUrl}`);
        
        return media;
        
    } catch (error) {
        logger.error(`[MESSAGE] Error descargando media desde ${fileUrl}:`, error.message);
        throw error;
    }
}

/**
 * Construye la URL completa del archivo desde el frontend
 * @param {string} filePath - Ruta del archivo (ej: /media/campaigns/yanachaga/foto.jpg)
 * @returns {string}
 */
function buildMediaUrl(filePath) {
    // Si ya es una URL completa, retornarla
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
        return filePath;
    }
    
    // Limpiar la ruta
    let cleanPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
    
    // Si la ruta empieza con "media/", quitarla porque en el frontend está en /post/
    if (cleanPath.startsWith('media/')) {
        cleanPath = cleanPath.replace('media/campaigns/yanachaga/', 'post/');
    }
    
    // Construir URL completa
    const fullUrl = `${config.frontendMediaUrl}/${cleanPath}`;
    
    return fullUrl;
}

/**
 * Registra un mensaje enviado en el log
 * @param {number} conversationId - ID de la conversación
 * @param {number} messageId - ID del mensaje
 * @param {string} whatsappMessageId - ID del mensaje en WhatsApp
 * @returns {Promise<void>}
 */
async function logMessageSent(conversationId, messageId, whatsappMessageId) {
    try {
        await db.query(
            `INSERT INTO bot_message_log 
            (conversation_id, message_id, sent_at, delivery_status, whatsapp_message_id)
            VALUES (?, ?, NOW(), 'SENT', ?)`,
            [conversationId, messageId, whatsappMessageId]
        );
        
        logger.debug(`[MESSAGE] Mensaje registrado: Conversación ${conversationId}, Mensaje ${messageId}`);
        
    } catch (error) {
        logger.error('[MESSAGE] Error registrando mensaje enviado:', error);
        // No lanzar error para no interrumpir el flujo
    }
}

/**
 * Registra un mensaje fallido en el log
 * @param {number} conversationId - ID de la conversación
 * @param {number} messageId - ID del mensaje
 * @param {string} errorMessage - Mensaje de error
 * @returns {Promise<void>}
 */
async function logMessageFailed(conversationId, messageId, errorMessage) {
    try {
        await db.query(
            `INSERT INTO bot_message_log 
            (conversation_id, message_id, sent_at, delivery_status, error_message, retry_count)
            VALUES (?, ?, NOW(), 'FAILED', ?, 0)`,
            [conversationId, messageId, errorMessage]
        );
        
        logger.debug(`[MESSAGE] Fallo registrado: Conversación ${conversationId}, Mensaje ${messageId}`);
        
    } catch (error) {
        logger.error('[MESSAGE] Error registrando mensaje fallido:', error);
    }
}

/**
 * Envía una secuencia completa de mensajes al usuario
 * @param {object} client - Cliente de WhatsApp
 * @param {string} userPhone - Número del usuario
 * @param {number} conversationId - ID de la conversación
 * @param {Array} messages - Array de mensajes a enviar
 * @param {object} variables - Variables para reemplazar en el contenido (ej: {nombre: 'Juan'})
 * @returns {Promise<object>}
 */
async function sendSequentialMessages(client, userPhone, conversationId, messages, variables = {}) {
    let successCount = 0;
    let failCount = 0;
    
    try {
        logger.info(`[MESSAGE] Iniciando envío de ${messages.length} mensajes a ${userPhone}`);
        
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            
            try {
                // Esperar el delay antes de enviar
                if (msg.delay_seconds > 0) {
                    logger.debug(`[MESSAGE] Esperando ${msg.delay_seconds}s antes del mensaje ${i + 1}`);
                    await sleep(msg.delay_seconds * 1000);
                }
                
                logger.info(`[MESSAGE] Enviando mensaje ${i + 1}/${messages.length} - Tipo: ${msg.type_code} - Conversación: ${conversationId}`);
                
                let whatsappMessageId = null;
                
                // Procesar según el tipo de mensaje
                switch (msg.type_code) {
                    case 'TEXT':
                        whatsappMessageId = await sendTextMessage(client, userPhone, msg, variables);
                        break;
                        
                    case 'IMAGE':
                        whatsappMessageId = await sendImageMessage(client, userPhone, msg, variables);
                        break;
                        
                    case 'AUDIO':
                        whatsappMessageId = await sendAudioMessage(client, userPhone, msg);
                        break;
                        
                    case 'DOCUMENT':
                        whatsappMessageId = await sendDocumentMessage(client, userPhone, msg, variables);
                        break;
                        
                    case 'GALLERY':
                        whatsappMessageId = await sendGalleryMessage(client, userPhone, msg);
                        break;
                        
                    default:
                        logger.warn(`[MESSAGE] Tipo de mensaje no soportado: ${msg.type_code}`);
                        continue;
                }
                
                // Registrar mensaje enviado
                await logMessageSent(conversationId, msg.id, whatsappMessageId);
                
                // Incrementar contador en conversación
                const conversationService = require('./conversation.service');
                await conversationService.incrementMessagesSent(conversationId);
                
                successCount++;
                logger.info(`[MESSAGE] ✅ Mensaje ${i + 1}/${messages.length} enviado exitosamente`);
                
            } catch (error) {
                logger.error(`[MESSAGE] ❌ Error enviando mensaje ${msg.id}:`, error.message);
                
                // Registrar fallo
                await logMessageFailed(conversationId, msg.id, error.message);
                failCount++;
                
                // Si es un error crítico, detener el envío
                if (error.message.includes('Connection closed') || error.message.includes('Session closed')) {
                    logger.error('[MESSAGE] Error crítico de conexión, deteniendo envío');
                    throw error;
                }
                
                // Continuar con el siguiente mensaje
                continue;
            }
        }
        
        logger.info(`[MESSAGE] Envío finalizado: ${successCount} exitosos, ${failCount} fallidos`);
        
        return {
            success: true,
            total: messages.length,
            sent: successCount,
            failed: failCount
        };
        
    } catch (error) {
        logger.error('[MESSAGE] Error crítico en sendSequentialMessages:', error);
        throw error;
    }
}

/**
 * Envía un mensaje de texto
 */
async function sendTextMessage(client, userPhone, message, variables) {
    const content = replaceVariables(message.content, variables);
    const sentMsg = await client.sendMessage(userPhone, content);
    return sentMsg.id._serialized;
}

/**
 * Envía un mensaje con imagen
 */
async function sendImageMessage(client, userPhone, message, variables) {
    const mediaFiles = await getMessageMedia(message.id);
    
    if (mediaFiles.length === 0) {
        throw new Error('No se encontró imagen para este mensaje');
    }
    
    const mediaFile = mediaFiles[0];
    const mediaUrl = buildMediaUrl(mediaFile.file_path);
    const media = await downloadMediaFromUrl(mediaUrl, mediaFile.mime_type || 'image/jpeg');
    
    const caption = message.content ? replaceVariables(message.content, variables) : '';
    const sentMsg = await client.sendMessage(userPhone, media, { caption });
    
    return sentMsg.id._serialized;
}

/**
 * Envía un mensaje de audio
 */
async function sendAudioMessage(client, userPhone, message) {
    const mediaFiles = await getMessageMedia(message.id);
    
    if (mediaFiles.length === 0) {
        throw new Error('No se encontró audio para este mensaje');
    }
    
    const mediaFile = mediaFiles[0];
    const mediaUrl = buildMediaUrl(mediaFile.file_path);
    const media = await downloadMediaFromUrl(mediaUrl, mediaFile.mime_type || 'audio/mpeg');
    
    const sentMsg = await client.sendMessage(userPhone, media, { sendAudioAsVoice: true });
    return sentMsg.id._serialized;
}

/**
 * Envía un documento/PDF
 */
async function sendDocumentMessage(client, userPhone, message, variables) {
    const mediaFiles = await getMessageMedia(message.id);
    
    if (mediaFiles.length === 0) {
        throw new Error('No se encontró documento para este mensaje');
    }
    
    const mediaFile = mediaFiles[0];
    const mediaUrl = buildMediaUrl(mediaFile.file_path);
    
    // Pasar el nombre del archivo a downloadMediaFromUrl
    const media = await downloadMediaFromUrl(
        mediaUrl, 
        mediaFile.mime_type || 'application/pdf',
        'Brochure.pdf'  // Nombre fijo
    );
    
    const caption = message.content ? replaceVariables(message.content, variables) : '';
    
    const sentMsg = await client.sendMessage(userPhone, media, { 
        sendMediaAsDocument: true,
        caption
    });
    
    logger.info(`[MESSAGE] Documento enviado: Brochure.pdf`);
    
    return sentMsg.id._serialized;
}

/**
 * Envía una galería de imágenes (múltiples imágenes)
 */
async function sendGalleryMessage(client, userPhone, message) {
    const mediaFiles = await getMessageMedia(message.id);
    
    if (mediaFiles.length === 0) {
        throw new Error('No se encontraron imágenes para la galería');
    }
    
    logger.info(`[MESSAGE] Enviando galería de ${mediaFiles.length} imágenes`);
    
    let lastMessageId = null;
    
    for (let j = 0; j < mediaFiles.length; j++) {
        const mediaFile = mediaFiles[j];
        const mediaUrl = buildMediaUrl(mediaFile.file_path);
        
        try {
            const media = await downloadMediaFromUrl(mediaUrl, mediaFile.mime_type || 'image/jpeg');
            const sentMsg = await client.sendMessage(userPhone, media);
            lastMessageId = sentMsg.id._serialized;
            
            // Delay de 0.5s entre imágenes para no saturar
            if (j < mediaFiles.length - 1) {
                await sleep(500);
            }
            
            logger.debug(`[MESSAGE] Imagen ${j + 1}/${mediaFiles.length} enviada`);
            
        } catch (error) {
            logger.error(`[MESSAGE] Error enviando imagen ${j + 1} de la galería:`, error.message);
            // Continuar con la siguiente imagen
        }
    }
    
    return lastMessageId || `GALLERY_${Date.now()}`;
}

module.exports = {
    getCampaignMessages,
    getMessageMedia,
    sendSequentialMessages,
    logMessageSent,
    logMessageFailed,
    buildMediaUrl
};