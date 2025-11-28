// utils/keyword-matcher.js
const logger = require('./logger');

/**
 * Normaliza texto para comparación robusta
 * - Lowercase
 * - Sin acentos (á→a, é→e, í→i, ó→o, ú→u, ñ→n)
 * - Sin puntuación (¡!¿?.,;:()[]{}'"-)
 * - Sin espacios extra
 */
function normalizeText(text) {
    if (!text) return '';
    
    return text
        .toLowerCase()
        .normalize('NFD')                           // Descomponer caracteres acentuados
        .replace(/[\u0300-\u036f]/g, '')           // Eliminar marcas de acento
        .replace(/[¡!¿?.,;:()\[\]{}'"´`~\-]/g, ' ') // Reemplazar puntuación con espacio
        .replace(/\s+/g, ' ')                       // Múltiples espacios → un espacio
        .trim();
}

/**
 * Verifica si el mensaje contiene la keyword completa
 * Búsqueda flexible: busca la frase completa O todas las palabras presentes
 */
function containsKeyword(normalizedMessage, normalizedKeyword) {
    // Intento 1: Búsqueda de frase completa (ideal)
    if (normalizedMessage.includes(normalizedKeyword)) {
        return true;
    }

    // Intento 2: Todas las palabras de la keyword deben estar en el mensaje
    // Útil para: "Hola, info del proyecto yanachaga ecovillage gracias"
    const keywordWords = normalizedKeyword.split(' ').filter(w => w.length > 0);
    const messageWords = normalizedMessage.split(' ');
    
    const allWordsPresent = keywordWords.every(word => 
        messageWords.includes(word)
    );

    return allWordsPresent;
}

/**
 * Detecta si un mensaje coincide con las keywords de una campaña
 * @param {string} messageText - Texto del mensaje recibido
 * @param {object} triggerKeywords - JSON con keywords, synonyms, exact_matches, excluded_words
 * @returns {object|null} - {matched: string, type: string} o null
 */
function matchKeywords(messageText, triggerKeywords) {
    if (!messageText || !triggerKeywords) {
        return null;
    }

    // Normalizar mensaje completo
    const normalizedMessage = normalizeText(messageText);
    
    logger.debug(`[KEYWORD-MATCHER] Mensaje original: "${messageText}"`);
    logger.debug(`[KEYWORD-MATCHER] Mensaje normalizado: "${normalizedMessage}"`);

    const { exact_matches, keywords, synonyms, excluded_words } = triggerKeywords;
    
    // PASO 1: Verificar excluded_words primero (CRÍTICO)
    if (excluded_words && Array.isArray(excluded_words)) {
        for (const word of excluded_words) {
            const normalizedExcluded = normalizeText(word);
            
            if (normalizedMessage.includes(normalizedExcluded)) {
                logger.debug(`[KEYWORD-MATCHER] ❌ Palabra excluida detectada: "${word}"`);
                return null;
            }
        }
    }
    
    // PASO 2: Verificar exact_matches (máxima prioridad)
    if (exact_matches && Array.isArray(exact_matches)) {
        for (const phrase of exact_matches) {
            const normalizedPhrase = normalizeText(phrase);
            
            logger.debug(`[KEYWORD-MATCHER] Verificando exact_match: "${phrase}" → "${normalizedPhrase}"`);
            
            if (containsKeyword(normalizedMessage, normalizedPhrase)) {
                logger.info(`[KEYWORD-MATCHER] ✅ EXACT MATCH: "${phrase}"`);
                return { 
                    matched: phrase, 
                    type: 'EXACT' 
                };
            }
        }
    }
    
    // PASO 3: Verificar keywords principales
    if (keywords && Array.isArray(keywords)) {
        for (const keyword of keywords) {
            const normalizedKeyword = normalizeText(keyword);
            
            logger.debug(`[KEYWORD-MATCHER] Verificando keyword: "${keyword}" → "${normalizedKeyword}"`);
            
            if (containsKeyword(normalizedMessage, normalizedKeyword)) {
                logger.info(`[KEYWORD-MATCHER] ✅ KEYWORD MATCH: "${keyword}"`);
                return { 
                    matched: keyword, 
                    type: 'KEYWORD' 
                };
            }
        }
    }
    
    // PASO 4: Verificar synonyms (menor prioridad)
    if (synonyms && typeof synonyms === 'object') {
        for (const [mainWord, synonymList] of Object.entries(synonyms)) {
            // Verificar palabra principal
            const normalizedMain = normalizeText(mainWord);
            
            if (normalizedMessage.includes(normalizedMain)) {
                logger.info(`[KEYWORD-MATCHER] ✅ SYNONYM MATCH (palabra principal): "${mainWord}"`);
                return { 
                    matched: mainWord,
                    type: 'SYNONYM' 
                };
            }

            // Verificar cada sinónimo
            if (Array.isArray(synonymList)) {
                for (const synonym of synonymList) {
                    const normalizedSyn = normalizeText(synonym);
                    
                    if (normalizedMessage.includes(normalizedSyn)) {
                        logger.info(`[KEYWORD-MATCHER] ✅ SYNONYM MATCH: "${synonym}" → "${mainWord}"`);
                        return { 
                            matched: mainWord, // Retornar palabra principal
                            type: 'SYNONYM' 
                        };
                    }
                }
            }
        }
    }
    
    logger.debug('[KEYWORD-MATCHER] ❌ Sin coincidencias');
    return null;
}

module.exports = { 
    matchKeywords,
    normalizeText,
    containsKeyword
};