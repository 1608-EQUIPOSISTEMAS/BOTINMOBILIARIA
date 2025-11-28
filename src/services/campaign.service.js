const db = require('../config/database2');
const logger = require('../utils/logger');
const { matchKeywords } = require('../utils/keyword-matcher');

/**
 * Detecta qué campaña se activa según el mensaje del usuario
 * @param {string} messageText - Texto del mensaje recibido
 * @returns {Promise<object|null>} - Datos de la campaña detectada o null
 */
async function detectCampaign(messageText) {
    try {
        if (!messageText || messageText.trim().length === 0) {
            return null;
        }
        
        // Obtener todas las campañas activas ordenadas por prioridad
        const [campaigns] = await db.query(
            `SELECT 
                id,
                name,
                trigger_keywords,
                priority
            FROM campaigns
            WHERE is_active = TRUE
                AND deleted_at IS NULL
            ORDER BY priority DESC`,
            []
        );
        
        if (campaigns.length === 0) {
            logger.info('[CAMPAIGN] No hay campañas activas');
            return null;
        }
        
        logger.info(`[CAMPAIGN] Evaluando ${campaigns.length} campañas activas`);
        
        // Iterar sobre campañas por prioridad (mayor a menor)
        for (const campaign of campaigns) {
            let triggerKeywords;
            
            // Parsear el JSON de trigger_keywords
            try {
                triggerKeywords = typeof campaign.trigger_keywords === 'string' 
                    ? JSON.parse(campaign.trigger_keywords)
                    : campaign.trigger_keywords;
            } catch (error) {
                logger.error(`[CAMPAIGN] Error parseando keywords de campaña ${campaign.id}:`, error);
                continue;
            }
            
            // Intentar hacer match con esta campaña
            const match = matchKeywords(messageText, triggerKeywords);
            
            if (match) {
                logger.info(`[CAMPAIGN] ✅ Match encontrado: "${campaign.name}" (ID: ${campaign.id}) - Keyword: "${match.matched}" - Tipo: ${match.type}`);
                
                return {
                    campaignId: campaign.id,
                    campaignName: campaign.name,
                    matchedKeyword: match.matched,
                    matchType: match.type,
                    priority: campaign.priority
                };
            }
        }
        
        logger.info('[CAMPAIGN] No se encontró ninguna campaña que coincida');
        return null;
        
    } catch (error) {
        logger.error('[CAMPAIGN] Error detectando campaña:', error);
        throw error;
    }
}

/**
 * Obtiene los detalles completos de una campaña
 * @param {number} campaignId - ID de la campaña
 * @returns {Promise<object|null>}
 */
async function getCampaignById(campaignId) {
    try {
        const [campaigns] = await db.query(
            `SELECT 
                id,
                name,
                description,
                trigger_keywords,
                is_active,
                priority,
                created_at,
                updated_at
            FROM campaigns
            WHERE id = ?
                AND deleted_at IS NULL`,
            [campaignId]
        );
        
        if (campaigns.length === 0) {
            return null;
        }
        
        const campaign = campaigns[0];
        
        // Parsear trigger_keywords si es string
        if (typeof campaign.trigger_keywords === 'string') {
            campaign.trigger_keywords = JSON.parse(campaign.trigger_keywords);
        }
        
        return campaign;
        
    } catch (error) {
        logger.error(`[CAMPAIGN] Error obteniendo campaña ${campaignId}:`, error);
        throw error;
    }
}

/**
 * Obtiene estadísticas de una campaña
 * @param {number} campaignId - ID de la campaña
 * @returns {Promise<object>}
 */
async function getCampaignStats(campaignId) {
    try {
        const [stats] = await db.query(
            `SELECT 
                COUNT(*) as total_conversations,
                SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed,
                SUM(CASE WHEN status = 'IN_PROGRESS' THEN 1 ELSE 0 END) as in_progress,
                COUNT(DISTINCT matched_keyword) as unique_keywords
            FROM bot_conversations
            WHERE campaign_id = ?`,
            [campaignId]
        );
        
        return stats[0] || {
            total_conversations: 0,
            completed: 0,
            failed: 0,
            in_progress: 0,
            unique_keywords: 0
        };
        
    } catch (error) {
        logger.error(`[CAMPAIGN] Error obteniendo estadísticas de campaña ${campaignId}:`, error);
        throw error;
    }
}

/**
 * Lista todas las campañas activas
 * @returns {Promise<Array>}
 */
async function getActiveCampaigns() {
    try {
        const [campaigns] = await db.query(
            `SELECT 
                id,
                name,
                description,
                priority,
                is_active,
                created_at
            FROM campaigns
            WHERE is_active = TRUE
                AND deleted_at IS NULL
            ORDER BY priority DESC, name ASC`,
            []
        );
        
        return campaigns;
        
    } catch (error) {
        logger.error('[CAMPAIGN] Error listando campañas activas:', error);
        throw error;
    }
}

module.exports = {
    detectCampaign,
    getCampaignById,
    getCampaignStats,
    getActiveCampaigns
};