const db = require('../config/database2');
const config = require('../config/config2');
const logger = require('../utils/logger');

/**
 * Verifica si un usuario puede recibir mensajes (rate limiting)
 * @param {string} userPhone - Número de teléfono del usuario
 * @returns {Promise<{allowed: boolean, reason: string}>}
 */
async function checkRateLimit(userPhone) {
    try {
        // Verificar si está en lista de bloqueados permanentemente
        const [blockedRows] = await db.query(
            'SELECT phone_number FROM blocked_numbers WHERE phone_number = ?',
            [userPhone]
        );
        
        if (blockedRows.length > 0) {
            logger.warn(`[RATE-LIMIT] Usuario bloqueado permanentemente: ${userPhone}`);
            return {
                allowed: false,
                reason: 'BLOCKED_PERMANENT'
            };
        }
        
        // Obtener información de rate limit del usuario
        const [rateLimitRows] = await db.query(
            `SELECT 
                is_blocked,
                blocked_until,
                trigger_count_hour,
                trigger_count_day,
                last_trigger_at
            FROM user_rate_limit 
            WHERE user_phone = ?`,
            [userPhone]
        );
        
        // Si no existe registro, el usuario puede continuar
        if (rateLimitRows.length === 0) {
            logger.info(`[RATE-LIMIT] Usuario nuevo: ${userPhone} - PERMITIDO`);
            return {
                allowed: true,
                reason: 'NEW_USER'
            };
        }
        
        const rateLimitData = rateLimitRows[0];
        
        // Verificar bloqueo temporal
        if (rateLimitData.is_blocked) {
            // Si tiene blocked_until y ya pasó la fecha, desbloquear
            if (rateLimitData.blocked_until) {
                const now = new Date();
                const blockedUntil = new Date(rateLimitData.blocked_until);
                
                if (now > blockedUntil) {
                    // Desbloquear automáticamente
                    await db.query(
                        'UPDATE user_rate_limit SET is_blocked = FALSE, blocked_until = NULL WHERE user_phone = ?',
                        [userPhone]
                    );
                    logger.info(`[RATE-LIMIT] Usuario desbloqueado automáticamente: ${userPhone}`);
                    return {
                        allowed: true,
                        reason: 'UNBLOCKED'
                    };
                }
            }
            
            logger.warn(`[RATE-LIMIT] Usuario bloqueado temporalmente: ${userPhone}`);
            return {
                allowed: false,
                reason: 'BLOCKED_TEMPORARY'
            };
        }
        
        const lastTrigger = rateLimitData.last_trigger_at ? new Date(rateLimitData.last_trigger_at) : null;
        const now = new Date();
        
        // Verificar límite por hora (3 mensajes)
        if (lastTrigger) {
            const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
            
            if (lastTrigger > hourAgo && rateLimitData.trigger_count_hour >= config.rateLimits.hour) {
                logger.warn(`[RATE-LIMIT] Límite por hora excedido: ${userPhone} (${rateLimitData.trigger_count_hour}/${config.rateLimits.hour})`);
                return {
                    allowed: false,
                    reason: 'RATE_LIMIT_HOUR'
                };
            }
            
            // Verificar límite por día (8 mensajes)
            const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            
            if (lastTrigger > dayAgo && rateLimitData.trigger_count_day >= config.rateLimits.day) {
                logger.warn(`[RATE-LIMIT] Límite por día excedido: ${userPhone} (${rateLimitData.trigger_count_day}/${config.rateLimits.day})`);
                return {
                    allowed: false,
                    reason: 'RATE_LIMIT_DAY'
                };
            }
        }
        
        logger.info(`[RATE-LIMIT] Usuario permitido: ${userPhone} (hora: ${rateLimitData.trigger_count_hour}, día: ${rateLimitData.trigger_count_day})`);
        return {
            allowed: true,
            reason: 'OK'
        };
        
    } catch (error) {
        logger.error(`[RATE-LIMIT] Error verificando límites para ${userPhone}:`, error);
        // En caso de error, permitir para no bloquear el servicio
        return {
            allowed: true,
            reason: 'ERROR_CHECK'
        };
    }
}

/**
 * Actualiza los contadores de rate limit después de iniciar conversación
 * @param {string} userPhone - Número de teléfono
 * @returns {Promise<void>}
 */
async function updateRateLimit(userPhone) {
    try {
        const now = new Date();
        const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        
        // Usar INSERT ... ON DUPLICATE KEY UPDATE para manejar nuevo usuario o actualización
        await db.query(
            `INSERT INTO user_rate_limit 
            (user_phone, last_trigger_at, trigger_count_hour, trigger_count_day, trigger_count_total, is_blocked)
            VALUES (?, NOW(), 1, 1, 1, FALSE)
            ON DUPLICATE KEY UPDATE
                trigger_count_hour = IF(last_trigger_at < ?, 1, trigger_count_hour + 1),
                trigger_count_day = IF(last_trigger_at < ?, 1, trigger_count_day + 1),
                trigger_count_total = trigger_count_total + 1,
                last_trigger_at = NOW()`,
            [userPhone, hourAgo, dayAgo]
        );
        
        logger.info(`[RATE-LIMIT] Contadores actualizados para: ${userPhone}`);
        
    } catch (error) {
        logger.error(`[RATE-LIMIT] Error actualizando límites para ${userPhone}:`, error);
        throw error;
    }
}

/**
 * Bloquea manualmente a un usuario
 * @param {string} userPhone - Número de teléfono
 * @param {string} reason - Razón del bloqueo
 * @param {number} hoursBlocked - Horas de bloqueo (null = indefinido)
 * @returns {Promise<void>}
 */
async function blockUser(userPhone, reason, hoursBlocked = null) {
    try {
        const blockedUntil = hoursBlocked 
            ? new Date(Date.now() + hoursBlocked * 60 * 60 * 1000)
            : null;
        
        await db.query(
            `INSERT INTO user_rate_limit 
            (user_phone, is_blocked, blocked_reason, blocked_at, blocked_until)
            VALUES (?, TRUE, ?, NOW(), ?)
            ON DUPLICATE KEY UPDATE
                is_blocked = TRUE,
                blocked_reason = ?,
                blocked_at = NOW(),
                blocked_until = ?`,
            [userPhone, reason, blockedUntil, reason, blockedUntil]
        );
        
        logger.warn(`[RATE-LIMIT] Usuario bloqueado: ${userPhone} - Razón: ${reason}`);
        
    } catch (error) {
        logger.error(`[RATE-LIMIT] Error bloqueando usuario ${userPhone}:`, error);
        throw error;
    }
}

module.exports = {
    checkRateLimit,
    updateRateLimit,
    blockUser
};